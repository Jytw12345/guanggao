/* ============================================================
 * 广告安装施工预约管理系统
 * 支持两种运行模式：
 *   - 云端模式(cloud)：配置 config.js 后，数据存 Supabase，多人实时同步
 *   - 本地模式(local)：未配置时，数据存浏览器 localStorage，单机使用
 * ============================================================ */

const STORE_KEY = "ad_install_system_v1";
const CUSTOMER_HISTORY_KEY = "ad_install_customer_history";
const DATA_VERSION = 2;
const MAX_LOGS = 1000;

function getCustomerHistory() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOMER_HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveCustomerHistory(list) {
  localStorage.setItem(CUSTOMER_HISTORY_KEY, JSON.stringify(list.slice(0, 50)));
}

function upsertCustomer(customer, phone, address) {
  if (!customer) return;
  const list = getCustomerHistory();
  const idx = list.findIndex(c => c.customer === customer);
  if (idx >= 0) {
    list[idx] = { customer, phone: phone || list[idx].phone, address: address || list[idx].address, updatedAt: Date.now() };
  } else {
    list.unshift({ customer, phone, address, updatedAt: Date.now() });
  }
  saveCustomerHistory(list);
}

function findCustomer(customer) {
  return getCustomerHistory().find(c => c.customer === customer) || null;
}

const STATUS = {
  BOOKED: "预约中",
  WORKING: "施工中",
  PAUSED: "已暂停",
  DELAYED: "已延期",
  DONE: "已完工",
  ACCEPTED: "已验收",
  REVIEWED: "已审核",
  CANCELLED: "已取消",
};

const STATUS_TRANSITIONS = {
  [STATUS.BOOKED]: [STATUS.WORKING, STATUS.CANCELLED],
  [STATUS.WORKING]: [STATUS.PAUSED, STATUS.DONE, STATUS.CANCELLED],
  [STATUS.PAUSED]: [STATUS.WORKING, STATUS.DONE, STATUS.CANCELLED],
  [STATUS.DELAYED]: [STATUS.WORKING, STATUS.DONE, STATUS.CANCELLED],
  [STATUS.DONE]: [STATUS.ACCEPTED],
  [STATUS.ACCEPTED]: [STATUS.REVIEWED],
  [STATUS.REVIEWED]: [],
  [STATUS.CANCELLED]: [],
};

function getAllowedStatuses(currentStatus) {
  return STATUS_TRANSITIONS[currentStatus] || [];
}

const TIGHT_GAP_MINUTES = 30;

/* 内存缓存：所有渲染函数都读它；shape 与本地模式一致 */
const cache = { workers: [], projects: [], stores: [], leaveRecords: [], leaveQuota: [], holidays: [], operationLogs: [], outsourcedWorkers: [], workerSchedules: [], accounts: [] };

/* 角色 */
const ROLE = { MANAGER: "manager", STORE: "store_manager", WORKER: "worker" };
const ROLE_LABEL = { manager: "总经理", store_manager: "店长", worker: "施工人员" };

/* 运行时状态 */
let MODE = "local";        // 'cloud' | 'local'
let sb = null;             // supabase client (anon key)
let sbAdmin = null;        // supabase admin client (service key, optional)
let currentUser = null;    // 云端登录用户
let currentProfile = { role: null, storeId: null }; // 当前用户角色与门店
let reloadTimer = null;    // 实时刷新去抖
let workingProjectsTimer = null; // 施工中项目定时刷新

const getWorker = (id) => cache.workers.find((w) => w.id === id);
const getProject = (id) => cache.projects.find((p) => p.id === id);
const getStore = (id) => cache.stores.find((s) => s.id === id);
const getLeaveRecord = (id) => cache.leaveRecords.find((l) => l.id === id);
const getOutsourcedWorker = (id) => cache.outsourcedWorkers.find((w) => w.id === id);
const getWorkerSchedule = (id) => cache.workerSchedules.find((s) => s.id === id);
const storeName = (id) => (getStore(id) || {}).name || "—";

/* ---------- 权限判断（前端界面控制，服务端另有 RLS 强制） ---------- */
const myRole = () => currentProfile.role;
const myStore = () => currentProfile.storeId;
const isManager = () => myRole() === ROLE.MANAGER;
const isStoreManager = () => myRole() === ROLE.STORE;
const isWorker = () => myRole() === ROLE.WORKER;

/* 权限点(capability)：总经理恒拥有全部；其余角色由总经理在「角色权限」页勾选。
 * 这些键需与 role_permissions.perms 的 jsonb 键、以及 SQL my_can(cap) 保持一致。 */
const CAP = {
  PROJECT_CREATE: "project_create",
  PROJECT_EDIT_OWN: "project_edit_own",
  PROJECT_EDIT_ALL: "project_edit_all",
  PROJECT_DELETE_OWN: "project_delete_own",
  PROJECT_DELETE_ALL: "project_delete_all",
  PROJECT_VIEW_ALL: "project_view_all",
  CONSTRUCTION_START: "construction_start",
  CONSTRUCTION_PAUSE: "construction_pause",
  CONSTRUCTION_RESUME: "construction_resume",
  CONSTRUCTION_COMPLETE: "construction_complete",
  CONSTRUCTION_LOG_WORK: "construction_log_work",
  CONSTRUCTION_LOG_OUTSOURCED: "construction_log_outsourced",
  WORKER_ASSIGN: "worker_assign",
  WORKER_UNASSIGN: "worker_unassign",
  WORKER_ADD: "worker_add",
  WORKER_EDIT: "worker_edit",
  WORKER_DELETE: "worker_delete",
  WORKER_VIEW: "worker_view",
  LEAVE_APPLY: "leave_apply",
  LEAVE_APPROVE: "leave_approve",
  LEAVE_REJECT: "leave_reject",
  LEAVE_VIEW_ALL: "leave_view_all",
  REVIEW_PROJECT: "review_project",
  UNREVIEW_PROJECT: "unreview_project",
  ACCEPT_PROJECT: "accept_project",
  VIEW_STATS_GLOBAL: "view_stats_global",
  VIEW_STATS_STORE: "view_stats_store",
  MANAGE_STORES: "manage_stores",
  MANAGE_ACCOUNTS: "manage_accounts",
  MANAGE_HOLIDAYS: "manage_holidays",
  MANAGE_OUTSOURCED: "manage_outsourced",
  DATA_EXPORT: "data_export",
  REPAIR_CREATE: "repair_create",
  REPAIR_COMPLETE: "repair_complete",
  MANAGE_WAGE_CONFIG: "manage_wage_config",
};

/* 权限项的中文说明（角色权限配置页逐行展示，顺序即展示顺序） */
const CAP_LABEL = {
  project_create: "新建预约",
  project_edit_own: "编辑自己创建的预约",
  project_edit_all: "编辑所有预约",
  project_delete_own: "删除自己创建的预约",
  project_delete_all: "删除所有预约",
  project_view_all: "查看所有门店项目",
  construction_start: "开始施工",
  construction_pause: "暂停施工",
  construction_resume: "恢复施工",
  construction_complete: "完成施工",
  construction_log_work: "填写施工工时",
  construction_log_outsourced: "填写外协工时",
  worker_assign: "分配安装人员",
  worker_unassign: "移除安装人员",
  worker_add: "添加施工人员",
  worker_edit: "编辑施工人员",
  worker_delete: "删除施工人员",
  worker_view: "查看施工人员",
  leave_apply: "申请请假",
  leave_approve: "批准请假",
  leave_reject: "拒绝请假",
  leave_view_all: "查看所有请假记录",
  review_project: "审核项目",
  unreview_project: "反审核项目",
  accept_project: "验收项目",
  view_stats_global: "查看全局工时统计",
  view_stats_store: "查看本门店统计",
  manage_stores: "管理门店",
  manage_accounts: "管理账户",
  manage_holidays: "管理节假日",
  manage_outsourced: "管理外协人员",
  data_export: "导出数据",
  repair_create: "发起维修单",
  manage_wage_config: "管理工时单价",
  repair_complete: "完成维修",
};

/* 默认权限模板（与 SQL seed 一致）；云端会用 role_permissions 表覆盖 */
const DEFAULT_ROLE_PERMS = {
  store_manager: {
    project_create: true, project_edit_own: true, project_edit_all: true,
    project_delete_own: true, project_delete_all: true, project_view_all: true,
    construction_start: false, construction_pause: false, construction_resume: false,
    construction_complete: false, construction_log_work: false, construction_log_outsourced: false,
    worker_assign: false, worker_unassign: false, worker_add: false,
    worker_edit: false, worker_delete: false, worker_view: true,
    leave_apply: true, leave_approve: true, leave_reject: true, leave_view_all: true,
    review_project: true, unreview_project: true, accept_project: false,
    view_stats_global: false, view_stats_store: true,
    manage_stores: false, manage_accounts: false, manage_holidays: false,
    manage_outsourced: true, data_export: false,
    repair_create: true, repair_complete: false,
  },
  worker: {
    project_create: true, project_edit_own: false, project_edit_all: false,
    project_delete_own: false, project_delete_all: false, project_view_all: false,
    construction_start: true, construction_pause: true, construction_resume: true,
    construction_complete: true, construction_log_work: true, construction_log_outsourced: true,
    worker_assign: true, worker_unassign: true, worker_add: false,
    worker_edit: false, worker_delete: false, worker_view: true,
    leave_apply: true, leave_approve: false, leave_reject: false, leave_view_all: false,
    review_project: false, accept_project: false,
    view_stats_global: false, view_stats_store: false,
    manage_stores: false, manage_accounts: false, manage_holidays: false,
    repair_create: false, repair_complete: true,
    manage_outsourced: false, data_export: false,
  },
};

/* 运行时角色权限缓存；云端从 role_permissions 载入，本地用默认模板 */
let rolePerms = JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMS));

/* 当前用户是否拥有某项权限 */
function can(cap) {
  if (isManager()) return true;
  const role = myRole();
  if (!role) return false;
  return !!(rolePerms[role] && rolePerms[role][cap]);
}

const perm = {
  createProject: () => can(CAP.PROJECT_CREATE),
  editProject: (p) => !isReviewed(p) && (can(CAP.PROJECT_EDIT_ALL) || (can(CAP.PROJECT_EDIT_OWN) && p && p.createdBy === currentProfile.id)) && (isManager() || !myStore() || (p && p.storeId === myStore())),
  deleteProject: (p) => !isReviewed(p) && (can(CAP.PROJECT_DELETE_ALL) || (can(CAP.PROJECT_DELETE_OWN) && p && p.createdBy === currentProfile.id)) && (isManager() || !myStore() || (p && p.storeId === myStore())),
  viewProjectAll: () => can(CAP.PROJECT_VIEW_ALL),
  startConstruction: (p) => !isReviewed(p) && can(CAP.CONSTRUCTION_START),
  pauseConstruction: (p) => !isReviewed(p) && can(CAP.CONSTRUCTION_PAUSE),
  resumeConstruction: (p) => !isReviewed(p) && can(CAP.CONSTRUCTION_RESUME),
  completeConstruction: (p) => !isReviewed(p) && can(CAP.CONSTRUCTION_COMPLETE),
  logWorkHours: (p) => !isReviewed(p) && can(CAP.CONSTRUCTION_LOG_WORK),
  logOutsourcedHours: (p) => !isReviewed(p) && can(CAP.CONSTRUCTION_LOG_OUTSOURCED),
  assignWorker: (p) => !isReviewed(p) && !isCompleted(p) && can(CAP.WORKER_ASSIGN),
  unassignWorker: (p) => !isReviewed(p) && !isCompleted(p) && can(CAP.WORKER_UNASSIGN),
  addWorker: () => can(CAP.WORKER_ADD),
  editWorker: () => can(CAP.WORKER_EDIT),
  deleteWorker: () => can(CAP.WORKER_DELETE),
  viewWorker: () => can(CAP.WORKER_VIEW),
  applyLeave: () => can(CAP.LEAVE_APPLY),
  approveLeave: () => can(CAP.LEAVE_APPROVE),
  rejectLeave: () => can(CAP.LEAVE_REJECT),
  viewAllLeaves: () => can(CAP.LEAVE_VIEW_ALL),
  reviewProject: (p) => can(CAP.REVIEW_PROJECT) && (isManager() || !myStore() || (p && p.storeId === myStore())),
  unreviewProject: (p) => can(CAP.UNREVIEW_PROJECT) && (isManager() || !myStore() || (p && p.storeId === myStore())),
  acceptProject: (p) => can(CAP.ACCEPT_PROJECT) && (isManager() || !myStore() || (p && p.storeId === myStore())),
  viewGlobalStats: () => can(CAP.VIEW_STATS_GLOBAL),
  viewStoreStats: () => can(CAP.VIEW_STATS_STORE),
  manageStores: () => can(CAP.MANAGE_STORES),
  manageAccounts: () => isManager() || can(CAP.MANAGE_ACCOUNTS),
  manageHolidays: () => can(CAP.MANAGE_HOLIDAYS),
  manageOutsourced: () => can(CAP.MANAGE_OUTSOURCED),
  exportData: () => can(CAP.DATA_EXPORT),
  createRepair: () => can(CAP.REPAIR_CREATE),
  completeRepair: () => can(CAP.REPAIR_COMPLETE),
  manageWageConfig: () => isManager() || can(CAP.MANAGE_WAGE_CONFIG),
  doConstruction: (p) => !isReviewed(p) && (can(CAP.CONSTRUCTION_START) || can(CAP.CONSTRUCTION_PAUSE) || can(CAP.CONSTRUCTION_RESUME) || can(CAP.CONSTRUCTION_COMPLETE) || can(CAP.CONSTRUCTION_LOG_WORK)),
  manageLeaves: () => can(CAP.LEAVE_APPROVE) || can(CAP.LEAVE_REJECT) || can(CAP.LEAVE_VIEW_ALL),
  viewStats: () => can(CAP.VIEW_STATS_GLOBAL) || can(CAP.VIEW_STATS_STORE),
  manageWorkers: () => can(CAP.WORKER_ADD) || can(CAP.WORKER_EDIT) || can(CAP.WORKER_DELETE),
};

function isReviewed(p) {
  return p && p.status === STATUS.REVIEWED;
}

function getProjectDisplayWorkers(p) {
  if (p.status === STATUS.BOOKED) {
    return (p.assignedWorkerIds || []).map((wid) => {
      const w = getWorker(wid);
      return w ? w.name : null;
    }).filter(Boolean);
  }
  if (p.status === STATUS.DONE || p.status === STATUS.REVIEWED || p.status === STATUS.ACCEPTED) {
    const workerNames = new Set();
    (p.workLogs || []).forEach((l) => {
      if (l.workerName) workerNames.add(l.workerName);
    });
    return Array.from(workerNames);
  }
  return [];
}

function cloudConfigured() {
  return !!(window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL && window.APP_CONFIG.SUPABASE_ANON_KEY);
}

/* ---------- 工具函数 ---------- */
function uid() {
  // 使用 crypto.randomUUID() 确保唯一性（现代浏览器均支持）
  // 添加计数器和时间戳作为双重保障，防止高频调用下的碰撞
  return Date.now().toString(36)
    + "-" + Math.random().toString(36).slice(2, 10)
    + "-" + Math.floor(Math.random() * 46656).toString(36);
}

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function safeJsonParse(str, defaultValue = null) {
  if (!str || typeof str !== "string") return defaultValue;
  try {
    return JSON.parse(str);
  } catch (e) {
    console.warn("JSON解析失败:", str.substring(0, 100), e);
    return defaultValue;
  }
}

function validatePhone(phone) {
  if (!phone) return true;
  const regex = /^1[3-9]\d{9}$/;
  return regex.test(phone.replace(/\s/g, ""));
}

function validateHours(hours) {
  const h = Number(hours);
  return !isNaN(h) && h >= 0.1 && h <= 24;
}

function validateWorkerCount(count) {
  const c = Number(count);
  return !isNaN(c) && c >= 1 && c <= 10;
}

function fmtDateTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return v;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return v;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDateShort(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return v;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return v;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function generateTimeOptions(selectedValue = "08:00") {
  const options = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 10) {
      const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      options.push(`<option value="${time}"${time === selectedValue ? " selected" : ""}>${time}</option>`);
    }
  }
  return options.join("");
}

function monthKey(v) {
  const d = new Date(v);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function derivePauseDuration(p) {
  const workSessions = p.workSessions || [];
  const originalStartedAt = p.originalStartedAt || p.startedAt;
  if (!originalStartedAt) return 0;
  
  let effectiveSessions = [...workSessions];
  if (p.status === STATUS.WORKING && p.startedAt) {
    const now = new Date();
    const currentDuration = (now - new Date(p.startedAt)) / (1000 * 60 * 60);
    effectiveSessions.push({
      startTime: p.startedAt,
      endTime: now.toISOString(),
      duration: currentDuration
    });
  }
  
  if (effectiveSessions.length === 0) return 0;
  
  const start = new Date(originalStartedAt);
  const lastSession = effectiveSessions[effectiveSessions.length - 1];
  const end = new Date(lastSession.endTime);
  
  const totalWallTime = (end - start) / (1000 * 60 * 60);
  const totalWorkTime = effectiveSessions.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  
  return Math.max(0, totalWallTime - totalWorkTime);
}

function derivePauseCount(p) {
  const workSessions = p.workSessions || [];
  let effectiveCount = workSessions.length;
  if (p.status === STATUS.WORKING && p.startedAt) {
    effectiveCount++;
  }
  return Math.max(0, effectiveCount - 1);
}

/* ---------- 预约时间段：开始时间 + 结束时间（均手动设置） ----------
 * 结束时间是现场实际占用的时段（挂钟时间），与「预计工时(人·小时)」相互独立：
 * 例如 6 人工时的活，2 人同时施工 3 小时即可完工，结束时间就是 3 小时后。 */
function projectStart(p) {
  if (!p || !p.appointmentTime) return null;
  const d = new Date(p.appointmentTime);
  return isNaN(d) ? null : d;
}

function projectEnd(p) {
  if (!p || !p.endTime) return null;
  const d = new Date(p.endTime);
  return isNaN(d) ? null : d;
}

/* 两个时间区间是否重叠：[s1,e1) 与 [s2,e2) */
function intervalsOverlap(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

/* 判断两个地址是否相近（通过前缀匹配） */
function isAddressSimilar(addr1, addr2) {
  if (!addr1 || !addr2 || addr1.length < 4 || addr2.length < 4) return false;
  const prefixLen = Math.min(6, addr1.length, addr2.length);
  const addr1Prefix = addr1.substring(0, prefixLen);
  const addr2Prefix = addr2.substring(0, prefixLen);
  return addr1.includes(addr2Prefix) || addr2.includes(addr1Prefix);
}

/* 预约时间段文本："YYYY-MM-DD HH:mm ~ HH:mm"，跨日则结束显示完整日期 */
function fmtTimeRange(p) {
  const s = projectStart(p);
  if (!s) return "—";
  const e = projectEnd(p);
  const startStr = fmtDateTime(p.appointmentTime);
  if (!e || e.getTime() === s.getTime()) return startStr;
  const pad = (n) => String(n).padStart(2, "0");
  const sameDay = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth() && s.getDate() === e.getDate();
  const endStr = sameDay ? `${pad(e.getHours())}:${pad(e.getMinutes())}` : fmtDateTime(e);
  return `${startStr} ~ ${endStr}`;
}

/* 日期变化时自动设置时间 */
function onDateChange() {
  const dateEl = document.getElementById("pDate");
  const timeEl = document.getElementById("pTime");
  const endEl = document.getElementById("pEnd");
  
  if (!dateEl || !timeEl || !endEl) return;
  
  const selectedDate = dateEl.value;
  const today = new Date();
  const todayStr = dateKey(today);
  
  if (selectedDate === todayStr) {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = Math.ceil(now.getMinutes() / 10) * 10;
    const minsStr = minutes >= 60 ? '00' : String(minutes).padStart(2, '0');
    const hoursAdjusted = minutes >= 60 ? String((now.getHours() + 1) % 24).padStart(2, '0') : hours;
    
    let startTime = `${hoursAdjusted}:${minsStr}`;
    const startH = parseInt(hoursAdjusted);
    const startM = parseInt(minsStr);
    let endH = startH + 2;
    let endM = startM;
    if (endH >= 24) {
      endH = 23;
      endM = 59;
    }
    
    const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
    
    timeEl.value = startTime;
    endEl.value = endTime;
  }
  
  updateSpanHint();
}

/* 表单里根据开始/结束时间实时提示现场时长，或校验结束是否晚于开始 */
function updateSpanHint() {
  const durationCard = document.getElementById("pDurationCard");
  const durationValue = document.getElementById("pDurationValue");
  const suggestWorkers = document.getElementById("pSuggestWorkers");
  const dateEl = document.getElementById("pDate");
  const timeEl = document.getElementById("pTime");
  const endEl = document.getElementById("pEnd");
  const estEl = document.getElementById("pEst");
  
  if (!dateEl || !timeEl || !endEl || !durationCard || !durationValue || !suggestWorkers) {
    return;
  }
  
  const date = dateEl.value;
  const start = timeEl.value;
  const end = endEl.value;
  const estHours = Number(estEl?.value) || 0;
  const crossDayEl = document.getElementById("pCrossDay");
  
  if (!date || !start || !end) {
    durationCard.style.opacity = "0.5";
    durationValue.textContent = "--";
    suggestWorkers.textContent = "--";
    return;
  }
  
  const endDateEl = document.getElementById("pEndDate");
  let endDate = endDateEl ? endDateEl.value : "";
  if (!crossDayEl?.checked || !endDate) {
    endDate = date;
  }
  
  const s = new Date(`${date}T${start}`), e = new Date(`${endDate}T${end}`);
  if (isNaN(s) || isNaN(e)) {
    if (durationCard) durationCard.style.opacity = "0.5";
    if (durationValue) durationValue.textContent = "--";
    if (suggestWorkers) suggestWorkers.textContent = "--";
    return;
  }
  
  if (e <= s) {
    if (durationCard) durationCard.style.opacity = "1";
    if (durationValue) durationValue.innerHTML = `<span style="color:var(--danger);font-size:14px;">结束时间需晚于开始时间</span>`;
    if (suggestWorkers) suggestWorkers.textContent = "--";
    return;
  }
  
  if (durationCard) durationCard.style.opacity = "1";
  
  const mins = Math.round((e - s) / 60000);
  const days = Math.floor(mins / (24 * 60));
  const h = Math.floor((mins % (24 * 60)) / 60);
  const m = mins % 60;
  
  let durationText = "";
  if (days > 0) {
    if (h > 0 && m > 0) {
      durationText = `${days}天${h}小时${m}分钟`;
    } else if (h > 0) {
      durationText = `${days}天${h}小时`;
    } else if (m > 0) {
      durationText = `${days}天${m}分钟`;
    } else {
      durationText = `${days}天`;
    }
  } else if (h > 0 && m > 0) {
    durationText = `${h}小时${m}分钟`;
  } else if (h > 0) {
    durationText = `${h}小时`;
  } else {
    durationText = `${m}分钟`;
  }
  
  if (durationValue) {
    durationValue.innerHTML = `<span style="color:#1e293b;">${durationText}</span>`;
  }
  
  if (suggestWorkers && estHours > 0) {
    const hoursPerPerson = mins / 60;
    const suggested = Math.max(1, Math.ceil(estHours / hoursPerPerson));
    suggestWorkers.innerHTML = `<span style="color:#2563eb;">${suggested}人</span> <span style="font-size:11px;color:#64748b;">(总工时÷时长)</span>`;
  } else if (suggestWorkers) {
    suggestWorkers.textContent = "--";
  }
}

function sumHours(project) {
  return (project.workLogs || []).reduce((s, l) => s + (Number(l.hours) || 0), 0);
}

/* 工时差异：实际 - 预计。actualHours>0 视为已登记实际工时 */
function hoursDiff(project) {
  const est = Number(project.estimatedHours) || 0;
  const actualFromLogs = (project.workLogs || []).reduce((sum, l) => sum + (Number(l.hours) || 0), 0);
  const act = actualFromLogs > 0 ? actualFromLogs : (Number(project.actualHours) || 0);
  return { est, act, diff: act - est, hasActual: act > 0 };
}

/* 计算项目进度百分比 */
function getProjectProgress(p, est, act, hasActual, done) {
  if (est <= 0) return 0;
  
  if ([STATUS.DONE, STATUS.ACCEPTED, STATUS.REVIEWED].includes(p.status)) {
    return 100;
  }
  
  if (hasActual) {
    return Math.min(100, (act / est) * 100);
  }
  
  if (p.startedAt) {
    const started = new Date(p.startedAt);
    const now = new Date();
    
    const accumulatedWorkHours = p.accumulatedWorkHours || 0;
    
    let currentWorkDuration = 0;
    let endTime = now;
    if (p.status === STATUS.PAUSED && (p.pausedAt)) {
      endTime = new Date(p.pausedAt);
    }
    currentWorkDuration = (endTime - started) / (1000 * 60 * 60);
    
    const workerCount = (p.assignedWorkerIds && p.assignedWorkerIds.length) || p.workerCount || 1;
    
    const totalPersonHours = Math.max(0, (accumulatedWorkHours + currentWorkDuration) * workerCount);
    const timeProgress = (totalPersonHours / est) * 100;
    return Math.min(100, Math.max(0, timeProgress));
  }
  
  if (done > 0) {
    return Math.min(100, (done / est) * 100);
  }
  
  return 0;
}

function diffColor(diff) {
  if (diff > 0) return "var(--danger)";
  if (diff < 0) return "var(--success)";
  return "var(--muted)";
}

/* 带符号的差异文本：+1 / -2 / 0 */
function fmtSignedDiff(diff) {
  const rounded = diff.toFixed(2);
  return diff > 0 ? `+${rounded}` : `${rounded}`;
}

function calcDuration(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s) || isNaN(e)) return "—";
  const diffMs = e.getTime() - s.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}天 ${hours}小时 ${mins}分钟`;
  if (hours > 0) return `${hours}小时 ${mins}分钟`;
  return `${mins}分钟`;
}

function calcActualWorkDuration(p) {
  const accumulatedWorkHours = p.accumulatedWorkHours || 0;
  if (accumulatedWorkHours > 0) {
    const hours = Math.floor(accumulatedWorkHours);
    const mins = Math.floor((accumulatedWorkHours - hours) * 60);
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (days > 0) return `${days}天 ${remainingHours}小时 ${mins}分钟`;
    if (hours > 0) return `${hours}小时 ${mins}分钟`;
    return `${mins}分钟`;
  }
  
  if (!p.startedAt || !p.finishedAt) return "—";
  const s = new Date(p.startedAt);
  const e = new Date(p.finishedAt);
  if (isNaN(s) || isNaN(e)) return "—";
  const diffMs = e.getTime() - s.getTime();
  const pauseDurationTotal = derivePauseDuration(p);
  const actualMs = diffMs - pauseDurationTotal * 60 * 60 * 1000;
  if (actualMs <= 0) return "0分钟";
  const days = Math.floor(actualMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((actualMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((actualMs % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}天 ${hours}小时 ${mins}分钟`;
  if (hours > 0) return `${hours}小时 ${mins}分钟`;
  return `${mins}分钟`;
}

function getProjectEffectiveEndTime(p) {
  const now = new Date();
  if ([STATUS.DONE, STATUS.ACCEPTED, STATUS.REVIEWED].includes(p.status) && p.finishedAt) {
    return new Date(p.finishedAt);
  }
  if (p.status === STATUS.CANCELLED && p.cancelledAt) {
    return new Date(p.cancelledAt);
  }
  if (p.status === STATUS.PAUSED && p.pausedAt) {
    return new Date(p.pausedAt);
  }
  return now;
}

function buildWorkerPeriods(p, wid) {
  const periods = [];
  (p.workerChangeHistory || []).forEach(ch => {
    if (ch.workerId === wid) {
      if (ch.action === "assign") {
        let periodStart = ch.time;
        if (p.startedAt && new Date(ch.time) < new Date(p.startedAt)) {
          periodStart = p.startedAt;
        }
        periods.push({ start: periodStart, end: null });
      } else if (ch.action === "unassign") {
        const last = periods[periods.length - 1];
        if (last) last.end = ch.time;
      }
    }
  });
  if (periods.length === 0 && p.startedAt) {
    periods.push({ start: p.startedAt, end: null });
  }
  return periods;
}

function calcWorkerRealtimeHours(p, workerId, periods) {
  if (!periods || periods.length === 0) return 0;
  
  const projectEndTime = getProjectEffectiveEndTime(p);
  
  return periods.reduce((sum, pr) => {
    const start = new Date(pr.start);
    const end = pr.end ? new Date(pr.end) : projectEndTime;
    let duration = (end - start) / (1000 * 60 * 60);
    
    if (p.pauseHistory && p.pauseHistory.length > 0) {
      (p.pauseHistory || []).forEach((ph) => {
        if (ph.pauseAt && ph.resumedAt) {
          const pauseStart = new Date(ph.pauseAt);
          const pauseEnd = new Date(ph.resumedAt);
          const overlapStart = pauseStart > start ? pauseStart : start;
          const overlapEnd = pauseEnd < end ? pauseEnd : end;
          if (overlapEnd > overlapStart) {
            duration -= (overlapEnd - overlapStart) / (1000 * 60 * 60);
          }
        }
      });
    }
    
    return sum + duration;
  }, 0);
}

/* 项目工时差异的展示标签（含颜色），未登记实际工时时给出提示 */
function diffLabel(project) {
  const { diff, hasActual } = hoursDiff(project);
  if (!hasActual) return `<span style="color:var(--muted)">未登记实际工时</span>`;
  const diffRounded = Math.abs(diff).toFixed(2);
  if (diff > 0) return `<span style="color:var(--danger)">超 ${diffRounded} 工时</span>`;
  if (diff < 0) return `<span style="color:var(--success)">省 ${diffRounded} 工时</span>`;
  return `<span style="color:var(--muted)">持平</span>`;
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 2000);
}

function showNotificationAlert(msg) {
  const alertEl = document.createElement("div");
  alertEl.className = "notification-alert";
  alertEl.innerHTML = `<span class="notification-icon">🔔</span><span class="notification-text">${esc(msg)}</span>`;
  document.body.appendChild(alertEl);
  setTimeout(() => {
    alertEl.classList.add("fade-out");
    setTimeout(() => alertEl.remove(), 300);
  }, 4000);
}

function notify(title, message) {
  showNotificationAlert(`${title}：${message}`);
}

function sendNotificationForProjectChange(eventType, project) {
  if (!project) return;

  const store = getStore(project.storeId);
  const storeName = store ? store.name : "未知门店";

  switch (eventType) {
    case "new":
      showNotificationAlert(`📋 新预约：${project.name}（${storeName}）`);
      break;
    case "start":
      showNotificationAlert(`🏗️ 施工开始：${project.name}`);
      break;
    case "done":
      showNotificationAlert(`✅ 施工完成：${project.name}`);
      break;
    case "accepted":
      showNotificationAlert(`🎉 验收通过：${project.name}`);
      break;
    case "update":
      showNotificationAlert(`📝 项目更新：${project.name}`);
      break;
    case "pause":
      showNotificationAlert(`⏸️ 项目暂停：${project.name}`);
      break;
    case "resume":
      showNotificationAlert(`▶️ 项目恢复：${project.name}`);
      break;
  }
}

/* ============================================================
 * 字段映射（云端 snake_case <-> 前端 camelCase）
 * 
 * 命名约定：
 * - 前端 JavaScript 代码统一使用 camelCase（如 workerId, appointmentTime）
 * - 数据库字段使用 snake_case（如 worker_id, appointment_time）
 * - mapProject() 将数据库字段转为前端格式
 * - projectToRow() 将前端格式转为数据库格式
 * - 其他实体（workers, stores, leave_records 等）遵循相同规则
 * ============================================================ */
let modifiedProjectIds = new Set();
let projectTimeFilterDays = 7;

const mapProject = (r) => ({
  id: r.id,
  name: r.name,
  customer: r.customer,
  phone: r.phone,
  address: r.address,
  appointmentTime: r.appointment_time || r.appointmentTime || "",
  endTime: r.end_time || r.endTime || "",
  estimatedHours: Number(r.estimated_hours) || Number(r.estimatedHours) || 0,
  outsourcedHours: Number(r.outsourced_hours) || Number(r.outsourcedHours) || 0,
  workerCount: Number(r.worker_count) || Number(r.workerCount) || 1,
  actualHours: Number(r.actual_hours) || Number(r.actualHours) || 0,
  outsourcedHoursFromLogs: 0,
  status: r.status,
  note: r.note,
  acceptance: r.acceptance || null,
  storeId: r.store_id || r.storeId || "",
  createdBy: r.created_by || r.createdBy || null,
  assignedWorkerIds: Array.isArray(r.assigned_workers) ? r.assigned_workers : (r.assignedWorkerIds || []),
  outsourcedWorkers: r.outsourced_workers || r.outsourcedWorkers || "",
  startedAt: r.started_at || r.startedAt || "",
  originalStartedAt: r.original_started_at || r.originalStartedAt || "",
  finishedAt: r.finished_at || r.finishedAt || "",
  createdAt: r.created_at,
  workLogs: r.workLogs || [],
  timeModified: modifiedProjectIds.has(r.id),
  repairOrder: r.repair_order ? (typeof r.repair_order === "string" ? safeJsonParse(r.repair_order, null) : r.repair_order) : null,
  pausedAt: r.paused_at || null,
  pauseReason: r.pause_reason || null,
  pauseCount: Number(r.pause_count) || 0,
  accumulatedWorkHours: Number(r.accumulated_work_hours) || Number(r.accumulatedWorkHours) || 0,
  resumedAt: r.resumed_at || r.resumedAt || null,
  workSessions: (r.work_sessions || r.workSessions) ? (typeof (r.work_sessions || r.workSessions) === "string" ? safeJsonParse(r.work_sessions || r.workSessions, []) : (r.work_sessions || r.workSessions)) : [],
  reviewedAt: r.reviewed_at || null,
  pauseHistory: (r.pause_history || r.pauseHistory) ? (typeof (r.pause_history || r.pauseHistory) === "string" ? safeJsonParse(r.pause_history || r.pauseHistory, []) : (r.pause_history || r.pauseHistory)) : [],
  delayHistory: (r.delay_history || r.delayHistory) ? (typeof (r.delay_history || r.delayHistory) === "string" ? safeJsonParse(r.delay_history || r.delayHistory, []) : (r.delay_history || r.delayHistory)) : [],
  workerChangeHistory: (r.worker_change_history || r.workerChangeHistory) ? (typeof (r.worker_change_history || r.workerChangeHistory) === "string" ? safeJsonParse(r.worker_change_history || r.workerChangeHistory, []) : (r.worker_change_history || r.workerChangeHistory)) : [],
  actionLogs: (r.action_logs || r.actionLogs) ? (typeof (r.action_logs || r.actionLogs) === "string" ? safeJsonParse(r.action_logs || r.actionLogs, []) : (r.action_logs || r.actionLogs)) : [],
  delayReason: r.delay_reason || null,
  delayCount: Number(r.delay_count) || 0,
  scheduleHistory: (r.schedule_history || r.scheduleHistory) ? (typeof (r.schedule_history || r.scheduleHistory) === "string" ? safeJsonParse(r.schedule_history || r.scheduleHistory, []) : (r.schedule_history || r.scheduleHistory)) : [],
  cancelledAt: r.cancelled_at || r.cancelledAt || null,
  cancelReason: r.cancel_reason || r.cancelReason || null,
});

const projectToRow = (p) => ({
  id: p.id,
  name: p.name,
  customer: p.customer || null,
  phone: p.phone || null,
  address: p.address || null,
  appointment_time: p.appointmentTime || null,
  end_time: p.endTime || null,
  estimated_hours: p.estimatedHours || 0,
  outsourced_hours: p.outsourcedHours || 0,
  worker_count: p.workerCount || 1,
  actual_hours: p.actualHours || 0,
  status: p.status,
  note: p.note || null,
  acceptance: p.acceptance || null,
  store_id: p.storeId || null,
  assigned_workers: p.assignedWorkerIds || [],
  outsourced_workers: p.outsourcedWorkers || "",
  started_at: p.startedAt || null,
  original_started_at: p.originalStartedAt || null,
  finished_at: p.finishedAt || null,
  updated_at: new Date().toISOString(),
  repair_order: p.repairOrder ? JSON.stringify(p.repairOrder) : null,
  paused_at: p.pausedAt || null,
  pause_reason: p.pauseReason || null,
  pause_count: p.pauseCount || 0,
  accumulated_work_hours: p.accumulatedWorkHours || 0,
  resumed_at: p.resumedAt || null,
  work_sessions: p.workSessions && Array.isArray(p.workSessions) ? JSON.stringify(p.workSessions) : null,
  reviewed_at: p.reviewedAt || null,
  pause_history: p.pauseHistory && Array.isArray(p.pauseHistory) ? JSON.stringify(p.pauseHistory) : null,
  delay_history: p.delayHistory && Array.isArray(p.delayHistory) ? JSON.stringify(p.delayHistory) : null,
  worker_change_history: p.workerChangeHistory && Array.isArray(p.workerChangeHistory) ? JSON.stringify(p.workerChangeHistory) : null,
  action_logs: p.actionLogs && Array.isArray(p.actionLogs) ? JSON.stringify(p.actionLogs) : null,
  delay_reason: p.delayReason || null,
  delay_count: p.delayCount || 0,
  schedule_history: p.scheduleHistory && p.scheduleHistory.length > 0 ? JSON.stringify(p.scheduleHistory) : null,
  cancelled_at: p.cancelledAt || null,
  cancel_reason: p.cancelReason || null,
});

const mapLog = (r) => ({
  id: r.id,
  workerId: r.worker_id || r.workerId || "",
  workerName: r.worker_name || r.workerName || "",
  hours: Number(r.hours) || 0,
  date: r.date || "",
  note: r.note || "",
  level: r.level || "中级",
  isOutsourced: r.is_outsourced || false,
});

/* ============================================================
 * 数据仓储层（统一接口，内部按 MODE 分流）
 * 上层业务只调用 repo.xxx，不关心存在哪
 * ============================================================ */
const repo = {
  /* ---- 载入全部数据到 cache ---- */
  async loadAll() {
    if (MODE === "cloud") {
      const [wRes, pRes, lRes, sRes, rpRes, lrRes, lqRes, hRes, oRes, opRes, wsRes] = await Promise.all([
        sb.from("workers").select("*"),
        sb.from("projects").select("*"),
        sb.from("work_logs").select("*"),
        sb.from("stores").select("*"),
        sb.from("role_permissions").select("*"),
        sb.from("leave_records").select("*"),
        sb.from("leave_quota").select("*"),
        sb.from("holidays").select("*"),
        sb.from("outsourced_workers").select("*"),
        sb.from("operation_logs").select("*").order("timestamp", { ascending: false }).limit(MAX_LOGS),
        sb.from("worker_schedules").select("*"),
      ]);
      const allErrors = [
        { name: "workers", res: wRes },
        { name: "projects", res: pRes },
        { name: "work_logs", res: lRes },
        { name: "stores", res: sRes },
        { name: "role_permissions", res: rpRes },
        { name: "leave_records", res: lrRes },
        { name: "leave_quota", res: lqRes },
        { name: "holidays", res: hRes },
      ].filter(e => e.res.error);
      
      if (allErrors.length > 0) {
        const errorMsg = allErrors.map(e => `${e.name}: ${e.res.error.message}`).join("\n");
        console.error("云端数据读取失败:", errorMsg);
        toast(`云端数据读取失败，${allErrors.length} 个表出错，请检查建表脚本是否已执行`);
        return;
      }
      // 角色权限：以默认模板为底，用云端配置覆盖（rpRes 出错则退回默认）
      rolePerms = JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMS));
      if (!rpRes.error) {
        (rpRes.data || []).forEach((r) => {
          rolePerms[r.role] = { ...(DEFAULT_ROLE_PERMS[r.role] || {}), ...(r.perms || {}) };
        });
      }
      cache.stores = (sRes.data || []).map((r) => ({ id: r.id, name: r.name, phone: r.phone || "" }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh"));
      cache.workers = (wRes.data || []).map((r) => ({
        id: r.id, name: r.name, phone: r.phone, role: r.role,
      }));
      
      const logs = (lRes.data || []).map((r) => ({ ...mapLog(r), _pid: r.project_id }));
      cache.projects = (pRes.data || []).map((r) => {
        const p = mapProject(r);
        p.workLogs = logs.filter((l) => l._pid === r.id).map(({ _pid, ...l }) => l);
        p.outsourcedHoursFromLogs = p.workLogs.reduce((sum, l) => {
          const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
          return sum + (isOutsourced ? (Number(l.hours) || 0) : 0);
        }, 0);
        return p;
      });
      cache.leaveRecords = (lrRes.data || []).map((r) => ({
        id: r.id, workerId: r.worker_id, workerName: r.worker_name,
        leaveType: r.leave_type || "personal",
        startDate: r.start_date, startType: r.start_type || "all", startTime: r.start_time,
        endDate: r.end_date, endType: r.end_type || "all", endTime: r.end_time,
        reason: r.reason, status: r.status || "pending",
        reviewerId: r.reviewer_id, reviewerName: r.reviewer_name,
        reviewNote: r.review_note, reviewedAt: r.reviewed_at,
        createdAt: r.created_at,
      }));
      cache.leaveQuota = (lqRes.data || []).map((r) => ({
        id: r.id, workerId: r.worker_id,
        personal_days: r.personal_days || 15,
        sick_days: r.sick_days || 30,
        annual_days: r.annual_days || 10,
        comp_days: r.comp_days || 0,
        year: r.year,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      cache.holidays = (hRes.data || []).map((r) => ({
        id: r.id, date: r.date, name: r.name,
        isWorkday: r.is_workday || false,
        createdAt: r.created_at,
      }));
      if (!oRes.error) {
        cache.outsourcedWorkers = (oRes.data || []).map((r) => ({
          id: r.id, name: r.name, phone: r.phone || "",
        })).sort((a, b) => a.name.localeCompare(b.name, "zh"));
      } else {
        console.warn("outsourced_workers 表读取失败（可能尚未创建）:", oRes.error.message);
        cache.outsourcedWorkers = [];
      }
      if (!opRes.error) {
        cache.operationLogs = (opRes.data || []).map((r) => ({
          id: r.id, type: r.type, typeLabel: r.type_label,
          target: r.target, detail: r.detail,
          operator: r.operator, operatorName: r.operator_name,
          operatorRole: r.operator_role, timestamp: r.timestamp,
        }));
      } else {
        console.warn("operation_logs 表读取失败（可能尚未创建）:", opRes.error.message);
        cache.operationLogs = [];
      }
      if (!wsRes.error) {
        cache.workerSchedules = (wsRes.data || []).map((r) => ({
          id: r.id, workerId: r.worker_id, workerName: r.worker_name,
          title: r.title, startDate: r.start_date, startTime: r.start_time,
          endDate: r.end_date, endTime: r.end_time,
          type: r.type || "personal", description: r.description || "",
          createdBy: r.created_by, createdByName: r.created_by_name,
          createdAt: r.created_at,
        }));
      } else {
        console.warn("worker_schedules 表读取失败（可能尚未创建）:", wsRes.error.message);
        cache.workerSchedules = [];
      }
    } else {
      loadLocal();
    }
  },

  /* ---- 门店 ---- */
  async saveStore(store, id) {
    if (MODE === "cloud") {
      const { error } = await sb.from("stores").upsert({ id: id || uid(), name: store.name, phone: store.phone || null });
      if (error) return fail(error);
    } else {
      if (id) Object.assign(getStore(id), store);
      else cache.stores.push({ id: uid(), ...store });
      saveLocal();
    }
  },
  async deleteStore(id) {
    if (MODE === "cloud") {
      const { error } = await sb.from("stores").delete().eq("id", id);
      if (error) return fail(error);
    } else {
      cache.stores = cache.stores.filter((s) => s.id !== id);
      saveLocal();
    }
  },

  /* ---- 账号档案（仅云端，总经理可用） ---- */
  async loadProfiles() {
    if (MODE !== "cloud") return [];
    const { data, error } = await sb.from("profiles").select("*").order("email");
    if (error) { fail(error); return []; }
    return (data || []).map((r) => ({ id: r.id, email: r.email, name: r.name || "", role: r.role, storeId: r.store_id || "" }));
  },
  async setProfile(userId, patch) {
    if (MODE !== "cloud") return;
    const row = {};
    if ("role" in patch) row.role = patch.role || null;
    if ("storeId" in patch) row.store_id = patch.storeId || null;
    if ("name" in patch) row.name = patch.name || null;
    const { error } = await sb.from("profiles").update(row).eq("id", userId);
    if (error) return fail(error);
  },
  async deleteAccount(userId) {
    if (MODE === "cloud") {
      try {
        const { error: profileError } = await sb.from("profiles").delete().eq("id", userId);
        if (profileError) {
          console.warn("删除 profiles 失败:", profileError);
        }
        if (sbAdmin) {
          const { error: authError } = await sbAdmin.auth.admin.deleteUser(userId);
          if (authError) {
            console.warn("删除 Auth 用户失败:", authError);
            return fail(new Error("删除 Auth 用户失败，请手动在 Supabase 控制台删除"));
          }
        }
      } catch (e) {
        return fail(e);
      }
    } else {
      cache.accounts = cache.accounts.filter(a => a.id !== userId);
      saveLocal();
    }
  },

  /* ---- 角色权限模板（总经理配置每个角色可做的操作） ---- */
  async saveRolePermissions(role, perms) {
    rolePerms[role] = perms;
    if (MODE === "cloud") {
      const { error } = await sb.from("role_permissions")
        .upsert({ role, perms, updated_at: new Date().toISOString() });
      if (error) return fail(error);
    }
  },

  /* ---- 施工人员 ---- */
  async saveWorker(worker, id) {
    if (MODE === "cloud") {
      const row = { id: id || uid(), name: worker.name, phone: worker.phone || null, role: worker.role || null };
      const { error } = await sb.from("workers").upsert(row);
      if (error) return fail(error);
    } else {
      if (id) Object.assign(getWorker(id), worker);
      else cache.workers.push({ id: uid(), ...worker });
      saveLocal();
    }
  },
  async deleteWorker(id) {
    if (MODE === "cloud") {
      const { error } = await sb.from("workers").delete().eq("id", id);
      if (error) return fail(error);
    } else {
      cache.workers = cache.workers.filter((w) => w.id !== id);
      saveLocal();
    }
  },

  /* ---- 外协人员 ---- */
  async saveOutsourcedWorker(worker, id) {
    if (MODE === "cloud") {
      const row = { id: id || uid(), name: worker.name, phone: worker.phone || null };
      const { error } = await sb.from("outsourced_workers").upsert(row);
      if (error) return fail(error);
    } else {
      if (id) Object.assign(getOutsourcedWorker(id), worker);
      else cache.outsourcedWorkers.push({ id: uid(), ...worker });
      saveLocal();
    }
  },
  async deleteOutsourcedWorker(id) {
    if (MODE === "cloud") {
      const { error } = await sb.from("outsourced_workers").delete().eq("id", id);
      if (error) return fail(error);
    } else {
      cache.outsourcedWorkers = cache.outsourcedWorkers.filter((w) => w.id !== id);
      saveLocal();
    }
  },

  /* ---- 施工人员日程 ---- */
  async saveWorkerSchedule(schedule, id) {
    if (MODE === "cloud") {
      const row = {
        id: id || uid(), worker_id: schedule.workerId, worker_name: schedule.workerName,
        title: schedule.title, start_date: schedule.startDate, start_time: schedule.startTime,
        end_date: schedule.endDate, end_time: schedule.endTime,
        type: schedule.type || "personal", description: schedule.description || null,
        created_by: schedule.createdBy || null, created_by_name: schedule.createdByName || null,
      };
      const { error } = await sb.from("worker_schedules").upsert(row);
      if (error) return fail(error);
    } else {
      if (id) Object.assign(getWorkerSchedule(id), schedule);
      else cache.workerSchedules.push({ id: uid(), ...schedule });
      saveLocal();
    }
  },
  async deleteWorkerSchedule(id) {
    if (MODE === "cloud") {
      const { error } = await sb.from("worker_schedules").delete().eq("id", id);
      if (error) return fail(error);
    } else {
      cache.workerSchedules = cache.workerSchedules.filter((s) => s.id !== id);
      saveLocal();
    }
  },

  /* ---- 项目 ---- */
  async saveProject(project, id) {
    if (MODE === "cloud") {
      const base = id ? { ...getProject(id), ...project } : { id: uid(), actualHours: 0, ...project };
      const row = projectToRow(base);
      if (!id && currentUser) row.created_by = currentUser.id;
      
      let { error } = id 
        ? await sb.from("projects").update(row).eq("id", id)
        : await sb.from("projects").insert(row);
        
      if (error && error.message && error.message.includes("worker_count")) {
        delete row.worker_count;
        error = id 
          ? (await sb.from("projects").update(row).eq("id", id)).error
          : (await sb.from("projects").insert(row)).error;
      }
      if (error) return fail(error);
    } else {
      if (id) {
        Object.assign(getProject(id), project);
      } else {
        cache.projects.push({ id: uid(), ...project, actualHours: 0, assignedWorkerIds: project.assignedWorkerIds || [], workLogs: [], acceptance: null, createdAt: new Date().toISOString() });
      }
      saveLocal();
    }
  },
  async deleteProject(id) {
    if (MODE === "cloud") {
      await sb.from("work_logs").delete().eq("project_id", id);
      const { error } = await sb.from("projects").delete().eq("id", id);
      if (error) return fail(error);
    } else {
      cache.projects = cache.projects.filter((p) => p.id !== id);
      saveLocal();
    }
  },
  async patchProject(id, patch) {
    if (MODE === "cloud") {
      const row = { ...patch, updated_at: new Date().toISOString() };
      for (const [key, value] of Object.entries(row)) {
        if (key.includes("_")) continue;
        const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
        if (snakeKey !== key && !(snakeKey in row)) {
          row[snakeKey] = value;
          delete row[key];
        }
      }
      if (row.repairOrder) {
        row.repair_order = JSON.stringify(row.repairOrder);
        delete row.repairOrder;
      }
      if (row.schedule_history && Array.isArray(row.schedule_history)) {
        row.schedule_history = JSON.stringify(row.schedule_history);
      }
      if (row.scheduleHistory && Array.isArray(row.scheduleHistory)) {
        row.schedule_history = JSON.stringify(row.scheduleHistory);
        delete row.scheduleHistory;
      }
      if (row.workSessions && Array.isArray(row.workSessions)) {
        row.work_sessions = JSON.stringify(row.workSessions);
        delete row.workSessions;
      }
      
      const project = getProject(id);
      if (project && typeof project.version === 'number') {
        row.version = project.version + 1;
        const { error, count } = await sb.from("projects").update(row).eq("id", id).eq("version", project.version);
        if (error) return fail(error);
        if (count === 0) {
          toast("⚠️ 数据冲突：该项目已被其他用户修改，请刷新后重试");
          await repo.loadAll();
          renderAll();
          return false;
        }
      } else {
        const { error } = await sb.from("projects").update(row).eq("id", id);
        if (error) return fail(error);
      }
    } else {
      const p = getProject(id);
      if (!p) {
        console.error("项目不存在:", id);
        return;
      }
      for (const [key, value] of Object.entries(patch)) {
        if (key.includes("_")) {
          const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
          if (camelKey in p) p[camelKey] = value;
          else p[key] = value;
        } else {
          p[key] = value;
        }
      }
      p.version = (p.version || 0) + 1;
      saveLocal();
    }
  },

  /* ---- 提前分配安装人员 ---- */
  async setAssignedWorkers(pid, ids) {
    if (MODE === "cloud") {
      const { error } = await sb.from("projects")
        .update({ assigned_workers: ids, updated_at: new Date().toISOString() })
        .eq("id", pid);
      if (error) return fail(error);
    } else {
      const project = getProject(pid);
      if (project) {
        project.assignedWorkerIds = ids;
        saveLocal();
      }
    }
  },

  /* ---- 施工工时 ---- */
  async addWorkLog(pid, log) {
    if (MODE === "cloud") {
      clearTimeout(reloadTimer);
      let row = {
        id: uid(), project_id: pid, worker_id: log.workerId,
        worker_name: log.workerName, hours: Number(log.hours), date: log.date, note: log.note || null,
        level: log.level || "中级",
        is_outsourced: !!log.isOutsourced,
      };
      let { error } = await sb.from("work_logs").insert(row);
      if (error && error.message && error.message.includes('level')) {
        const { level, ...rowWithoutLevel } = row;
        row = rowWithoutLevel;
        ({ error } = await sb.from("work_logs").insert(row));
      }
      if (error && error.message && error.message.includes('is_outsourced')) {
        const { is_outsourced, ...rowWithoutIsOutsourced } = row;
        ({ error } = await sb.from("work_logs").insert(rowWithoutIsOutsourced));
      }
      if (error) return fail(error);
    } else {
      const p = getProject(pid);
      if (!p.workLogs) p.workLogs = [];
      p.workLogs.push({ id: uid(), ...log });
      saveLocal();
    }
  },
  async deleteWorkLog(pid, lid) {
    if (MODE === "cloud") {
      const { error } = await sb.from("work_logs").delete().eq("id", lid);
      if (error) return fail(error);
    } else {
      const p = getProject(pid);
      p.workLogs = (p.workLogs || []).filter((l) => l.id !== lid);
      saveLocal();
    }
  },

  /* ---- 请假记录 ---- */
  async saveLeaveRecord(leave, id) {
    if (MODE === "cloud") {
      const row = {
        id: id || uid(), worker_id: leave.workerId, worker_name: leave.workerName,
        leave_type: leave.leaveType || "personal",
        start_date: leave.startDate, start_type: leave.startType || "all", start_time: leave.startTime || null,
        end_date: leave.endDate, end_type: leave.endType || "all", end_time: leave.endTime || null,
        reason: leave.reason || null, status: leave.status || "pending",
        reviewer_id: leave.reviewerId || null, reviewer_name: leave.reviewerName || null,
        review_note: leave.reviewNote || null, reviewed_at: leave.reviewedAt || null,
      };
      const { error } = await sb.from("leave_records").upsert(row);
      if (error) return fail(error);
    } else {
      if (id) Object.assign(getLeaveRecord(id), leave);
      else cache.leaveRecords.push({ id: uid(), ...leave });
      saveLocal();
    }
  },
  async deleteLeaveRecord(id) {
    if (MODE === "cloud") {
      const { error } = await sb.from("leave_records").delete().eq("id", id);
      if (error) return fail(error);
    }
    cache.leaveRecords = cache.leaveRecords.filter((l) => l.id !== id);
    if (MODE !== "cloud") saveLocal();
  },
  async saveHoliday(holiday, id) {
    if (MODE === "cloud") {
      const row = {
        id: id || uid(), date: holiday.date, name: holiday.name,
        is_workday: holiday.isWorkday || false,
      };
      const { error } = await sb.from("holidays").upsert(row);
      if (error) return fail(error);
    } else {
      const existing = cache.holidays.find(h => h.date === holiday.date);
      if (existing) Object.assign(existing, holiday);
      else cache.holidays.push({ id: uid(), ...holiday });
      saveLocal();
    }
  },
  async deleteHoliday(id) {
    if (MODE === "cloud") {
      const { error } = await sb.from("holidays").delete().eq("id", id);
      if (error) return fail(error);
    } else {
      cache.holidays = cache.holidays.filter((h) => h.id !== id);
      saveLocal();
    }
  },
};

function fail(error) {
  console.error("云端操作失败:", error);
  let message = "云端操作失败";
  if (error.message) {
    message += "：" + error.message;
    if (error.message.includes("column")) {
      message += "\n提示：请检查建表脚本是否已执行";
    } else if (error.message.includes("RLS")) {
      message += "\n提示：可能是权限不足，请联系管理员";
    } else if (error.message.includes("duplicate")) {
      message += "\n提示：数据重复，请检查";
    }
  } else if (error.code) {
    message += "（错误码：" + error.code + "）";
  }
  toast(message);
  console.error("[app] 操作失败:", error);
  // 不再 throw，避免未捕获异常导致 UI 崩溃
}

function migrateData(data) {
  const currentVersion = data.version || 1;
  
  if (currentVersion < 2) {
    if (!data.outsourcedWorkers) {
      data.outsourcedWorkers = [];
    }
    if (!data.workerSchedules) {
      data.workerSchedules = [];
    }
    data.projects = (data.projects || []).map(p => {
      if (!p.workSessions) p.workSessions = [];
      if (!p.pauseHistory) p.pauseHistory = [];
      if (!p.delayHistory) p.delayHistory = [];
      if (!p.workerChangeHistory) p.workerChangeHistory = [];
      if (!p.actionLogs) p.actionLogs = [];
      if (!p.scheduleHistory) p.scheduleHistory = [];
      return p;
    });
    data.version = 2;
  }
  
  return data;
}

/* ---------- 本地存储实现 ---------- */
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      let data = safeJsonParse(raw, {});
      data = migrateData(data);
      cache.workers = data.workers || [];
      cache.projects = (data.projects || []).map((p) => {
        const mapped = mapProject(p);
        mapped.outsourcedHoursFromLogs = (mapped.workLogs || []).reduce((sum, l) => {
          const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
          return sum + (isOutsourced ? (Number(l.hours) || 0) : 0);
        }, 0);
        return mapped;
      });
      cache.stores = data.stores || [];
      cache.leaveRecords = data.leaveRecords || [];
      cache.leaveQuota = data.leaveQuota || [];
      cache.holidays = data.holidays || [];
      cache.outsourcedWorkers = data.outsourcedWorkers || [];
      cache.workerSchedules = data.workerSchedules || [];
      cache.operationLogs = data.operationLogs || [];
      cache.accounts = data.accounts || [];
    }
  } catch (e) {
    console.error("读取本地数据失败", e);
  }
  if (cache.workers.length === 0 && cache.projects.length === 0) {
    cache.workers = [
      { id: uid(), name: "张伟", phone: "13800000001", role: "安装工" },
      { id: uid(), name: "李强", phone: "13800000002", role: "安装工" },
      { id: uid(), name: "王芳", phone: "13800000003", role: "电工" },
    ];
    saveLocal();
  }
}

function saveLocal() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ 
      version: DATA_VERSION,
      workers: cache.workers, 
      projects: cache.projects, 
      stores: cache.stores, 
      leaveRecords: cache.leaveRecords,
      leaveQuota: cache.leaveQuota,
      holidays: cache.holidays,
      outsourcedWorkers: cache.outsourcedWorkers,
      workerSchedules: cache.workerSchedules,
      operationLogs: cache.operationLogs,
      accounts: cache.accounts
    }));
  } catch (e) {
    console.error("[app] localStorage 保存失败（可能已满）:", e);
    if (e.name === "QuotaExceededError") {
      toast("⚠️ 本地存储空间不足！请清理旧项目数据或导出备份");
    } else {
      toast("⚠️ 数据保存失败，请检查浏览器存储空间");
    }
  }
}

let pendingChanges = new Set();

async function loadTableData(tableName) {
  const { data, error } = await sb.from(tableName).select("*");
  if (error) {
    console.warn(`加载 ${tableName} 失败:`, error);
    return [];
  }
  return data || [];
}

async function applyIncrementalUpdate(tableName) {
  switch (tableName) {
    case "workers": {
      const data = await loadTableData("workers");
      cache.workers = data.map(r => ({ id: r.id, name: r.name, phone: r.phone, role: r.role }));
      break;
    }
    case "stores": {
      const data = await loadTableData("stores");
      cache.stores = data.map(r => ({ id: r.id, name: r.name, phone: r.phone || "" }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh"));
      break;
    }
    case "role_permissions": {
      const data = await loadTableData("role_permissions");
      rolePerms = JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMS));
      data.forEach(r => {
        rolePerms[r.role] = { ...(DEFAULT_ROLE_PERMS[r.role] || {}), ...(r.perms || {}) };
      });
      applyPermissions();
      break;
    }
    case "leave_records": {
      const data = await loadTableData("leave_records");
      cache.leaveRecords = data.map(r => ({
        id: r.id, workerId: r.worker_id, workerName: r.worker_name,
        leaveType: r.leave_type || "personal",
        startDate: r.start_date, startType: r.start_type || "all", startTime: r.start_time,
        endDate: r.end_date, endType: r.end_type || "all", endTime: r.end_time,
        reason: r.reason, status: r.status || "pending",
        reviewerId: r.reviewer_id, reviewerName: r.reviewer_name,
        reviewNote: r.review_note, reviewedAt: r.reviewed_at,
        createdAt: r.created_at,
      }));
      break;
    }
    case "outsourced_workers": {
      const data = await loadTableData("outsourced_workers");
      cache.outsourcedWorkers = data.map(r => ({ id: r.id, name: r.name, phone: r.phone || "" }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh"));
      break;
    }
    case "holidays": {
      const data = await loadTableData("holidays");
      cache.holidays = data.map(r => ({
        id: r.id, date: r.date, name: r.name,
        isWorkday: r.is_workday || false,
        createdAt: r.created_at,
      }));
      break;
    }
    case "worker_schedules": {
      const data = await loadTableData("worker_schedules");
      cache.workerSchedules = data.map(r => ({
        id: r.id, workerId: r.worker_id, workerName: r.worker_name,
        title: r.title, startDate: r.start_date, startTime: r.start_time,
        endDate: r.end_date, endTime: r.end_time,
        type: r.type || "personal", description: r.description || "",
        createdBy: r.created_by, createdByName: r.created_by_name,
        createdAt: r.created_at,
      }));
      break;
    }
    case "projects":
    case "work_logs": {
      const [pRes, lRes] = await Promise.all([
        sb.from("projects").select("*"),
        sb.from("work_logs").select("*"),
      ]);
      if (!pRes.error && !lRes.error) {
        const logs = (lRes.data || []).map(r => ({ ...mapLog(r), _pid: r.project_id }));
        cache.projects = (pRes.data || []).map(r => {
          const p = mapProject(r);
          p.workLogs = logs.filter(l => l._pid === r.id).map(({ _pid, ...l }) => l);
          p.outsourcedHoursFromLogs = p.workLogs.reduce((sum, l) => {
            const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
            return sum + (isOutsourced ? (Number(l.hours) || 0) : 0);
          }, 0);
          return p;
        });
      }
      break;
    }
  }
}

/* ============================================================
 * 实时同步：任意客户端改动 -> 去抖后增量更新并重绘
 * ============================================================ */
function subscribeRealtime() {
  if (MODE !== "cloud") return;
  sb.channel("realtime-all")
    .on("postgres_changes", { event: "*", schema: "public", table: "workers" }, () => pendingChanges.add("workers"))
    .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, () => pendingChanges.add("projects"))
    .on("postgres_changes", { event: "*", schema: "public", table: "work_logs" }, () => pendingChanges.add("work_logs"))
    .on("postgres_changes", { event: "*", schema: "public", table: "stores" }, () => pendingChanges.add("stores"))
    .on("postgres_changes", { event: "*", schema: "public", table: "role_permissions" }, () => pendingChanges.add("role_permissions"))
    .on("postgres_changes", { event: "*", schema: "public", table: "leave_records" }, () => pendingChanges.add("leave_records"))
    .on("postgres_changes", { event: "*", schema: "public", table: "outsourced_workers" }, () => pendingChanges.add("outsourced_workers"))
    .on("postgres_changes", { event: "*", schema: "public", table: "holidays" }, () => pendingChanges.add("holidays"))
    .on("postgres_changes", { event: "*", schema: "public", table: "worker_schedules" }, () => pendingChanges.add("worker_schedules"))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setSyncStatus("online", "● 实时同步中");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSyncStatus("offline", "● 同步连接异常");
    });
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    if (pendingChanges.size === 0) return;
    
    const hasRolePermChange = pendingChanges.has("role_permissions");
    const hasProjectChange = pendingChanges.has("projects") || pendingChanges.has("work_logs");
    const needsFullReload = pendingChanges.size > 5 || hasProjectChange;
    
    if (needsFullReload) {
      await repo.loadAll();
      applyPermissions();
    } else {
      for (const table of pendingChanges) {
        await applyIncrementalUpdate(table);
      }
      if (hasRolePermChange) {
        applyPermissions();
      }
    }
    
    pendingChanges.clear();
    renderAll();
  }, 300);
}

function setSyncStatus(cls, text) {
  const el = document.getElementById("syncStatus");
  el.className = "sync-status " + (cls || "");
  el.textContent = text;
}

/* ============================================================
 * 施工人员模块
 * ============================================================ */
function renderWorkers(dateStr) {
  const list = document.getElementById("workerList");
  const today = fmtDate(new Date());
  const displayDate = dateStr || today;
  const isWorkerRole = myRole() === ROLE.WORKER;
  
  if (isWorkerRole) {
    renderWorkerScheduleForWorker(displayDate);
    return;
  }
  
  if (!list) return;
  
  if (cache.workers.length === 0) {
    list.innerHTML = `<div class="empty">暂无施工人员，点击右上角「添加人员」创建。</div>`;
    return;
  }
  
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfterTomorrow = new Date();
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
  
  const tomorrowStr = fmtDate(tomorrow);
  const dayAfterStr = fmtDate(dayAfterTomorrow);
  
  const isToday = displayDate === today;
  const isTomorrow = displayDate === tomorrowStr;
  const isDayAfter = displayDate === dayAfterStr;
  
  const timelineHtml = renderWorkerScheduleHtml(displayDate);
  
  list.innerHTML = `
    <div id="workerScheduleSection" style="margin-bottom: 24px;">
      <div class="section-head" style="margin-bottom: 12px; display:flex; align-items:center; justify-content:space-between;">
        <h3 style="margin:0; font-size:16px;">📅 施工时间安排</h3>
        <div style="display:flex; gap:4px;">
          <button class="btn small ${isToday ? 'primary' : ''}" onclick="renderWorkers()">今天</button>
          <button class="btn small ${isTomorrow ? 'primary' : ''}" onclick="renderWorkers('${tomorrowStr}')">明天</button>
          <button class="btn small ${isDayAfter ? 'primary' : ''}" onclick="renderWorkers('${dayAfterStr}')">后天</button>
          <button class="btn small" onclick="renderWorkers()">🔄 刷新</button>
        </div>
      </div>
      <div id="workerScheduleView">${timelineHtml}</div>
    </div>
    <div class="section-head" style="margin-bottom: 12px;">
      <h3 style="margin:0; font-size:16px;">👷 施工人员列表</h3>
    </div>
    <div class="card-grid" style="margin-top:0;">
    ${cache.workers.map((w) => {
      const totalHours = cache.projects.reduce((s, p) =>
        s + (p.workLogs || []).filter((l) => l.workerId === w.id)
          .reduce((a, l) => a + (Number(l.hours) || 0), 0), 0);
      return `
        <div class="card">
          <div class="card-title">
            <h3>${esc(w.name)}</h3>
            <span class="badge 已完工">${esc(w.role || "施工")}</span>
          </div>
          <div class="card-row"><span>联系电话</span><b>${esc(w.phone || "—")}</b></div>
          <div class="card-row"><span>累计施工工时</span><b>${totalHours} 小时</b></div>
          <div class="card-actions">
            ${perm.editWorker() ? `<button class="btn small" onclick="editWorker('${w.id}')">编辑</button>` : ""}${perm.deleteWorker() ? `<button class="btn small danger" onclick="deleteWorker('${w.id}')">删除</button>` : ""}
            <button class="btn small" onclick="renderWorkerSchedule('${displayDate}', '${w.id}')">查看安排</button>
            <button class="btn small" onclick="openLeaveForm('${w.id}')" style="background:#ef4444;color:#fff">请假</button>
          </div>
        </div>`;
    }).join("")}
    </div>`;
}

function renderWorkerScheduleHtml(dateStr, workerId = null) {
  const items = cache.projects.filter(p => {
    if (!p.assignedWorkerIds || p.assignedWorkerIds.length === 0) return false;
    if (isCompleted(p)) return false;
    const start = projectStart(p);
    if (!start) return false;
    return fmtDate(start) === dateStr;
  });
  
  const internalTasks = getInternalTasks().filter(t => {
    if (t.status === 'verified') return false;
    return t.date === dateStr;
  });
  
  if (items.length === 0 && internalTasks.length === 0) {
    return `<div class="empty" style="padding:24px 0;">${dateStr} 暂无施工安排</div>`;
  }
  
  const workers = workerId ? [getWorker(workerId)].filter(Boolean) : cache.workers;
  const totalHours = 16;
  const listEl = document.getElementById('workerList');
  const scheduleEl = document.getElementById('workerScheduleView');
  const containerEl = listEl || scheduleEl;
  const containerWidth = containerEl 
    ? Math.max(800, containerEl.clientWidth - 32)
    : Math.max(800, window.innerWidth - 64);
  const hourWidth = Math.max(50, containerWidth / totalHours);
  const totalWidth = containerWidth;
  
  const hourMarks = [];
  for (let h = 6; h <= 22; h++) {
    hourMarks.push(`<div class="tl-hour-mark ${h >= 8 && h <= 18 ? 'work' : 'overtime'}" style="left:${(h - 6) * hourWidth}px;">${h}:00</div>`);
  }
  
  const workBgLeft = (8 - 6) * hourWidth;
  const workBgWidth = (18 - 8) * hourWidth;
  
  let lanesHtml = "";
  
  workers.forEach((w) => {
    const workerProjects = items.filter(p => p.assignedWorkerIds.includes(w.id));
    
    const viewDate = new Date(dateStr);
    viewDate.setHours(0, 0, 0, 0);
    const workerLeaves = cache.leaveRecords.filter((lr) => {
      if (lr.workerId !== w.id) return false;
      if (lr.status === "rejected") return false;
      const sd = new Date(lr.startDate);
      sd.setHours(0, 0, 0, 0);
      const ed = new Date(lr.endDate);
      ed.setHours(0, 0, 0, 0);
      return viewDate >= sd && viewDate <= ed;
    });
    
    const workerSchedules = cache.workerSchedules.filter((s) => {
      if (s.workerId !== w.id) return false;
      return s.startDate === dateStr;
    });
    
    let leaveBg = "";
    workerLeaves.forEach((lr) => {
      let leaveLeft = 0, leaveWidth = 0;
      if (lr.startType === "all") {
        leaveLeft = 0;
        leaveWidth = totalWidth;
      } else if (lr.startType === "morning") {
        leaveLeft = (8 - 6) * hourWidth;
        leaveWidth = 4 * hourWidth;
      } else if (lr.startType === "afternoon") {
        leaveLeft = (13 - 6) * hourWidth;
        leaveWidth = 5 * hourWidth;
      } else if (lr.startTime) {
        const [sh, sm] = lr.startTime.split(":").map(Number);
        leaveLeft = ((sh + sm / 60) - 6) * hourWidth;
        if (lr.endTime) {
          const [eh, em] = lr.endTime.split(":").map(Number);
          leaveWidth = ((eh + em / 60) - (sh + sm / 60)) * hourWidth;
        } else {
          leaveWidth = totalWidth - leaveLeft;
        }
      }
      leaveBg += `<div class="tl-bg-leave" style="left:${leaveLeft}px; width:${Math.max(10, leaveWidth)}px; height:100%;"></div>`;
    });
    
    let scheduleBg = "";
    workerSchedules.forEach((s) => {
      let sLeft = 0, sWidth = 0;
      if (s.startTime) {
        const [sh, sm] = s.startTime.split(":").map(Number);
        sLeft = ((sh + sm / 60) - 6) * hourWidth;
        if (s.endTime) {
          const [eh, em] = s.endTime.split(":").map(Number);
          sWidth = ((eh + em / 60) - (sh + sm / 60)) * hourWidth;
        } else {
          sWidth = totalWidth - sLeft;
        }
      } else {
        sLeft = 0;
        sWidth = totalWidth;
      }
      const typeColor = SCHEDULE_TYPE_COLOR[s.type] || "#6b7280";
      scheduleBg += `<div class="tl-bg-schedule" style="left:${sLeft}px; width:${Math.max(10, sWidth)}px; height:100%; background:${typeColor}20;"></div>`;
    });
    
    let tasksHtml = "";
    workerProjects.forEach(p => {
      const start = projectStart(p);
      const end = projectEnd(p) || new Date((start || new Date()).getTime() + (p.estimatedHours || 2) * 3600000);
      
      if (!start) return;
      
      const startMinutes = (start.getHours() - 6) * 60 + start.getMinutes();
      const endMinutes = (end.getHours() - 6) * 60 + end.getMinutes();
      const left = (startMinutes / 60) * hourWidth;
      const width = ((endMinutes - startMinutes) / 60) * hourWidth;
      
      let statusClass, statusIcon;
      if (p.status === STATUS.BOOKED) { statusClass = "booked"; statusIcon = "📅"; }
      else if (p.status === STATUS.WORKING) { statusClass = "working"; statusIcon = "🔨"; }
      else if (p.status === STATUS.PAUSED) { statusClass = "paused"; statusIcon = "⏸️"; }
      else if (p.status === STATUS.DELAYED) { statusClass = "delayed"; statusIcon = "⚠️"; }
      else if (p.status === STATUS.DONE) { statusClass = "done"; statusIcon = "✅"; }
      else if (p.status === STATUS.ACCEPTED) { statusClass = "accepted"; statusIcon = "✅"; }
      else if (p.status === STATUS.REVIEWED) { statusClass = "reviewed"; statusIcon = "✅"; }
      else if (p.status === STATUS.CANCELLED) { statusClass = "cancelled"; statusIcon = "❌"; }
      else { statusClass = ""; statusIcon = ""; }
      
      const pad = (n) => String(n).padStart(2, "0");
      const timeStr = `${pad(start.getHours())}:${pad(start.getMinutes())} ~ ${pad(end.getHours())}:${pad(end.getMinutes())}`;
      
      tasksHtml += `
        <div class="timeline-task timeline-task-${statusClass}" style="left:${left}px; width:${width}px; height:48px;">
          <div class="timeline-task-header">
            <span class="timeline-task-name" style="font-size:11px;">${statusIcon} ${esc(p.name)}</span>
          </div>
          <div class="timeline-task-body" style="font-size:9px;">
            ${esc(storeName(p.storeId))} · ${timeStr} · 需${p.workerCount || 1}人
          </div>
        </div>`;
    });
    
    workerSchedules.forEach(s => {
      let sStart, sEnd;
      if (s.startTime) {
        const [sh, sm] = s.startTime.split(":").map(Number);
        sStart = new Date(dateStr);
        sStart.setHours(sh, sm, 0, 0);
      } else {
        sStart = new Date(dateStr);
        sStart.setHours(8, 0, 0, 0);
      }
      
      if (s.endTime) {
        const [eh, em] = s.endTime.split(":").map(Number);
        sEnd = new Date(dateStr);
        sEnd.setHours(eh, em, 0, 0);
      } else if (s.endDate && s.endDate !== dateStr) {
        sEnd = new Date(dateStr);
        sEnd.setHours(18, 0, 0, 0);
      } else {
        sEnd = new Date(dateStr);
        sEnd.setHours(18, 0, 0, 0);
      }
      
      const startMinutes = (sStart.getHours() - 6) * 60 + sStart.getMinutes();
      const endMinutes = (sEnd.getHours() - 6) * 60 + sEnd.getMinutes();
      const left = (startMinutes / 60) * hourWidth;
      const width = ((endMinutes - startMinutes) / 60) * hourWidth;
      
      const typeColor = SCHEDULE_TYPE_COLOR[s.type] || "#6b7280";
      const pad = (n) => String(n).padStart(2, "0");
      const timeStr = s.startTime && s.endTime 
        ? `${pad(sStart.getHours())}:${pad(sStart.getMinutes())} ~ ${pad(sEnd.getHours())}:${pad(sEnd.getMinutes())}`
        : "全天";
      
      tasksHtml += `
        <div class="timeline-task timeline-task-schedule" style="left:${left}px; width:${width}px; height:48px; background:${typeColor}20; border-color:${typeColor}; border-width:1px;">
          <div class="timeline-task-header">
            <span class="timeline-task-name" style="font-size:11px; color:${typeColor};">📝 ${esc(s.title)}</span>
          </div>
          <div class="timeline-task-body" style="font-size:9px; color:${typeColor};">
            ${SCHEDULE_TYPE_LABEL[s.type] || s.type} · ${timeStr}
          </div>
        </div>`;
    });
    
    const workerInternalTasks = internalTasks.filter(t => t.workerId === w.id);
    workerInternalTasks.forEach(t => {
      const displayStartTime = t.scheduledStartTime || t.actualStartTime;
      const displayEndTime = t.scheduledEndTime || t.actualEndTime;
      if (!displayStartTime || !displayEndTime) return;
      
      const [sh, sm] = displayStartTime.split(":").map(Number);
      const [eh, em] = displayEndTime.split(":").map(Number);
      
      const startMinutes = (sh - 6) * 60 + sm;
      const endMinutes = (eh - 6) * 60 + em;
      const left = (startMinutes / 60) * hourWidth;
      const width = ((endMinutes - startMinutes) / 60) * hourWidth;
      
      const statusIcon = t.status === 'in_progress' ? '🔨' : '📋';
      const statusColor = t.status === 'in_progress' ? '#f59e0b' : '#8b5cf6';
      const pad = (n) => String(n).padStart(2, "0");
      const timeStr = `${pad(sh)}:${pad(sm)} ~ ${pad(eh)}:${pad(em)}`;
      
      tasksHtml += `
        <div class="timeline-task" style="left:${left}px; width:${width}px; height:48px; background:${statusColor}20; border-left:3px solid ${statusColor};">
          <div class="timeline-task-header">
            <span class="timeline-task-name" style="font-size:11px;">${statusIcon} ${esc(t.name)}</span>
          </div>
          <div class="timeline-task-body" style="font-size:9px;">
            ${esc(t.workType)} · ${timeStr} · 预计${t.estHours}h
          </div>
        </div>`;
    });
    
    const leaveBadge = workerLeaves.length > 0 ? `<span class="tl-lane-leave-badge">🩹</span>` : "";
    const scheduleBadge = workerSchedules.length > 0 ? `<span class="tl-lane-schedule-badge">📅</span>` : "";
    
    lanesHtml += `
      <div class="tl-lane" style="height:58px; border-bottom:1px solid #eee; display:flex;">
        <div class="tl-lane-label" style="width:60px; flex-shrink:0; padding:5px; font-size:12px; font-weight:bold;">${esc(w.name)}${leaveBadge}${scheduleBadge}</div>
        <div class="tl-lane-body" style="flex:1; position:relative; height:58px;">
          <div class="tl-bg-work" style="left:${workBgLeft}px; width:${workBgWidth}px; height:100%;"></div>
          <div class="tl-bg-overtime" style="width:${workBgLeft}px; height:100%;"></div>
          <div class="tl-bg-overtime" style="left:${workBgLeft + workBgWidth}px; width:${totalWidth - workBgLeft - workBgWidth}px; height:100%;"></div>
          ${leaveBg}
          ${scheduleBg}
          <div class="tl-tasks">${tasksHtml}</div>
        </div>
      </div>`;
  });
  
  const dateFilter = new Date(dateStr);
  dateFilter.setHours(0, 0, 0, 0);
  const dayLeaveRecords = cache.leaveRecords.filter((lr) => {
    if (lr.status === "rejected") return false;
    const sd = new Date(lr.startDate);
    sd.setHours(0, 0, 0, 0);
    const ed = new Date(lr.endDate);
    ed.setHours(0, 0, 0, 0);
    return dateFilter >= sd && dateFilter <= ed;
  });
  
  let leaveSection = "";
  if (dayLeaveRecords.length > 0) {
    leaveSection = `
      <div class="tl-leave-section" style="margin-top:16px; padding:12px; background:#fef2f2; border-radius:8px; border-left:4px solid #ef4444;">
        <div style="font-weight:600; color:#dc2626; margin-bottom:8px;">🌴 ${dateStr} 请假人员</div>
        <div style="display:flex; flex-direction:column; gap:6px;">
          ${dayLeaveRecords.map((lr) => {
            const w = getWorker(lr.workerId);
            return `<div style="font-size:13px; display:flex; justify-content:space-between; align-items:center;">
              <span>${esc(w ? w.name : lr.workerName || "未知")} · ${formatLeaveTime(lr)}${lr.reason ? ` · ${esc(lr.reason)}` : ""}</span>
              <button class="btn small danger" onclick="deleteLeaveRecord('${lr.id}')" style="padding:2px 6px; font-size:12px;">删除</button>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }
  
  return `
    <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">绿色区域为工作时间(8:00-18:00)，橙色区域为加班时间</div>
    <div class="tl-wrapper" style="width:100%;">
      <div class="timeline-horizontal" style="width:100%; min-width:${totalWidth + 60}px;">
        <div class="tl-axis" style="width:100%; margin-left:60px;">${hourMarks.join("")}</div>
        <div class="tl-scroll" style="max-height:${workers.length * 50 + 50}px;">
          ${lanesHtml}
        </div>
      </div>
    </div>
    ${leaveSection}`;
}

function renderWorkerScheduleForWorker(dateStr) {
  const list = document.getElementById("workerList");
  if (!list) return;
  
  document.body.classList.add("timeline-view");
  
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfterTomorrow = new Date(today);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
  
  const todayStr = fmtDate(today);
  const tomorrowStr = fmtDate(tomorrow);
  const dayAfterStr = fmtDate(dayAfterTomorrow);
  
  const isToday = dateStr === todayStr;
  const isTomorrow = dateStr === tomorrowStr;
  const isDayAfter = dateStr === dayAfterStr;
  
  const currentWorker = cache.workers.find((w) => w.name === currentProfile.name) || 
                        (currentUser ? cache.workers.find((w) => w.id === currentUser.id) : null);
  const workerId = currentWorker ? currentWorker.id : null;

  list.innerHTML = `
    <div id="workerScheduleSection" style="margin-bottom: 16px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <p class="hint" style="font-size:12px; margin:0;">📅 ${dateStr} 施工人员时间安排</p>
        <div style="display:flex; gap:4px;">
          <button class="btn small ${isToday ? 'primary' : ''}" onclick="renderWorkerScheduleForWorker('${todayStr}')">今天</button>
          <button class="btn small ${isTomorrow ? 'primary' : ''}" onclick="renderWorkerScheduleForWorker('${tomorrowStr}')">明天</button>
          <button class="btn small ${isDayAfter ? 'primary' : ''}" onclick="renderWorkerScheduleForWorker('${dayAfterStr}')">后天</button>
          ${workerId ? `<button class="btn small" onclick="openLeaveForm('${workerId}')" style="background:#ef4444;color:#fff">🌴 请假</button>` : ""}
        </div>
      </div>
    </div>
    <div id="workerScheduleView"></div>`;
  
  setTimeout(() => {
    const timelineHtml = renderWorkerScheduleHtml(dateStr);
    const container = document.getElementById("workerScheduleView");
    if (container) {
      container.innerHTML = timelineHtml;
    }
  }, 100);
}

function renderWorkerSchedule(dateStr, workerId = null) {
  const container = document.getElementById("workerScheduleView");
  if (!container) return;
  
  const timelineHtml = renderWorkerScheduleHtml(dateStr, workerId);
  
  container.innerHTML = timelineHtml;
  container.style.display = 'block';
  container.style.marginBottom = '20px';
}

function workerForm(w = {}) {
  return `
    <div class="form-row">
      <label>姓名 *</label>
      <input class="input" id="wName" value="${esc(w.name || "")}" placeholder="施工人员姓名" />
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label>联系电话</label>
        <input class="input" id="wPhone" value="${esc(w.phone || "")}" placeholder="手机号" />
      </div>
      <div class="form-row">
        <label>工种 / 角色</label>
        <input class="input" id="wRole" value="${esc(w.role || "")}" placeholder="如：安装工、电工" />
      </div>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="modal.close()">取消</button>
      <button class="btn primary" onclick="saveWorker('${w.id || ""}')">保存</button>
    </div>`;
}

function newWorker() { 
  if (!perm.addWorker()) { toast("权限不足"); return; }
  modal.open("添加施工人员", workerForm()); 
}
function editWorker(id) { 
  if (!perm.editWorker()) { toast("权限不足"); return; }
  modal.open("编辑施工人员", workerForm(getWorker(id))); 
}

async function saveWorker(id) {
  const name = document.getElementById("wName").value.trim();
  if (!name) { toast("请填写姓名"); return; }
  const payload = {
    name,
    phone: document.getElementById("wPhone").value.trim(),
    role: document.getElementById("wRole").value.trim(),
  };
  await repo.saveWorker(payload, id);
  await repo.loadAll();
  modal.close();
  renderAll();
  toast("已保存");
}

async function deleteWorker(id) {
  if (!perm.deleteWorker()) { toast("权限不足"); return; }
  const used = cache.projects.some((p) => (p.workLogs || []).some((l) => l.workerId === id));
  if (used && !(await confirmDialog("该人员已有施工工时记录，删除不会移除历史记录。确定删除该人员？", "删除人员"))) return;
  if (!used && !(await confirmDialog("确定删除该人员？", "删除人员"))) return;
  await repo.deleteWorker(id);
  await repo.loadAll();
  renderAll();
  toast("已删除");
}

/* ============================================================
 * 外协人员管理模块
 * ============================================================ */
function renderOutsourcedWorkers() {
  const list = document.getElementById("outsourcedWorkerList");
  if (!list) return;
  
  if (cache.outsourcedWorkers.length === 0) {
    list.innerHTML = `<div class="empty">暂无外协人员，点击右上角「添加外协人员」创建。</div>`;
    return;
  }
  
  list.innerHTML = cache.outsourcedWorkers.map((w) => `
    <div class="card">
      <div class="card-title">
        <h3>${esc(w.name)}</h3>
        <span class="badge" style="background:#8b5cf6;color:#fff;">外协</span>
      </div>
      <div class="card-row"><span>联系电话</span><b>${esc(w.phone || "—")}</b></div>
      <div class="card-actions">
        ${perm.manageOutsourced() ? `<button class="btn small" onclick="editOutsourcedWorker('${w.id}')">编辑</button><button class="btn small danger" onclick="deleteOutsourcedWorker('${w.id}')">删除</button>` : ""}
      </div>
    </div>`).join("");
}

function outsourcedWorkerForm(w = {}) {
  return `
    <div class="form-row">
      <label>姓名 *</label>
      <input class="input" id="owName" value="${esc(w.name || "")}" placeholder="外协人员姓名" />
    </div>
    <div class="form-row">
      <label>联系电话</label>
      <input class="input" id="owPhone" value="${esc(w.phone || "")}" placeholder="手机号" />
    </div>
    <div class="form-actions">
      <button class="btn" onclick="modal.close()">取消</button>
      <button class="btn primary" onclick="saveOutsourcedWorker('${w.id || ""}')">保存</button>
    </div>`;
}

function newOutsourcedWorker() { 
  if (!perm.manageOutsourced()) { toast("权限不足"); return; }
  modal.open("添加外协人员", outsourcedWorkerForm()); 
}
function editOutsourcedWorker(id) { 
  if (!perm.manageOutsourced()) { toast("权限不足"); return; }
  modal.open("编辑外协人员", outsourcedWorkerForm(getOutsourcedWorker(id))); 
}

async function saveOutsourcedWorker(id) {
  const name = document.getElementById("owName").value.trim();
  if (!name) { toast("请填写姓名"); return; }
  const payload = {
    name,
    phone: document.getElementById("owPhone").value.trim(),
  };
  await repo.saveOutsourcedWorker(payload, id);
  await repo.loadAll();
  modal.close();
  renderAll();
  toast("已保存");
}

async function deleteOutsourcedWorker(id) {
  if (!perm.manageOutsourced()) { toast("权限不足"); return; }
  if (!(await confirmDialog("确定删除该外协人员？", "删除外协人员"))) return;
  await repo.deleteOutsourcedWorker(id);
  await repo.loadAll();
  renderAll();
  toast("已删除");
}

/* ============================================================
 * 施工人员个人日程模块
 * ============================================================ */
const SCHEDULE_TYPE_LABEL = {
  personal: "个人事务",
  company: "公司安排",
  training: "培训学习",
  standby: "待命",
  equipment: "设备维护",
  meeting: "会议",
  warehouse: "仓库工作",
  delivery: "送货",
  outsideInstall: "外出安装",
  internalOther: "内部其他",
  other: "其他"
};

const SCHEDULE_TYPE_COLOR = {
  personal: "#ef4444",
  company: "#2563eb",
  training: "#8b5cf6",
  standby: "#6b7280",
  equipment: "#0891b2",
  meeting: "#d97706",
  warehouse: "#f97316",
  delivery: "#eab308",
  outsideInstall: "#22c55e",
  internalOther: "#a855f7",
  other: "#16a34a"
};

let scheduleCalendarDate = (function() { const d = new Date(); d.setHours(12, 0, 0, 0); return d; })();
let scheduleSelectedDate = null;

function getFilteredSchedules() {
  let filtered = cache.workerSchedules;
  const workerFilter = document.getElementById("scheduleWorkerFilter");
  const typeFilter = document.getElementById("scheduleTypeFilter");
  if (workerFilter && workerFilter.value) {
    filtered = filtered.filter(s => s.workerId === workerFilter.value);
  }
  if (typeFilter && typeFilter.value) {
    filtered = filtered.filter(s => s.type === typeFilter.value);
  }
  return filtered;
}

function renderScheduleCalendar() {
  const container = document.getElementById("scheduleCalendar");
  if (!container) return;

  const y = scheduleCalendarDate.getFullYear();
  const m = scheduleCalendarDate.getMonth();
  const todayKey = dateKey(new Date());
  const selectedStr = scheduleSelectedDate || todayKey;

  const startWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrevMonth = new Date(y, m, 0).getDate();

  const filtered = getFilteredSchedules();
  const schedulesByDate = {};
  filtered.forEach(function(s) {
    if (!schedulesByDate[s.startDate]) schedulesByDate[s.startDate] = [];
    schedulesByDate[s.startDate].push(s);
  });

  const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

  let cells = "";

  for (let i = startWeekday - 1; i >= 0; i--) {
    cells += '<div class="sched-cal-cell other-month"><span class="sched-cal-day">' + (daysInPrevMonth - i) + '</span></div>';
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = dateKey(new Date(y, m, d));
    const daySchedules = schedulesByDate[dateStr] || [];
    const isToday = dateStr === todayKey;
    const isSelected = dateStr === selectedStr;
    const isWeekend = new Date(y, m, d).getDay() === 0 || new Date(y, m, d).getDay() === 6;
    const isHolidayDate = isHoliday(dateStr);
    const maxShow = 3;
    const showSchedules = daySchedules.slice(0, maxShow);
    const itemsHtml = showSchedules.map(function(s) {
      const color = SCHEDULE_TYPE_COLOR[s.type] || "#6b7280";
      const timeStr = s.startTime ? s.startTime : "全天";
      const label = SCHEDULE_TYPE_LABEL[s.type] || s.type;
      const worker = getWorker(s.workerId);
      const workerName = worker ? worker.name : "";
      const surname = workerName ? workerName.charAt(0) : "";
      return '<div class="sched-cal-item-wrap">' +
        (surname ? '<span class="sched-cal-item-user" style="background:' + color + '">' + esc(surname) + '</span>' : '') +
        '<div class="sched-cal-item" style="background:' + color + '" title="' + esc(s.title) + '（' + label + '）' + (workerName ? ' - ' + esc(workerName) : '') + '">' +
        timeStr + ' ' + esc(s.title) + '</div></div>';
    }).join("");
    const moreLabel = daySchedules.length > maxShow ? '<div class="sched-cal-more-text">+' + (daySchedules.length - maxShow) + '更多</div>' : "";
    const cls = "sched-cal-cell" + (isToday ? " today" : "") + (isSelected ? " selected" : "") + (isWeekend ? " weekend" : "") + (isHolidayDate ? " holiday" : "") + (daySchedules.length > 0 ? " has" : "");
    cells += '<div class="' + cls + '" onclick="selectScheduleDate(\'' + dateStr + '\')">' +
      '<span class="sched-cal-day">' + d + '</span>' +
      (daySchedules.length > 0 ? '<div class="sched-cal-items">' + itemsHtml + moreLabel + '</div>' : '') +
      '<span class="sched-cal-plus" onclick="event.stopPropagation();newWorkerScheduleForDate(\'' + dateStr + '\')">+</span>' +
      '</div>';
  }

  const totalCells = startWeekday + daysInMonth;
  const trailing = (7 - totalCells % 7) % 7;
  for (let i = 1; i <= trailing; i++) {
    cells += '<div class="sched-cal-cell other-month"><span class="sched-cal-day">' + i + '</span></div>';
  }

  const wdHtml = weekdays.map(function(w) { return '<div class="sched-cal-wd">' + w + '</div>'; }).join("");
  container.innerHTML = '<div class="sched-cal">' +
    '<div class="sched-cal-header">' +
      '<button class="btn small" onclick="changeScheduleMonth(-1)">&#8249;</button>' +
      '<span class="sched-cal-title">' + y + '年 ' + monthNames[m] + '</span>' +
      '<button class="btn small" onclick="changeScheduleMonth(1)">&#8250;</button>' +
      '<button class="btn small" onclick="goScheduleToday()" style="margin-left:8px;">今天</button>' +
    '</div>' +
    '<div class="sched-cal-weekdays">' + wdHtml + '</div>' +
    '<div class="sched-cal-grid">' + cells + '</div>' +
  '</div>';
}

function changeScheduleMonth(delta) {
  scheduleCalendarDate.setMonth(scheduleCalendarDate.getMonth() + delta);
  renderScheduleCalendar();
}

function goScheduleToday() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  scheduleCalendarDate = d;
  scheduleSelectedDate = dateKey(new Date());
  renderScheduleCalendar();
  renderScheduleList();
}

function selectScheduleDate(dateStr) {
  scheduleSelectedDate = dateStr;
  renderScheduleCalendar();
  renderScheduleList();
}

function newWorkerScheduleForDate(dateStr) {
  const s = { startDate: dateStr, endDate: dateStr };
  modal.open("添加日程", workerScheduleForm(s));
}

function renderScheduleList() {
  const list = document.getElementById("scheduleList");
  if (!list) return;

  const selectedStr = scheduleSelectedDate || dateKey(new Date());
  const filtered = getFilteredSchedules();
  const daySchedules = filtered.filter(s => s.startDate <= selectedStr && s.endDate >= selectedStr);

  const [yy, mm, dd] = selectedStr.split("-").map(Number);
  const dateObj = new Date(yy, mm - 1, dd);
  const dateLabel = `${mm}月${dd}日`;
  const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  let html = `<div class="sched-list-header">
    <span class="sched-list-date">📋 ${dateLabel} ${weekdayNames[dateObj.getDay()]}</span>
    <span class="sched-list-count">${daySchedules.length} 项日程</span>
    <button class="btn small primary" onclick="newWorkerScheduleForDate('${selectedStr}')">+ 添加</button>
  </div>`;

  if (daySchedules.length === 0) {
    html += `<div class="sched-empty">当天暂无日程，点击「+ 添加」创建</div>`;
  } else {
    daySchedules.sort((a, b) => (a.startTime || "00:00").localeCompare(b.startTime || "00:00"));
    html += `<div class="sched-list">`;
    daySchedules.forEach(s => {
      const w = getWorker(s.workerId);
      const typeColor = SCHEDULE_TYPE_COLOR[s.type] || "#6b7280";
      const timeStr = s.startTime && s.endTime
        ? `${s.startTime}~${s.endTime}`
        : s.startTime
        ? `${s.startTime}起`
        : "全天";
      const isMultiDay = s.startDate !== s.endDate;
      html += `
        <div class="sched-item" style="border-left-color:${typeColor};">
          <div class="sched-item-time">${timeStr}${isMultiDay ? " ⏶" : ""}</div>
          <div class="sched-item-body" onclick="editWorkerSchedule('${s.id}')">
            <div class="sched-item-title">${esc(s.title)}</div>
            <div class="sched-item-meta">
              <span class="sched-item-type" style="color:${typeColor};">${SCHEDULE_TYPE_LABEL[s.type] || s.type}</span>
              <span>${esc(w ? w.name : s.workerName || "—")}</span>
              ${s.description ? `<span class="sched-item-desc">${esc(s.description)}</span>` : ""}
            </div>
          </div>
          <button class="sched-item-del" onclick="deleteWorkerSchedule('${s.id}')">✕</button>
        </div>`;
    });
    html += `</div>`;
  }

  list.innerHTML = html;
}

function renderWorkerSchedules() {
  renderScheduleCalendar();
  renderScheduleList();
}

function workerScheduleForm(s = {}) {
  const workerOptions = cache.workers.map(w => 
    `<option value="${esc(w.id)}" ${s.workerId === w.id ? 'selected' : ''}>${esc(w.name)}</option>`
  ).join("");
  
  const typeOptions = Object.entries(SCHEDULE_TYPE_LABEL).map(([key, label]) =>
    `<option value="${key}" ${s.type === key ? 'selected' : ''}>${label}</option>`
  ).join("");

  const today = new Date();
  const todayStr = dateKey(today);
  
  const nowHour = String(today.getHours()).padStart(2, "0");
  const nowMinute = String(Math.floor(today.getMinutes() / 10) * 10).padStart(2, "0");
  const nowTime = `${nowHour}:${nowMinute}`;
  
  const endHour = String(Math.min(23, today.getHours() + 2)).padStart(2, "0");
  const endTime = `${endHour}:${nowMinute}`;

  const defaultStartDate = s.startDate || todayStr;
  const defaultEndDate = s.endDate || s.startDate || todayStr;
  const defaultStartTime = s.startTime || nowTime;
  const defaultEndTime = s.endTime || endTime;

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:12px;font-weight:600;color:#333;">施工人员 *</label>
        <select class="input" id="wsWorkerId" style="padding:4px 6px;font-size:13px;">
          ${workerOptions}
        </select>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:12px;font-weight:600;color:#333;">日程类型</label>
        <select class="input" id="wsType" style="padding:4px 6px;font-size:13px;">
          ${typeOptions}
        </select>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;">
      <label style="font-size:12px;font-weight:600;color:#333;">日程标题 *</label>
      <input class="input" id="wsTitle" value="${esc(s.title || "")}" placeholder="如：培训、体检、待命等" style="padding:4px 6px;font-size:13px;" />
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:12px;font-weight:600;color:#333;">开始日期 *</label>
        <input class="input" type="date" id="wsStartDate" value="${esc(defaultStartDate)}" onchange="onScheduleDateChange()" style="padding:4px 6px;font-size:13px;" />
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:12px;font-weight:600;color:#333;">开始时间</label>
        <select class="input" id="wsStartTime" onchange="onScheduleTimeChange()" style="padding:4px 6px;font-size:13px;">
          ${generateTimeOptions(defaultStartTime)}
        </select>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:12px;font-weight:600;color:#333;">结束日期 *</label>
        <input class="input" type="date" id="wsEndDate" value="${esc(defaultEndDate)}" style="padding:4px 6px;font-size:13px;" />
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <label style="font-size:12px;font-weight:600;color:#333;">结束时间</label>
        <select class="input" id="wsEndTime" style="padding:4px 6px;font-size:13px;">
          ${generateTimeOptions(defaultEndTime)}
        </select>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <input type="checkbox" id="wsAllDay" ${(!s.startTime && !s.endTime && !s.id) ? '' : ((!s.startTime && !s.endTime) ? 'checked' : '')} onchange="toggleAllDaySchedule()" style="width:16px;height:16px;" />
      <label for="wsAllDay" style="font-size:13px;color:#333;cursor:pointer;">设为全天日程</label>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;">
      <label style="font-size:12px;font-weight:600;color:#333;">备注</label>
      <textarea class="input" id="wsDescription" placeholder="备注信息" rows="2" style="padding:4px 6px;font-size:13px;">${esc(s.description || "")}</textarea>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <input type="checkbox" id="wsCreateTask" onchange="toggleScheduleTaskFields()" style="width:16px;height:16px;" />
      <label for="wsCreateTask" style="font-size:13px;color:#333;cursor:pointer;">同时生成内部任务（计入工时统计）</label>
    </div>
    <div id="wsTaskFields" style="display:none;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:12px;font-weight:600;color:#333;">工时等级</label>
          <select class="input" id="wsTaskLevel" style="padding:4px 6px;font-size:13px;">
            <option value="初级">初级</option>
            <option value="中级" selected>中级</option>
            <option value="高级">高级</option>
            <option value="特级">特级</option>
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <label style="font-size:12px;font-weight:600;color:#333;">预计工时(小时)</label>
          <input class="input" type="number" min="0" step="0.1" id="wsTaskEstHours" placeholder="自动计算" style="padding:4px 6px;font-size:13px;" />
        </div>
      </div>
    </div>
    <div class="form-actions" style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn" onclick="modal.close()" style="padding:6px 16px;font-size:13px;">取消</button>
      <button class="btn primary" onclick="saveWorkerSchedule('${s.id || ""}')" style="padding:6px 16px;font-size:13px;">保存</button>
    </div>`;
}

function onScheduleDateChange() {
  const startDate = document.getElementById("wsStartDate");
  const endDate = document.getElementById("wsEndDate");
  if (startDate && endDate && endDate.value < startDate.value) {
    endDate.value = startDate.value;
  }
}

function onScheduleTimeChange() {
  const startTime = document.getElementById("wsStartTime");
  const endTime = document.getElementById("wsEndTime");
  if (startTime && endTime) {
    const startVal = startTime.value;
    const endVal = endTime.value;
    if (endVal && startVal > endVal) {
      const [sh, sm] = startVal.split(":").map(Number);
      let eh = sh + 2;
      if (eh > 23) eh = 23;
      endTime.value = `${String(eh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`;
    }
  }
}

function toggleScheduleTaskFields() {
  const createTask = document.getElementById("wsCreateTask");
  const taskFields = document.getElementById("wsTaskFields");
  if (createTask && taskFields) {
    taskFields.style.display = createTask.checked ? "block" : "none";
    if (createTask.checked) {
      calculateScheduleEstHours();
    }
  }
}

function calculateScheduleEstHours() {
  const startTime = document.getElementById("wsStartTime");
  const endTime = document.getElementById("wsEndTime");
  const estHours = document.getElementById("wsTaskEstHours");
  if (!startTime || !endTime || !estHours) return;
  
  const startVal = startTime.value;
  const endVal = endTime.value;
  if (!startVal || !endVal) return;
  
  const [startH, startM] = startVal.split(":").map(Number);
  const [endH, endM] = endVal.split(":").map(Number);
  
  let diffMinutes = (endH * 60 + endM) - (startH * 60 + startM);
  if (diffMinutes < 0) diffMinutes += 24 * 60;
  
  estHours.value = (diffMinutes / 60).toFixed(1);
}

function toggleAllDaySchedule() {
  const allDay = document.getElementById("wsAllDay");
  const startTime = document.getElementById("wsStartTime");
  const endTime = document.getElementById("wsEndTime");
  
  if (allDay && startTime && endTime) {
    if (allDay.checked) {
      startTime.value = "08:00";
      endTime.value = "18:00";
      startTime.disabled = true;
      endTime.disabled = true;
    } else {
      const now = new Date();
      const nowHour = String(now.getHours()).padStart(2, "0");
      const nowMinute = String(Math.floor(now.getMinutes() / 10) * 10).padStart(2, "0");
      startTime.value = `${nowHour}:${nowMinute}`;
      const endHour = String(Math.min(23, now.getHours() + 2)).padStart(2, "0");
      endTime.value = `${endHour}:${nowMinute}`;
      startTime.disabled = false;
      endTime.disabled = false;
    }
  }
}

function newWorkerSchedule() {
  modal.open("添加日程", workerScheduleForm());
}

function newWorkerScheduleForWorker(workerId) {
  const w = getWorker(workerId);
  if (!w) return;
  modal.open(`为 ${w.name} 添加日程`, workerScheduleForm({ workerId, workerName: w.name }));
}

function editWorkerSchedule(id) {
  const s = getWorkerSchedule(id);
  if (!s) return;
  modal.open("编辑日程", workerScheduleForm(s));
}

async function saveWorkerSchedule(id) {
  const workerId = document.getElementById("wsWorkerId").value;
  const title = document.getElementById("wsTitle").value.trim();
  const startDate = document.getElementById("wsStartDate").value;
  const endDate = document.getElementById("wsEndDate").value;
  
  if (!title) { toast("请填写日程标题"); return; }
  if (!startDate) { toast("请填写开始日期"); return; }
  if (!endDate) { toast("请填写结束日期"); return; }
  
  const w = getWorker(workerId);
  
  const payload = {
    workerId,
    workerName: w ? w.name : "",
    title,
    type: document.getElementById("wsType").value,
    startDate,
    startTime: document.getElementById("wsStartTime").value,
    endDate,
    endTime: document.getElementById("wsEndTime").value,
    description: document.getElementById("wsDescription").value.trim(),
    createdBy: currentUser ? currentUser.id : null,
    createdByName: currentProfile.name || currentUser?.email || null,
  };
  
  await repo.saveWorkerSchedule(payload, id);
  await repo.loadAll();
  
  const createTask = document.getElementById("wsCreateTask");
  if (createTask && createTask.checked) {
    const scheduleTypeMap = {
      warehouse: "仓库工作",
      delivery: "送货",
      outsideInstall: "外出安装",
      internalOther: "其他",
      company: "仓库工作",
      meeting: "其他",
      equipment: "设备维护",
      standby: "待命",
      training: "培训学习"
    };
    
    const workType = scheduleTypeMap[payload.type] || "其他";
    const level = document.getElementById("wsTaskLevel").value;
    let estHours = Number(document.getElementById("wsTaskEstHours").value);
    
    if (!estHours || estHours <= 0) {
      const startTime = payload.startTime || "08:00";
      const endTime = payload.endTime || "18:00";
      const [startH, startM] = startTime.split(":").map(Number);
      const [endH, endM] = endTime.split(":").map(Number);
      let diffMinutes = (endH * 60 + endM) - (startH * 60 + startM);
      if (diffMinutes < 0) diffMinutes += 24 * 60;
      estHours = Math.max(0.1, diffMinutes / 60);
    }
    
    addInternalTask({
      name: payload.title,
      workType: workType,
      level: level,
      workerId: payload.workerId,
      workerName: payload.workerName,
      date: payload.startDate,
      scheduledStartTime: payload.startTime || "08:00",
      scheduledEndTime: payload.endTime || "18:00",
      estHours: estHours,
      note: payload.description || ""
    });
    
    toast("日程已保存，同时已生成内部任务");
  } else {
    toast("已保存");
  }
  
  modal.close();
  renderAll();
}

async function deleteWorkerSchedule(id) {
  if (!(await confirmDialog("确定删除该日程？", "删除日程"))) return;
  await repo.deleteWorkerSchedule(id);
  await repo.loadAll();
  renderAll();
  toast("已删除");
}

function initScheduleFilters() {
  const workerFilter = document.getElementById("scheduleWorkerFilter");
  const typeFilter = document.getElementById("scheduleTypeFilter");

  if (workerFilter) {
    workerFilter.innerHTML = `<option value="">全部人员</option>` +
      cache.workers.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("");
    workerFilter.onchange = renderWorkerSchedules;
  }

  if (typeFilter) {
    typeFilter.innerHTML = `<option value="">全部类型</option>` +
      Object.entries(SCHEDULE_TYPE_LABEL).map(([key, label]) =>
        `<option value="${key}">${label}</option>`
      ).join("");
    typeFilter.onchange = renderWorkerSchedules;
  }
}

const LEAVE_TYPE_LABEL = {
  personal: "事假",
  sick: "病假",
  annual: "年假",
  comp: "调休",
  other: "其他"
};

const LEAVE_STATUS_LABEL = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝"
};

function openLeaveForm(workerId) {
  const w = getWorker(workerId);
  if (!w) return;
  const today = dateKey(new Date());
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return dateKey(d); })();
  const form = `
    <div class="repair-form">
      <div class="form-row">
        <label>施工人员</label>
        <div class="input" style="background:#f3f4f6;cursor:not-allowed;">${esc(w.name)}</div>
        <input type="hidden" id="leaveWorkerId" value="${esc(workerId)}" />
        <input type="hidden" id="leaveWorkerName" value="${esc(w.name)}" />
      </div>
      <div class="form-row">
        <label>请假类型 *</label>
        <select class="input" id="leaveType">
          <option value="personal">事假</option>
          <option value="sick">病假</option>
          <option value="annual">年假</option>
          <option value="comp">调休</option>
          <option value="other">其他</option>
        </select>
      </div>
      <div class="form-row" id="leaveQuotaHint" style="display:none;background:#fef3c7;border-left:3px solid #f59e0b;padding:10px 15px;border-radius:4px;">
        <span style="font-weight:bold;color:#f59e0b">⚠️ 额度提示：</span>
        <span id="leaveQuotaText" style="color:#92400e"></span>
      </div>
      
      <div class="form-row">
        <label>快捷选择</label>
        <div class="quick-time-select">
          <button class="btn small" onclick="setLeaveQuickTime('${today}', '08:00', '${today}', '18:00')">今天全天</button>
          <button class="btn small" onclick="setLeaveQuickTime('${today}', '08:00', '${today}', '12:00')">今天上午</button>
          <button class="btn small" onclick="setLeaveQuickTime('${today}', '13:00', '${today}', '18:00')">今天下午</button>
          <button class="btn small" onclick="setLeaveQuickTime('${today}', '08:00', '${tomorrow}', '18:00')">2天</button>
          <button class="btn small" onclick="setLeaveQuickTime('${today}', '08:00', '${today}', '10:00')">2小时</button>
          <button class="btn small" onclick="setLeaveQuickTime('${today}', '14:00', '${today}', '18:00')">半天</button>
        </div>
      </div>
      
      <div class="form-row">
        <label>📅 开始时间 *</label>
        <div class="leave-datetime-row">
          <input class="input" type="date" id="leaveStartDate" value="${today}" min="${today}" />
          <input class="input" type="time" id="leaveStartTime" value="08:00" />
        </div>
      </div>
      
      <div class="form-row">
        <label>📅 结束时间 *</label>
        <div class="leave-datetime-row">
          <input class="input" type="date" id="leaveEndDate" value="${tomorrow}" min="${today}" />
          <input class="input" type="time" id="leaveEndTime" value="18:00" />
        </div>
      </div>
      
      <div class="leave-calendar-preview">
        <div class="leave-calendar-header">📅 请假日期预览</div>
        <div class="leave-calendar-grid" id="leaveCalendarGrid"></div>
      </div>
      
      <div class="form-row" id="leaveDurationHint" style="background:#f0f9ff;border-left:3px solid var(--primary);padding:10px 15px;margin:12px 0;border-radius:4px;">
        <span style="font-weight:bold;color:var(--primary)">⏱️ 请假时长：</span>
        <span id="leaveDurationText" style="color:#6b7280;">请选择时间</span>
      </div>
      <div class="form-row" id="leaveConflictHint" style="display:none;background:#fef2f2;border-left:3px solid #dc2626;padding:10px 15px;border-radius:4px;">
        <span style="font-weight:bold;color:#dc2626">❌ 冲突提示：</span>
        <div id="leaveConflictText" style="color:#991b1b;margin-top:4px;"></div>
      </div>
      <div class="form-row">
        <label>请假原因</label>
        <textarea class="input" id="leaveReason" placeholder="请填写请假原因"></textarea>
      </div>
      <div class="form-actions">
        <button class="btn" onclick="modal.close()">取消</button>
        <button class="btn primary" onclick="submitLeaveForm()">提交请假申请</button>
      </div>
    </div>`;
  modal.open("📅 请假申请", form);
  document.getElementById("leaveStartDate").addEventListener("change", function() {
    updateLeaveEndDateMin();
    updateLeaveDuration();
    checkLeaveQuotaAndConflict();
    updateLeaveCalendarPreview();
  });
  document.getElementById("leaveStartTime").addEventListener("change", function() {
    updateLeaveDuration();
    checkLeaveQuotaAndConflict();
    updateLeaveCalendarPreview();
  });
  document.getElementById("leaveEndDate").addEventListener("change", function() {
    updateLeaveDuration();
    checkLeaveQuotaAndConflict();
    updateLeaveCalendarPreview();
  });
  document.getElementById("leaveEndTime").addEventListener("change", function() {
    updateLeaveDuration();
    checkLeaveQuotaAndConflict();
    updateLeaveCalendarPreview();
  });
  document.getElementById("leaveType").addEventListener("change", checkLeaveQuotaAndConflict);
  updateLeaveDuration();
  checkLeaveQuotaAndConflict();
  updateLeaveCalendarPreview();
}

function setLeaveQuickTime(startDateStr, startTimeStr, endDateStr, endTimeStr) {
  document.getElementById("leaveStartDate").value = startDateStr;
  document.getElementById("leaveStartTime").value = startTimeStr;
  document.getElementById("leaveEndDate").value = endDateStr;
  document.getElementById("leaveEndTime").value = endTimeStr;
  
  updateLeaveDuration();
  checkLeaveQuotaAndConflict();
  updateLeaveCalendarPreview();
}

function updateLeaveCalendarPreview() {
  const startDate = document.getElementById("leaveStartDate").value;
  const startTime = document.getElementById("leaveStartTime").value;
  const endDate = document.getElementById("leaveEndDate").value;
  const endTime = document.getElementById("leaveEndTime").value;
  const grid = document.getElementById("leaveCalendarGrid");
  
  if (!startDate || !endDate) {
    grid.innerHTML = "";
    return;
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  const dates = [];
  
  const current = new Date(start);
  while (current <= end) {
    const isStart = current.getTime() === start.getTime();
    const isEnd = current.getTime() === end.getTime();
    let timeInfo = "";
    if (isStart && isEnd) {
      timeInfo = `${startTime} - ${endTime}`;
    } else if (isStart) {
      timeInfo = `${startTime} - 18:00`;
    } else if (isEnd) {
      timeInfo = `08:00 - ${endTime}`;
    } else {
      timeInfo = "全天";
    }
    
    dates.push({
      date: dateKey(current),
      day: current.getDate(),
      weekday: ["日", "一", "二", "三", "四", "五", "六"][current.getDay()],
      isStart,
      isEnd,
      isWeekend: current.getDay() === 0 || current.getDay() === 6,
      isHoliday: isHoliday(dateKey(current)),
      timeInfo
    });
    current.setDate(current.getDate() + 1);
  }
  
  grid.innerHTML = dates.map(d => `
    <div class="leave-calendar-day ${d.isWeekend ? 'weekend' : ''} ${d.isHoliday ? 'holiday' : ''}">
      <div class="leave-calendar-day-num">${d.day}</div>
      <div class="leave-calendar-day-week">周${d.weekday}</div>
      <div class="leave-calendar-day-type">${d.timeInfo}</div>
    </div>
  `).join("");
}

function updateLeaveEndDateMin() {
  const startDate = document.getElementById("leaveStartDate").value;
  const endDateEl = document.getElementById("leaveEndDate");
  if (startDate && endDateEl) {
    endDateEl.min = startDate;
  }
}

function checkLeaveQuotaAndConflict() {
  const workerId = document.getElementById("leaveWorkerId").value;
  const leaveType = document.getElementById("leaveType").value;
  const startDate = document.getElementById("leaveStartDate").value;
  const startTime = document.getElementById("leaveStartTime").value;
  const endDate = document.getElementById("leaveEndDate").value;
  const endTime = document.getElementById("leaveEndTime").value;
  
  const quotaHint = document.getElementById("leaveQuotaHint");
  const quotaText = document.getElementById("leaveQuotaText");
  const conflictHint = document.getElementById("leaveConflictHint");
  const conflictText = document.getElementById("leaveConflictText");
  
  quotaHint.style.display = "none";
  conflictHint.style.display = "none";
  
  if (!startDate || !endDate) return;
  
  const conflicts = checkLeaveProjectConflict(workerId, startDate, endDate, startTime, endTime);
  if (conflicts.length > 0) {
    conflictHint.style.display = "block";
    conflictText.innerHTML = `检测到 ${conflicts.length} 个项目排期冲突：<ul style="margin:6px 0 0 16px;padding:0;">${conflicts.map(p => {
      const store = getStore(p.storeId);
      const storeName = store ? store.name : "未知门店";
      return `<li style="margin-bottom:3px;">📋 ${p.name}（${storeName}）</li>`;
    }).join("")}</ul>`;
  }
  
  if (leaveType === "other") return;
  
  const usedDays = calculateUsedLeaveDays(workerId, leaveType);
  const quota = getLeaveQuota(workerId);
  const requestedDays = calculateLeaveDays(startDate, endDate);
  
  let quotaField = "";
  if (leaveType === "personal") quotaField = quota.personal_days || 15;
  else if (leaveType === "sick") quotaField = quota.sick_days || 30;
  else if (leaveType === "annual") quotaField = quota.annual_days || 10;
  else if (leaveType === "comp") quotaField = quota.comp_days || 0;
  
  const remaining = Math.max(0, quotaField - usedDays);
  if (requestedDays > remaining) {
    quotaHint.style.display = "block";
    quotaText.textContent = `${LEAVE_TYPE_LABEL[leaveType]}额度不足！已使用 ${usedDays.toFixed(1)} 天，剩余 ${remaining.toFixed(1)} 天，本次申请 ${requestedDays.toFixed(1)} 天`;
  } else if (remaining <= 3) {
    quotaHint.style.display = "block";
    quotaText.textContent = `${LEAVE_TYPE_LABEL[leaveType]}剩余额度较少：${remaining.toFixed(1)} 天`;
  }
}

function checkLeaveProjectConflict(workerId, startDate, endDate, startTime = null, endTime = null) {
  const startDt = new Date(`${startDate}T${startTime || "08:00"}`);
  const endDt = new Date(`${endDate}T${endTime || "18:00"}`);
  
  return cache.projects.filter(p => {
    const workerIds = p.assignedWorkerIds || p.assignedWorkers || [];
    if (!workerIds.includes(workerId)) return false;
    if (isCompleted(p)) return false;
    
    const pStart = projectStart(p);
    if (!pStart) return false;
    
    const pEnd = projectEnd(p);
    if (!pEnd) return false;
    
    return pStart < endDt && pEnd > startDt;
  });
}

function isHoliday(dateStr) {
  const holiday = cache.holidays.find(h => h.date === dateStr);
  if (!holiday) return false;
  return !holiday.is_workday;
}

function isWorkDay(dateStr) {
  const date = new Date(dateStr);
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    const holiday = cache.holidays.find(h => h.date === dateStr);
    return holiday && holiday.is_workday;
  }
  return !isHoliday(dateStr);
}

function calculateLeaveDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let workDays = 0;
  const current = new Date(start);
  
  while (current <= end) {
    const dateStr = current.toISOString().split("T")[0];
    if (isWorkDay(dateStr)) {
      workDays++;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return workDays;
}

function calculateUsedLeaveDays(workerId, leaveType) {
  const year = new Date().getFullYear().toString();
  return cache.leaveRecords
    .filter(l => l.workerId === workerId && l.status === "approved" && l.leaveType === leaveType)
    .reduce((sum, l) => sum + calculateLeaveDays(l.startDate, l.endDate), 0);
}

function getLeaveQuota(workerId) {
  const year = new Date().getFullYear().toString();
  return cache.leaveQuota.find(q => q.workerId === workerId && q.year === year) || {
    personal_days: 15,
    sick_days: 30,
    annual_days: 10,
    comp_days: 12
  };
}

function updateLeaveDuration() {
  const startDate = document.getElementById("leaveStartDate").value;
  const startTime = document.getElementById("leaveStartTime").value;
  const endDate = document.getElementById("leaveEndDate").value;
  const endTime = document.getElementById("leaveEndTime").value;
  const textEl = document.getElementById("leaveDurationText");
  const hintEl = document.getElementById("leaveDurationHint");
  
  if (!startDate || !endDate || !startTime || !endTime) {
    textEl.textContent = "请选择日期和时间";
    textEl.style.color = "#6b7280";
    hintEl.style.borderColor = "var(--primary)";
    hintEl.style.background = "#f0f9ff";
    return;
  }
  
  const start = new Date(`${startDate}T${startTime}`);
  const end = new Date(`${endDate}T${endTime}`);
  
  if (isNaN(start) || isNaN(end)) {
    textEl.textContent = "时间格式错误";
    textEl.style.color = "#dc2626";
    hintEl.style.borderColor = "#dc2626";
    hintEl.style.background = "#fef2f2";
    return;
  }
  
  if (end <= start) {
    textEl.textContent = "❌ 结束时间不能早于开始时间";
    textEl.style.color = "#dc2626";
    hintEl.style.borderColor = "#dc2626";
    hintEl.style.background = "#fef2f2";
    return;
  }
  
  let totalHours = 0;
  const workStart = 8;
  const workEnd = 18;
  const current = new Date(start);
  
  while (current <= end) {
    const dateStr = dateKey(current);
    if (!isWorkDay(dateStr)) {
      current.setDate(current.getDate() + 1);
      current.setHours(workStart, 0, 0, 0);
      continue;
    }
    
    const currentDayStart = new Date(dateStr + "T08:00");
    const currentDayEnd = new Date(dateStr + "T18:00");
    
    const periodStart = current > currentDayStart ? current : currentDayStart;
    const periodEnd = new Date(dateStr + "T18:00");
    
    if (periodStart >= periodEnd) {
      current.setDate(current.getDate() + 1);
      current.setHours(workStart, 0, 0, 0);
      continue;
    }
    
    const actualEnd = periodEnd < end ? periodEnd : end;
    const hours = (actualEnd - periodStart) / (1000 * 60 * 60);
    
    if (hours > 0) {
      totalHours += hours;
    }
    
    current.setDate(current.getDate() + 1);
    current.setHours(workStart, 0, 0, 0);
  }
  
  totalHours = Math.round(totalHours * 10) / 10;
  
  const days = Math.floor(totalHours / 8);
  const remainingHours = totalHours % 8;
  
  let durationText = "";
  if (days > 0) durationText += `${days} 天 `;
  if (remainingHours > 0) durationText += `${remainingHours} 小时`;
  if (!durationText) durationText = `${totalHours} 小时`;
  
  textEl.textContent = `${durationText.trim()}（约 ${totalHours.toFixed(1)} 工时，仅计算工作时间08:00-18:00）`;
  textEl.style.color = "#10b981";
  hintEl.style.borderColor = "#10b981";
  hintEl.style.background = "#f0fdf4";
}

async function submitLeaveForm() {
  const workerId = document.getElementById("leaveWorkerId").value;
  const workerName = document.getElementById("leaveWorkerName").value;
  const leaveType = document.getElementById("leaveType").value;
  const startDate = document.getElementById("leaveStartDate").value;
  const startTime = document.getElementById("leaveStartTime").value;
  const endDate = document.getElementById("leaveEndDate").value;
  const endTime = document.getElementById("leaveEndTime").value;
  const reason = document.getElementById("leaveReason").value.trim();
  
  if (!startDate) { toast("请选择开始日期"); return; }
  if (!endDate) { toast("请选择结束日期"); return; }
  
  const startDt = new Date(`${startDate}T${startTime}`);
  const endDt = new Date(`${endDate}T${endTime}`);
  if (endDt <= startDt) { toast("结束时间不能早于开始时间"); return; }
  
  const conflicts = checkLeaveProjectConflict(workerId, startDate, endDate, startTime, endTime);
  if (conflicts.length > 0) {
    if (!(await confirmDialog(`检测到 ${conflicts.length} 个项目排期冲突，确认继续提交请假申请吗？`, "排期冲突"))) {
      return;
    }
  }
  
  const isAutoApproved = isManager() || leaveType === "comp";
  const status = isAutoApproved ? "approved" : "pending";
  
  await repo.saveLeaveRecord({
    workerId, workerName, leaveType,
    startDate, startTime,
    endDate, endTime, reason, status,
  });
  await repo.loadAll();
  modal.close();
  renderAll();
  toast(status === "approved" ? "请假已批准" : "请假申请已提交，等待审批");
  
  if (status === "pending") {
    notify("新的请假申请", `${workerName} 申请了 ${LEAVE_TYPE_LABEL[leaveType]}，请及时审批`);
  }
}

async function deleteLeaveRecord(id) {
  if (!perm.manageLeaves()) { toast("权限不足"); return; }
  if (!(await confirmDialog("确定删除该请假记录？", "删除请假记录"))) return;
  await repo.deleteLeaveRecord(id);
  renderAll();
  toast("请假记录已删除");
}

/* 项目预约时间选择辅助函数 */
function onCustomerInput() {
}

function fillCustomerInfo() {
  const customerInput = document.getElementById("pCustomer");
  const phoneInput = document.getElementById("pPhone");
  const addressInput = document.getElementById("pAddress");
  if (!customerInput || !phoneInput || !addressInput) return;
  
  const customerName = customerInput.value.trim();
  if (!customerName) return;
  
  const cust = findCustomer(customerName);
  if (cust) {
    if (!phoneInput.value && cust.phone) phoneInput.value = cust.phone;
    if (!addressInput.value && cust.address) addressInput.value = cust.address;
  }
}

function setPTimeRange(type) {
  const date = document.getElementById("pDate").value;
  if (!date) {
    toast("请先选择预约日期");
    return;
  }
  const timeSel = document.getElementById("pTime");
  const endSel = document.getElementById("pEnd");
  const endDateEl = document.getElementById("pEndDate");
  const crossDayEl = document.getElementById("pCrossDay");
  
  if (crossDayEl) crossDayEl.checked = false;
  if (endDateEl) endDateEl.style.display = "none";
  
  if (type === "morning") {
    timeSel.value = "08:00";
    endSel.value = "12:00";
  } else if (type === "afternoon") {
    timeSel.value = "13:00";
    endSel.value = "18:00";
  } else if (type === "full") {
    timeSel.value = "08:00";
    endSel.value = "18:00";
  } else if (type === "twohour") {
    const currentTime = timeSel.value;
    if (currentTime) {
      const [h, m] = currentTime.split(":").map(Number);
      const endH = String((h + 2) % 24).padStart(2, "0");
      const endM = String(m).padStart(2, "0");
      endSel.value = `${endH}:${endM}`;
    } else {
      timeSel.value = "09:00";
      endSel.value = "11:00";
    }
  }
  
  if (endDateEl) endDateEl.value = date;
  updateSpanHint();
}

function updatePTimeOptions() {
}

function toggleCrossDay() {
  const crossDayEl = document.getElementById("pCrossDay");
  const endDateEl = document.getElementById("pEndDate");
  const dateEl = document.getElementById("pDate");
  
  if (crossDayEl && endDateEl && dateEl) {
    if (crossDayEl.checked) {
      endDateEl.style.display = "inline-block";
      const nextDate = new Date(dateEl.value);
      nextDate.setDate(nextDate.getDate() + 1);
      endDateEl.value = nextDate.toISOString().slice(0, 10);
    } else {
      endDateEl.style.display = "none";
      endDateEl.value = dateEl.value;
    }
    updateSpanHint();
  }
}

function autoCalcEndTime() {
  const dateEl = document.getElementById("pDate");
  const timeEl = document.getElementById("pTime");
  const estEl = document.getElementById("pEst");
  const workersEl = document.getElementById("pWorkers");
  const endSel = document.getElementById("pEnd");
  
  if (!dateEl || !timeEl || !estEl || !workersEl || !endSel) {
    toast("表单元素未找到");
    return;
  }
  
  const date = dateEl.value;
  const time = timeEl.value;
  const estHours = Number(estEl.value) || 0;
  const workerCount = Number(workersEl.value) || 1;
  
  if (!date || !time) {
    toast("请先选择日期和开始时间");
    return;
  }
  
  if (estHours <= 0) {
    toast("请先填写预计工时");
    return;
  }
  
  const hoursNeeded = Math.ceil(estHours / workerCount * 10) / 10;
  const startTime = new Date(`${date}T${time}`);
  const endTime = new Date(startTime.getTime() + hoursNeeded * 60 * 60 * 1000);
  
  const endDateEl = document.getElementById("pEndDate");
  const crossDayEl = document.getElementById("pCrossDay");
  const isCrossDay = endTime.toDateString() !== startTime.toDateString();
  
  if (crossDayEl) crossDayEl.checked = isCrossDay;
  if (endDateEl) {
    endDateEl.value = endTime.toISOString().slice(0, 10);
    endDateEl.style.display = isCrossDay ? "inline-block" : "none";
  }
  
  if (!isCrossDay && endDateEl) {
    endDateEl.value = date;
  }
  
  const endH = String(endTime.getHours()).padStart(2, "0");
  const endM = String(endTime.getMinutes()).padStart(2, "0");
  const endStr = `${endH}:${endM}`;
  
  const options = Array.from(endSel.options).map(o => o.value);
  if (options.includes(endStr)) {
    endSel.value = endStr;
  } else {
    let closest = options[0];
    let minDiff = Infinity;
    options.forEach(o => {
      const [oh, om] = o.split(":").map(Number);
      const diff = Math.abs((oh * 60 + om) - (endTime.getHours() * 60 + endTime.getMinutes()));
      if (diff < minDiff) {
        minDiff = diff;
        closest = o;
      }
    });
    endSel.value = closest;
  }
  updateSpanHint();
}

/* ============================================================
 * 项目预约模块
 * ============================================================ */
function renderProjects() {
  const kw = document.getElementById("projectSearch").value.trim().toLowerCase();
  const status = document.getElementById("projectStatusFilter").value;
  const storeFilter = document.getElementById("projectStoreFilter").value;
  const includeCompleted = document.getElementById("includeCompleted")?.checked || false;
  const list = document.getElementById("projectList");
  let items = cache.projects.slice().sort((a, b) =>
    new Date(b.appointmentTime || 0) - new Date(a.appointmentTime || 0));

  if (!kw && projectTimeFilterDays > 0) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - projectTimeFilterDays);
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + projectTimeFilterDays);
    items = items.filter((p) => {
      const aptTime = new Date(p.appointmentTime);
      return !isNaN(aptTime.getTime()) && aptTime >= startDate && aptTime <= endDate;
    });
  }

  if (!includeCompleted && !kw && !status) {
    items = items.filter((p) => ![STATUS.DONE, STATUS.ACCEPTED, STATUS.REVIEWED].includes(p.status));
  }

  if (kw) {
    items = items.filter((p) =>
      [p.name, p.customer, p.address].some((f) => (f || "").toLowerCase().includes(kw)));
  }
  if (status) items = items.filter((p) => p.status === status);
  if (storeFilter) items = items.filter((p) => (p.storeId || "") === storeFilter);

  if (items.length === 0) {
    list.innerHTML = `<div class="empty">暂无项目${perm.createProject() ? "，点击右上角「新建预约」创建。" : "。"}</div>`;
    return;
  }

  list.innerHTML = items.map((p) => {
    const done = sumHours(p);
    const { est, act, hasActual } = hoursDiff(p);
    const canEdit = perm.editProject(p);
    const canDelete = perm.deleteProject(p);
    const canReview = perm.reviewProject(p);
    const reviewed = isReviewed(p);
    const canUnreview = reviewed && perm.unreviewProject(p);
    
    const end = new Date(p.endTime || p.startTime);
    const isOverdue = p.status === STATUS.BOOKED && !p.startedAt && new Date() > end;
    
    const pStart = new Date(p.appointmentTime || p.startTime);
    const pEnd = new Date(p.endTime || p.appointmentTime);
    const leaveConflicts = cache.leaveRecords.filter(r => {
      if (r.status !== "approved") return false;
      if (!p.assignedWorkerIds || !p.assignedWorkerIds.includes(r.workerId)) return false;
      const leaveStart = new Date(`${r.startDate}T${r.startTime || "08:00"}`);
      const leaveEnd = new Date(`${r.endDate}T${r.endTime || "18:00"}`);
      return leaveStart < pEnd && leaveEnd > pStart;
    });
    
    return `
      <div class="card ${isOverdue ? "card-overdue" : ""}">
        <div class="card-title">
          <h3>${esc(p.name)}</h3>
          <div style="display: flex; gap: 4px;">
            <span class="badge ${p.status}">${p.status}</span>
            ${isOverdue ? `<span class="badge overdue">🔴 超期</span>` : ""}
            ${p.timeModified ? `<span class="badge modified">✏️ 已改点</span>` : ""}
            ${leaveConflicts.length > 0 ? `<span class="badge danger">⚠️ 人员请假</span>` : ""}
          </div>
        </div>
        <div class="card-row"><span>预约门店</span><b>${esc(storeName(p.storeId))}</b></div>
        <div class="card-row"><span>客户</span><b>${esc(p.customer || "—")}</b></div>
        <div class="card-row"><span>联系电话</span><b>${p.phone ? `<a href="tel:${esc(p.phone)}" style="color:var(--info)">${esc(p.phone)}</a>` : "—"}</b></div>
        <div class="card-row"><span>安装地址</span><b>${esc(p.address || "—")}</b></div>
        <div class="card-row"><span>预约时段</span><b>${fmtTimeRange(p)}</b></div>
        ${leaveConflicts.length > 0 ? `
          <div class="card-row" style="background:#fef2f2;padding:6px 10px;border-radius:4px;margin-top:4px;">
            <span style="font-weight:bold;color:#dc2626;font-size:12px;">⚠️ 施工人员请假：</span>
            <span style="color:#991b1b;font-size:12px;">${leaveConflicts.map(r => `${r.workerName}(${r.startDate}~${r.endDate})`).join("、")}</span>
          </div>
        ` : ""}
        <div class="card-row"><span>预计安排</span><b>总工时${est}人·小时 / ${(p.assignedWorkerIds && p.assignedWorkerIds.length) || p.workerCount || 1}人 / 时长${est > 0 ? (est / ((p.assignedWorkerIds && p.assignedWorkerIds.length) || p.workerCount || 1)).toFixed(1) : "—"}小时</b></div>
        <div class="card-row"><span>实际登记</span><b>${hasActual ? act : "—"}工时 / ${(p.workLogs || []).filter(l => l.workerId).length > 0 ? [...new Set((p.workLogs || []).filter(l => l.workerId).map(l => l.workerId))].length : "-"}人 / ${diffLabel(p)}</b></div>
        <div class="card-row">
            <span>进度</span>
            <div style="flex:1;display:flex;align-items:center;gap:8px;">
              <div style="flex:1;height:7px;background:#e5e7eb;border-radius:4px;overflow:hidden;">
                <div style="height:100%;width:${Math.min(100, getProjectProgress(p, est, act, hasActual, done))}%;background:${(() => {
                  if (getProjectProgress(p, est, act, hasActual, done) >= 100) return '#10b981';
                  if (p.status === STATUS.PAUSED) return '#f59e0b';
                  if (p.status === STATUS.DELAYED) return '#dc2626';
                  return '#3b82f6';
                })()};border-radius:4px;"></div>
              </div>
              <span style="font-weight:bold;font-size:12px;">${Math.round(getProjectProgress(p, est, act, hasActual, done))}%</span>
            </div>
          </div>
        <div class="card-row"><span>开始施工</span><b>${p.startedAt ? esc(fmtDateTime(p.startedAt)) : "—"}</b></div>
        <div class="card-row"><span>完工时间</span><b>${p.finishedAt ? esc(fmtDateTime(p.finishedAt)) : "—"}</b></div>
        <div class="card-row"><span>施工时长</span><b>${p.startedAt && p.finishedAt ? esc(calcActualWorkDuration(p)) : "—"}</b></div>
        <div class="card-actions">
          <button class="btn small primary" onclick="gotoConstruction('${p.id}')">施工管理</button>
          ${canEdit ? `<button class="btn small" onclick="editProject('${p.id}')">编辑</button>` : ""}
          ${canDelete ? `<button class="btn small danger" onclick="deleteProject('${p.id}')">删除</button>` : ""}
          ${canReview && !reviewed ? `<button class="btn small" onclick="reviewProject('${p.id}')">审核</button>` : ""}
          ${canUnreview ? `<button class="btn small" onclick="unreviewProject('${p.id}')">反审核</button>` : ""}
        </div>
      </div>`;
  }).join("");
}

/* 项目列表的门店筛选下拉 */
function refreshProjectStoreFilter() {
  const sel = document.getElementById("projectStoreFilter");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">全部门店</option>` +
    cache.stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  if (prev && cache.stores.some((s) => s.id === prev)) sel.value = prev;
}

function onProjectStatusChange(status) {
  const completedStatuses = ["已完工", "已验收", "已审核"];
  const includeCompletedEl = document.getElementById("includeCompleted");
  if (includeCompletedEl && completedStatuses.includes(status)) {
    includeCompletedEl.checked = true;
  }
  renderProjects();
}

function setProjectTimeFilter(days) {
  projectTimeFilterDays = days;
  
  document.getElementById("timeFilterAll").classList.toggle("primary", days === 0);
  document.getElementById("timeFilter3").classList.toggle("primary", days === 3);
  document.getElementById("timeFilter7").classList.toggle("primary", days === 7);
  document.getElementById("timeFilter15").classList.toggle("primary", days === 15);
  
  renderProjects();
}

function projectForm(p = {}) {
  const storeLocked = (isStoreManager() && myStore() != null && myStore() !== "") || isWorker();
  const selectedStore = p.storeId || (storeLocked ? myStore() : "");
  const storeOpts = `<option value="">未指定门店</option>` +
    cache.stores.map((s) =>
      `<option value="${s.id}" ${s.id === selectedStore ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  const startDate = p.appointmentTime ? new Date(p.appointmentTime) : (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d; })();
  return `
    <div style="display:flex;align-items:flex-start;gap:10px;width:100%;">
      <div style="flex-shrink:0;">
        <label style="display:block;margin-bottom:4px;"><span style="color:var(--primary)">🏪</span> 所属门店</label>
        <select class="input" id="pStore" ${storeLocked ? "disabled" : ""} style="width:auto;max-width:160px;">
          ${storeOpts}
        </select>
      </div>
      <div style="flex:1;min-width:0;">
        <label style="display:block;margin-bottom:4px;"><span style="color:var(--primary)">📋</span> 项目名称 *</label>
        <input class="input" id="pName" value="${esc(p.name || "")}" placeholder="如：某某商场门头广告安装" style="width:100%;" />
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label><span style="color:#0891b2">👤</span> 客户名称</label>
        <input class="input" id="pCustomer" value="${esc(p.customer || "")}" placeholder="客户 / 单位" list="customerDatalist" oninput="onCustomerInput()" onblur="fillCustomerInfo()" />
        <datalist id="customerDatalist">
          ${getCustomerHistory().map(c => `<option value="${esc(c.customer)}" data-phone="${esc(c.phone || "")}" data-address="${esc(c.address || "")}">`).join("")}
        </datalist>
      </div>
      <div class="form-row">
        <label><span style="color:#0891b2">📞</span> 联系电话</label>
        <input class="input" id="pPhone" value="${esc(p.phone || "")}" placeholder="客户电话" />
      </div>
    </div>
    <div class="form-row">
      <label><span style="color:#0891b2">📍</span> 安装地址</label>
      <input class="input" id="pAddress" value="${esc(p.address || "")}" placeholder="施工现场地址" />
    </div>
    <div class="form-row">
      <label><span style="color:var(--warn)">📅</span> 预约时间 *</label>
      <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
        <input class="input" type="date" id="pDate" value="${dateKey(startDate)}" onchange="onDateChange()" style="width:100%;" />
        <div style="display:flex;align-items:center;gap:6px;width:100%;">
          <span style="font-size:11px;color:#64748b;flex-shrink:0;">开始</span>
          <select class="input" id="pTime" onchange="updateSpanHint()" style="flex:1;max-width:90px;">
            ${(() => {
              const times = [];
              for (let h = 7; h <= 21; h++) {
                for (let m = 0; m < 60; m += 10) {
                  times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
                }
              }
              times.push('22:00');
              const curTime = p.appointmentTime ? `${String(new Date(p.appointmentTime).getHours()).padStart(2, '0')}:${String(new Date(p.appointmentTime).getMinutes()).padStart(2, '0')}` : '09:00';
              return times.map(t => `<option value="${t}" ${t === curTime ? 'selected' : ''}>${t}</option>`).join('');
            })()}
          </select>
          <span style="font-size:14px;color:#94a3b8;flex-shrink:0;">→</span>
          <span style="font-size:11px;color:#64748b;flex-shrink:0;">结束</span>
          <select class="input" id="pEnd" onchange="updateSpanHint()" style="flex:1;max-width:90px;">
            ${(() => {
              const times = [];
              for (let h = 7; h <= 21; h++) {
                for (let m = 0; m < 60; m += 10) {
                  times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
                }
              }
              times.push('22:00');
              const curTime = p.endTime ? `${String(new Date(p.endTime).getHours()).padStart(2, '0')}:${String(new Date(p.endTime).getMinutes()).padStart(2, '0')}` : '12:00';
              return times.map(t => `<option value="${t}" ${t === curTime ? 'selected' : ''}>${t}</option>`).join('');
            })()}
          </select>
        </div>
      </div>
    </div>
    <div class="form-row">
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
        <button class="btn small" onclick="setPTimeRange('twohour')" style="background:#fce7f3;color:#db2777;border-color:#fbcfe8;border-radius:4px;padding:3px 8px;font-size:12px;">⏱️ 2小时</button>
        <button class="btn small" onclick="setPTimeRange('morning')" style="background:#e0f2fe;color:#0891b2;border-color:#7dd3fc;border-radius:4px;padding:3px 8px;font-size:12px;">🌅 上午</button>
        <button class="btn small" onclick="setPTimeRange('afternoon')" style="background:#fef3c7;color:#d97706;border-color:#fcd34d;border-radius:4px;padding:3px 8px;font-size:12px;">☀️ 下午</button>
        <button class="btn small" onclick="setPTimeRange('full')" style="background:#dcfce7;color:#16a34a;border-color:#86efac;border-radius:4px;padding:3px 8px;font-size:12px;">📅 全天</button>
      </div>
    </div>
    <div id="pDurationCard" style="background:linear-gradient(135deg,#f8fafc,#f1f5f9);border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:24px;">⏳</span>
        <div>
          <div style="font-size:12px;color:#64748b;">施工时长</div>
          <div id="pDurationValue" style="font-size:20px;font-weight:700;color:#1e293b;">--</div>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:12px;color:#64748b;">建议人数</div>
        <div id="pSuggestWorkers" style="font-size:16px;font-weight:600;color:#2563eb;">--</div>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label><span style="color:var(--success)">⚙️</span> 预计总工时</label>
        <div style="display:flex;align-items:center;gap:6px;">
          <input class="input" type="number" min="0" step="0.5" id="pEst" value="${esc(p.estimatedHours ?? "")}" placeholder="0" style="width:auto;max-width:100px;" oninput="updateSpanHint()" />
          <span style="font-size:12px;color:var(--muted)">人·小时</span>
        </div>
        <small class="hint" style="font-size:11px;margin:2px 0 0;color:#16a34a;">先填写总工时，方便计算结束时间</small>
      </div>
      <div class="form-row">
        <label><span style="color:var(--success)">👷</span> 施工人数</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <select class="input" id="pWorkers" onchange="autoCalcEndTime()" style="width:auto;max-width:100px;">
            <option value="1" ${(p.workerCount === 1 || (!p.workerCount && (!p.assignedWorkerIds || p.assignedWorkerIds.length === 1))) ? 'selected' : ''}>1人</option>
            <option value="2" ${(p.workerCount === 2 || (p.assignedWorkerIds && p.assignedWorkerIds.length === 2)) ? 'selected' : ''}>2人</option>
            <option value="3" ${(p.workerCount === 3 || (p.assignedWorkerIds && p.assignedWorkerIds.length === 3)) ? 'selected' : ''}>3人</option>
            <option value="4" ${(p.workerCount >= 4 || (p.assignedWorkerIds && p.assignedWorkerIds.length >= 4)) ? 'selected' : ''}>4人+</option>
          </select>
          <button class="btn small" onclick="autoCalcEndTime()" style="flex-shrink:0;background:#2563eb;color:#fff;border-color:#2563eb;">计算</button>
        </div>
      </div>
    </div>
    <div class="form-row">
      <label><span style="color:#6b7280;">💬</span> 备注</label>
      <textarea class="input" id="pNote" placeholder="施工内容 / 注意事项" style="min-height:50px;">${esc(p.note || "")}</textarea>
    </div>
    <input type="hidden" id="pStatus" value="${p.status || STATUS.BOOKED}" />
    <div class="form-actions">
      <button class="btn" onclick="modal.close()">取消</button>
      <button class="btn primary" onclick="saveProject('${p.id || ""}')">保存</button>
    </div>`;
}

function newProject() { 
  modal.open("新建项目预约", projectForm({ status: STATUS.BOOKED })); 
  setTimeout(updateSpanHint, 100); 
}
function editProject(id) { 
  modal.open("编辑项目", projectForm(getProject(id))); 
  setTimeout(updateSpanHint, 100); 
}

async function saveProject(id) {
  if (id && isReviewed(getProject(id))) {
    toast("已审核的项目无法编辑");
    return;
  }
  const name = document.getElementById("pName").value.trim();
  const date = document.getElementById("pDate").value;
  const time = document.getElementById("pTime").value;
  const end = document.getElementById("pEnd").value;
  const crossDayEl = document.getElementById("pCrossDay");
  if (!name) { toast("请填写项目名称"); return; }
  if (!date) { toast("请选择预约日期"); return; }
  if (!time) { toast("请选择开始时间"); return; }
  if (!end) { toast("请选择结束时间"); return; }
  
  const endDateEl = document.getElementById("pEndDate");
  let endDate = endDateEl ? endDateEl.value : "";
  if (!crossDayEl?.checked || !endDate) {
    endDate = date;
  }
  
  const fullTime = `${date}T${time}`;
  const fullEnd = `${endDate}T${end}`;
  if (new Date(fullEnd) <= new Date(fullTime)) { toast("结束时间需晚于开始时间"); return; }
  const storeEl = document.getElementById("pStore");
  let storeId = storeEl ? storeEl.value : "";
  if (isStoreManager() && myStore() != null && myStore() !== "") storeId = myStore();
  if (isWorker() && myStore() != null && myStore() !== "") storeId = myStore();
  const workerCountInput = document.getElementById("pWorkers").value;
  if (!validateWorkerCount(workerCountInput)) { toast("施工人数必须在 1-10 之间"); return; }
  const workerCount = Number(workerCountInput);
  
  const phone = document.getElementById("pPhone").value.trim();
  if (!validatePhone(phone)) { toast("请输入有效的手机号码"); return; }
  
  const inputEstHours = Number(document.getElementById("pEst").value) || 0;
  const startTime = new Date(fullTime);
  const endTime = new Date(fullEnd);
  const durationHours = (endTime - startTime) / (1000 * 60 * 60);
  const autoEstHours = Math.round(durationHours * workerCount * 10) / 10;
  
  let estimatedHours = inputEstHours;
  let autoCalculated = false;
  if (!id && inputEstHours <= 0) {
    estimatedHours = autoEstHours;
    autoCalculated = true;
  }
  
  const payload = {
    name,
    customer: document.getElementById("pCustomer").value.trim(),
    phone: document.getElementById("pPhone").value.trim(),
    address: document.getElementById("pAddress").value.trim(),
    appointmentTime: fullTime,
    endTime: fullEnd,
    estimatedHours,
    workerCount,
    status: document.getElementById("pStatus").value,
    note: document.getElementById("pNote").value.trim(),
    storeId,
  };
  
  if (id) {
    const existingProject = getProject(id);
    if (existingProject && existingProject.repairOrder) {
      payload.repairOrder = existingProject.repairOrder;
    }
  }
  
  try {
    await repo.saveProject(payload, id);
    await repo.loadAll();
    modal.close();
    renderAll();
    toast(autoCalculated ? `已保存，预计总工时已根据施工时间和人数自动计算为 ${estimatedHours} 小时` : "已保存");
    
    if (payload.customer) {
      upsertCustomer(payload.customer, payload.phone, payload.address);
    }
    
    if (id) {
      const existing = getProject(id);
      const changes = [];
      if (existing.name !== name) changes.push(`项目名称: ${existing.name} -> ${name}`);
      if (existing.customer !== payload.customer) changes.push(`客户: ${existing.customer || "无"} -> ${payload.customer || "无"}`);
      if (existing.phone !== payload.phone) changes.push(`电话: ${existing.phone || "无"} -> ${payload.phone || "无"}`);
      if (existing.address !== payload.address) changes.push(`地址: ${existing.address || "无"} -> ${payload.address || "无"}`);
      if (existing.appointmentTime !== payload.appointmentTime) changes.push(`预约时间: ${existing.appointmentTime || "无"} -> ${payload.appointmentTime}`);
      if (existing.endTime !== payload.endTime) changes.push(`结束时间: ${existing.endTime || "无"} -> ${payload.endTime}`);
      if (existing.estimatedHours !== payload.estimatedHours) changes.push(`预计工时: ${existing.estimatedHours || 0} -> ${payload.estimatedHours}`);
      if (existing.workerCount !== payload.workerCount) changes.push(`施工人数: ${existing.workerCount || 1} -> ${payload.workerCount}`);
      if (existing.status !== payload.status) changes.push(`状态: ${existing.status || "无"} -> ${payload.status}`);
      if (existing.note !== payload.note) changes.push(`备注: ${existing.note || "无"} -> ${payload.note || "无"}`);
      if (existing.storeId !== payload.storeId) changes.push(`门店: ${storeName(existing.storeId) || "无"} -> ${storeName(payload.storeId) || "无"}`);
      const changeDetail = changes.length > 0 ? changes.join("; ") : "无字段变更";
      logOperation("PROJECT_EDIT", name, `ID: ${id}, 变更: ${changeDetail}`);
    } else {
      logOperation("PROJECT_CREATE", name, `客户: ${payload.customer || "无"}, 电话: ${payload.phone || "无"}, 地址: ${payload.address || "无"}, 预约时间: ${payload.appointmentTime}, 预计工时: ${payload.estimatedHours}小时, 施工人数: ${payload.workerCount}, 门店: ${storeName(payload.storeId) || "无"}`);
    }
    
    if (id) {
      const p = getProject(id);
      if (p) {
        sendNotificationForProjectChange("update", p);
      }
    } else {
      const newProject = cache.projects[cache.projects.length - 1];
      if (newProject) {
        sendNotificationForProjectChange("new", newProject);
      }
    }
  } catch (error) {
    console.error("保存项目失败:", error);
    toast("保存失败：" + (error.message || "未知错误"));
  }
}

function openRepairOrderForm(projectId) {
  const p = getProject(projectId);
  if (!p) return;
  
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = dateKey(tomorrow);
  const roundedMinutes = Math.ceil(tomorrow.getMinutes() / 20) * 20;
  tomorrow.setMinutes(roundedMinutes);
  const defaultTime = `${String(tomorrow.getHours()).padStart(2, '0')}:${String(tomorrow.getMinutes()).padStart(2, '0')}`;
  
  const times = [];
  for (let h = 8; h <= 22; h++) {
    for (let m = 0; m < 60; m += 20) {
      times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  
  const form = `
    <div class="repair-form">
      <div class="form-row">
        <label>维修项目（必填）</label>
        <textarea class="input" id="repairItems" placeholder="请填写需要维修的项目，多个项目用换行分隔"></textarea>
        <small class="hint" style="margin:2px 0 0">例如：灯箱更换、线路检修、支架加固等</small>
      </div>
      <div class="form-row">
        <label>维修原因</label>
        <textarea class="input" id="repairReason" placeholder="请填写维修原因"></textarea>
      </div>
      <div class="form-row" style="display:flex;gap:8px;align-items:center;">
        <div style="flex:1;">
          <label>维修日期</label>
          <input class="input" type="date" id="repairDate" value="${tomorrowDate}" min="${dateKey(now)}" />
        </div>
        <div style="flex:1;">
          <label>维修时间</label>
          <select class="input" id="repairTime">
            ${times.map(t => `<option value="${t}" ${t === defaultTime ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" onclick="modal.close()">取消</button>
        <button class="btn primary" onclick="submitRepairOrder('${projectId}')">提交维修单</button>
      </div>
    </div>`;
  
  modal.open("🔧 发起维修单", form);
}

async function submitRepairOrder(projectId) {
  const items = document.getElementById("repairItems").value.trim();
  const reason = document.getElementById("repairReason").value.trim();
  const date = document.getElementById("repairDate").value;
  const time = document.getElementById("repairTime").value;
  
  if (!items) {
    toast("请填写维修项目");
    return;
  }
  if (!date || !time) {
    toast("请选择预约维修时间");
    return;
  }
  
  const fullTime = `${date}T${time}`;
  
  const repairOrder = {
    items,
    reason,
    appointmentTime: new Date(fullTime).toISOString(),
    status: "待维修",
    createdAt: new Date().toISOString(),
  };
  
  const startTime = new Date(fullTime);
  const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000);
  
  await repo.patchProject(projectId, { 
    repairOrder,
    appointmentTime: startTime.toISOString(),
    endTime: endTime.toISOString()
  });
  await repo.loadAll();
  modal.close();
  gotoConstruction(projectId);
  toast("维修单已提交");
  
  const p = getProject(projectId);
  if (p) {
    showNotificationAlert(`🔧 维修单已发起：${p.name}`);
  }
}

async function completeRepair(projectId) {
  const p = getProject(projectId);
  if (!p || !p.repairOrder) {
    toast("维修单不存在");
    return;
  }
  
  if (!(await confirmDialog("确认维修已完成？", "维修完成"))) return;
  
  clearTimeout(reloadTimer);
  await repo.patchProject(projectId, { 
    repairOrder: { 
      ...p.repairOrder, 
      status: "已完成",
      completedAt: new Date().toISOString()
    } 
  });
  await repo.loadAll();
  gotoConstruction(projectId);
  toast("维修已完成");
}

async function deleteProject(id) {
  const p = getProject(id);
  if (!p) {
    toast("项目不存在");
    return;
  }
  if (!(await confirmDialog("确定删除该项目及其施工记录？", "删除项目"))) return;
  try {
    await repo.deleteProject(id);
    if (currentProjectId === id) currentProjectId = "";
    clearTimeout(reloadTimer);
    await repo.loadAll();
    renderAll();
    toast("已删除");
    logOperation("PROJECT_DELETE", p.name || "项目", `ID: ${id}`);
  } catch (error) {
    console.error("删除项目失败:", error);
    toast("删除失败，请重试");
  }
}

async function cancelProject(id) {
  const p = getProject(id);
  if (!p) {
    toast("项目不存在");
    return;
  }
  if (p.status === STATUS.CANCELLED) {
    toast("项目已取消");
    return;
  }
  if ([STATUS.DONE, STATUS.ACCEPTED, STATUS.REVIEWED].includes(p.status)) {
    toast("已完工、已验收或已审核的项目无法取消");
    return;
  }
  
  const reason = await promptDialog("请输入取消原因：<br><br>1. 客户取消订单<br>2. 材料问题<br>3. 人员调配<br>4. 其他", "取消项目", "客户取消订单");
  if (!reason) return;
  
  try {
    const now = new Date().toISOString();
    await repo.patchProject(id, { 
      status: STATUS.CANCELLED, 
      cancelledAt: now,
      cancelReason: reason 
    });
    clearTimeout(reloadTimer);
    await repo.loadAll();
    renderAll();
    toast("项目已取消");
    logOperation("PROJECT_CANCEL", p.name || "项目", `ID: ${id}, 原因: ${reason}`);
  } catch (error) {
    console.error("取消项目失败:", error);
    toast("取消失败，请重试");
  }
}

/* ============================================================
 * 施工管理模块
 * ============================================================ */
let currentProjectId = "";

/* 日历视图状态（移至下方统一定义） */

function refreshProjectSelector() {
  // 缓存可选项目列表，供自定义选择弹窗使用
  constructionProjectList = cache.projects.slice()
    .filter(p => p.status !== STATUS.REVIEWED && p.status !== STATUS.ACCEPTED)
    .sort((a, b) =>
    new Date(b.appointmentTime || 0) - new Date(a.appointmentTime || 0));
  updateConstructionSelectLabel();
}

/* 构造“门店 项目名 日期”格式的项目显示文本 */
function buildProjectDisplay(p) {
  const store = p.storeName ? esc(p.storeName) : "";
  const name = esc(p.name) || "（未命名项目）";
  const date = p.appointmentTime ? fmtDate(p.appointmentTime) : "";
  return { store, name, date };
}

/* 更新施工管理选择按钮上显示的文字 */
function updateConstructionSelectLabel() {
  const labelEl = document.getElementById("constructionProjectSelectLabel");
  if (!labelEl) return;
  if (!currentProjectId) {
    labelEl.textContent = "— 请选择项目 —";
    labelEl.classList.remove("has-project");
    return;
  }
  const p = getProject(currentProjectId);
  if (!p) {
    labelEl.textContent = "— 请选择项目 —";
    labelEl.classList.remove("has-project");
    return;
  }
  const { store, name, date } = buildProjectDisplay(p);
  labelEl.classList.add("has-project");
  // 按钮上用简洁文本：门店 项目名 日期
  labelEl.textContent = [store, name, date].filter(Boolean).join(" · ");
}

/* 打开自定义项目选择弹窗（替代原生 select 的系统下拉） */
let constructionProjectList = [];
let projectPickerSearchKeyword = "";

function openProjectPicker() {
  const keyword = projectPickerSearchKeyword.trim().toLowerCase();
  let items = constructionProjectList;
  if (keyword) {
    items = items.filter(p => {
      const { store, name, date } = buildProjectDisplay(p);
      return [store, name, date].join(" ").toLowerCase().includes(keyword)
        || (p.customer && String(p.customer).toLowerCase().includes(keyword))
        || (p.address && String(p.address).toLowerCase().includes(keyword));
    });
  }

  const listHtml = items.length
    ? items.map(p => {
        const { store, name, date } = buildProjectDisplay(p);
        const active = p.id === currentProjectId ? " active" : "";
        const statusTag = p.status ? `<span class="pp-status pp-status-${esc(p.status)}">${esc(p.status)}</span>` : "";
        return `
          <div class="project-picker-item${active}" onclick="pickConstructionProject('${p.id}')">
            <div class="pp-main">
              ${store ? `<span class="pp-store">${store}</span>` : ""}
              <span class="pp-name">${name}</span>
            </div>
            <div class="pp-meta">
              ${date ? `<span class="pp-date">📅 ${date}</span>` : ""}
              ${statusTag}
            </div>
          </div>`;
      }).join("")
    : `<div class="project-picker-empty">没有匹配的项目</div>`;

  const body = `
    <div class="project-picker">
      <div class="project-picker-search">
        <input type="text" id="projectPickerSearch" class="input" placeholder="🔍 搜索门店 / 项目名 / 日期 / 客户 / 地址" value="${esc(projectPickerSearchKeyword)}" oninput="onProjectPickerSearch(this.value)" />
      </div>
      <div class="project-picker-count">共 ${items.length} 个可选项目</div>
      <div class="project-picker-list" id="projectPickerList">${listHtml}</div>
    </div>
  `;

  modal.open("选择项目", body, { hideFooter: true });
  // 自动聚焦搜索框
  setTimeout(() => {
    const s = document.getElementById("projectPickerSearch");
    if (s) { s.focus(); s.select(); }
  }, 50);
}

function onProjectPickerSearch(val) {
  projectPickerSearchKeyword = val || "";
  const listEl = document.getElementById("projectPickerList");
  const countEl = document.querySelector(".project-picker-count");
  if (!listEl) return;
  const keyword = projectPickerSearchKeyword.trim().toLowerCase();
  let items = constructionProjectList;
  if (keyword) {
    items = items.filter(p => {
      const { store, name, date } = buildProjectDisplay(p);
      return [store, name, date].join(" ").toLowerCase().includes(keyword)
        || (p.customer && String(p.customer).toLowerCase().includes(keyword))
        || (p.address && String(p.address).toLowerCase().includes(keyword));
    });
  }
  if (countEl) countEl.textContent = `共 ${items.length} 个可选项目`;
  listEl.innerHTML = items.length
    ? items.map(p => {
        const { store, name, date } = buildProjectDisplay(p);
        const active = p.id === currentProjectId ? " active" : "";
        const statusTag = p.status ? `<span class="pp-status pp-status-${esc(p.status)}">${esc(p.status)}</span>` : "";
        return `
          <div class="project-picker-item${active}" onclick="pickConstructionProject('${p.id}')">
            <div class="pp-main">
              ${store ? `<span class="pp-store">${store}</span>` : ""}
              <span class="pp-name">${name}</span>
            </div>
            <div class="pp-meta">
              ${date ? `<span class="pp-date">📅 ${date}</span>` : ""}
              ${statusTag}
            </div>
          </div>`;
      }).join("")
    : `<div class="project-picker-empty">没有匹配的项目</div>`;
}

function pickConstructionProject(id) {
  currentProjectId = id;
  modal.close();
  projectPickerSearchKeyword = "";
  updateConstructionSelectLabel();
  renderConstruction();
  setTimeout(() => {
    const detail = document.getElementById("constructionDetail");
    if (detail) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
}

function gotoConstruction(id) {
  currentProjectId = id;
  switchTab("construction");
  updateConstructionSelectLabel();
  renderConstruction();
  setTimeout(() => {
    const detail = document.getElementById("constructionDetail");
    if (detail) {
      detail.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, 100);
}

let viewScheduleDate = null;

function setViewScheduleDate(dateStr) {
  viewScheduleDate = dateStr;
  renderConstruction();
}

function prevDaySchedule() {
  const d = viewScheduleDate ? new Date(viewScheduleDate) : new Date();
  d.setDate(d.getDate() - 1);
  viewScheduleDate = dateKey(d);
  renderConstruction();
}

function nextDaySchedule() {
  const d = viewScheduleDate ? new Date(viewScheduleDate) : new Date();
  d.setDate(d.getDate() + 1);
  viewScheduleDate = dateKey(d);
  renderConstruction();
}

function todaySchedule() {
  viewScheduleDate = null;
  renderConstruction();
}

function renderConstruction() {
  const scheduleBox = document.getElementById("workerScheduleDescription");
  const dateStr = viewScheduleDate || dateKey(new Date());
  const todayStr = dateKey(new Date());
  const isToday = dateStr === todayStr;
  
  const dateControls = `
    <div class="schedule-date-controls">
      <button class="btn small" onclick="prevDaySchedule()">◀</button>
      <button class="btn small ${isToday ? 'primary' : ''}" onclick="todaySchedule()">${isToday ? '今天' : '回到今天'}</button>
      <input type="date" id="scheduleDatePicker" value="${dateStr}" onchange="setViewScheduleDate(this.value)" class="input" style="width:auto;min-width:140px;">
      <button class="btn small" onclick="nextDaySchedule()">▶</button>
    </div>
  `;
  
  scheduleBox.innerHTML = dateControls + generateWorkerScheduleDescription(dateStr);
  
  const box = document.getElementById("constructionDetail");
  const p = getProject(currentProjectId);
  if (!p) {
    box.innerHTML = `<div class="empty">请选择一个项目进行施工管理。</div>`;
    return;
  }
  const totalHours = sumHours(p);
  const reviewed = isReviewed(p);
  const canEdit = perm.doConstruction(p);
  const canAssign = perm.assignWorker(p);
  const canReview = perm.reviewProject(p);
  const logsRows = (p.workLogs || []).length
    ? p.workLogs.map((l) => {
        const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
        return `
        <tr>
          <td>${esc(l.workerName)}${isOutsourced ? ` <span style="color:#8b5cf6;font-size:12px">(外协)</span>` : ""}</td>
          <td>${fmtDate(l.date)}</td>
          <td>${l.hours} 小时</td>
          <td>${esc(l.level || "中级")}</td>
          <td>${esc(l.note || "—")}</td>
          <td>${canEdit ? `<button class="btn small danger" onclick="deleteWorkLog('${p.id}','${l.id}')">删除</button>` : ""}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:var(--muted)">暂无施工工时记录</td></tr>`;

  const workerOptions = cache.workers.map((w) =>
    `<option value="${w.id}">${esc(w.name)}</option>`).join("");

  const ac = p.acceptance;

  const assigned = p.assignedWorkerIds || [];
  const assignedChips = assigned.length
    ? assigned.map((wid) => {
        const w = getWorker(wid);
        const nm = w ? w.name : "(已删除人员)";
        const conflicts = assignConflicts(p, wid);
        const conflictAttr = conflicts.length
          ? ` title="时间段冲突：${esc(conflicts.map((c) => c.name + " " + fmtTimeRange(c)).join("；"))}"`
          : "";
        return `<span class="assign-chip ${conflicts.length ? "conflict" : ""}"${conflictAttr}>${conflicts.length ? "⚠ " : ""}${esc(nm)}${canAssign ? `<button class="chip-x" onclick="unassignWorker('${p.id}','${wid}')" title="移除">✕</button>` : ""}</span>`;
      }).join("")
    : `<span class="hint" style="margin:0">尚未分配安装人员</span>`;
  const projectStartDate = projectStart(p);
  const projectEndDate = projectEnd(p);
  const pad = (n) => String(n).padStart(2, "0");
  const projStartTime = projectStartDate ? `${pad(projectStartDate.getHours())}:${pad(projectStartDate.getMinutes())}` : "08:00";
  const projEndTime = projectEndDate ? `${pad(projectEndDate.getHours())}:${pad(projectEndDate.getMinutes())}` : "18:00";
  
  const startDateStr = projectStartDate ? `${projectStartDate.getFullYear()}-${String(projectStartDate.getMonth() + 1).padStart(2, "0")}-${String(projectStartDate.getDate()).padStart(2, "0")}` : null;
  const endDateStr = projectEndDate ? `${projectEndDate.getFullYear()}-${String(projectEndDate.getMonth() + 1).padStart(2, "0")}-${String(projectEndDate.getDate()).padStart(2, "0")}` : startDateStr;
  
  const assignSelectOpts = cache.workers
    .filter((w) => !assigned.includes(w.id))
    .map((w) => {
      const leaveRecord = startDateStr ? getProjectLeaveConflict(w.id, startDateStr, endDateStr || startDateStr) : null;
      const hasLeaveConflict = leaveRecord ? isLeaveConflict(leaveRecord, projStartTime, projEndTime) : false;
      const disabledAttr = hasLeaveConflict ? ` disabled` : "";
      return `<option value="${w.id}"${disabledAttr}>${esc(w.name)}${hasLeaveConflict ? " 🌴 请假中" : ""}</option>`;
    }).join("");
  const assignBlock = `
    <div class="detail-block">
      <h3>🧑‍🔧 安装人员分配</h3>
      <p class="hint" style="margin:0 0 10px">提前为本项目分配安装人员。若某人在同一时间段已被分配到其它项目，将给出冲突提醒（仍可强制分配）。</p>
      <div class="assign-list">${assignedChips}</div>
      ${canAssign ? `
      <div class="assign-form">
        <select class="input" id="assignWorkerSel" onchange="showWorkerSchedule('${p.id}', this.value)">
          <option value="">请选择安装人员</option>
          ${assignSelectOpts || ``}
        </select>
        <button class="btn primary" onclick="assignWorker('${p.id}')">分配</button>
      </div>
      <div id="workerSchedule" class="worker-schedule"></div>` : ""}
      ${canEdit ? `
      <div class="outsourced-block">
        <h4>🤝 外协人员</h4>
        <p class="hint" style="margin:0 0 8px;font-size:12px">当任务由外协人员完成时，填写外协人员姓名（分别输入后按添加）。设置外协后，该任务不占用内部施工人员工时，时间冲突将被解除。</p>
        <div class="assign-list">${(p.outsourcedWorkers || "").split(/[,，]/).filter(n => n.trim()).map(n => `<span class="assign-chip outsourced"><span style="color:#8b5cf6">🤝</span> ${esc(n.trim())}<button class="chip-x" onclick="removeOutsourcedWorker('${p.id}', '${(n.trim() || "").replace(/'/g, "\\'")}')" title="移除">✕</button></span>`).join("") || `<span class="hint" style="margin:0">尚未添加外协人员</span>`}</div>
        <div style="margin-bottom:8px;">
          <select class="input" id="outsourcedWorkersSelect_${p.id}" onchange="addOutsourcedWorker('${p.id}', this.value)">
            <option value="">从常用外协人员列表添加</option>
            ${cache.outsourcedWorkers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}${w.phone ? ` (${esc(w.phone)})` : ''}</option>`).join("")}
          </select>
        </div>
        <div class="assign-form" style="margin-bottom:0">
          <input type="text" class="input" id="outsourcedWorkersInput_${p.id}" placeholder="输入外协人员姓名" onkeydown="if(event.key==='Enter'){addOutsourcedWorkerByName('${p.id}', this.value);this.value=''}">
          <button class="btn primary" onclick="addOutsourcedWorkerByName('${p.id}', document.getElementById('outsourcedWorkersInput_${p.id}').value)">添加</button>
        </div>
        ${p.outsourcedWorkers ? `<div class="outsourced-hint">当前任务已设置为外协</div>` : ""}
      </div>` : ""}
    </div>`;

  const end = new Date(p.endTime || p.startTime);
  const isOverdue = p.status === STATUS.BOOKED && !p.startedAt && new Date() > end;
  
  box.innerHTML = `
    <div class="detail-block">
      <h3>📋 项目信息 <span class="badge ${p.status}">${p.status}</span>${isOverdue ? `<span class="badge overdue">🔴 超期</span>` : ""}</h3>
      ${reviewed ? `<p class="hint" style="margin:0 0 10px;color:var(--warn)">⚠️ 该项目已审核，信息不可更改。</p>` : ""}
      ${canEdit || reviewed ? "" : `<p class="hint" style="margin:0 0 10px">当前角色为只读，施工工时与验收由施工人员/总经理填写。</p>`}
      <div class="info-grid">
        <div class="info-item"><div class="k">项目名称</div><div class="v">${esc(p.name)}</div></div>
        <div class="info-item"><div class="k">预约门店</div><div class="v">${esc(storeName(p.storeId))}</div></div>
        <div class="info-item"><div class="k">客户</div><div class="v">${esc(p.customer || "—")}</div></div>
        <div class="info-item"><div class="k">联系电话</div><div class="v">${p.phone ? `<a href="tel:${esc(p.phone)}" style="color:var(--info)">${esc(p.phone)}</a>` : "—"}</div></div>
        <div class="info-item"><div class="k">安装地址</div><div class="v">${esc(p.address || "—")}</div></div>
        <div class="info-item"><div class="k">预约时段</div><div class="v">${fmtTimeRange(p)}</div></div>
        <div class="info-item"><div class="k">预计工时</div><div class="v">${p.estimatedHours || 0} 小时</div></div>
        <div class="info-item"><div class="k">外协工时</div><div class="v" style="color:#8b5cf6;font-weight:600">${p.outsourcedHoursFromLogs || 0} 小时</div></div>
        <div class="info-item"><div class="k">工程实际用工时</div><div class="v">${((p.workLogs || []).reduce((sum, l) => sum + (Number(l.hours) || 0), 0)) || 0} 小时</div></div>
        <div class="info-item"><div class="k">工时差异（实际−预计）</div><div class="v">${diffLabel(p)}</div></div>
        ${p.startedAt ? `<div class="info-item"><div class="k">⏰ 开始施工时间</div><div class="v">${esc(fmtDateTime(p.startedAt))}</div></div>` : ""}
        ${p.finishedAt ? `<div class="info-item"><div class="k">✅ 完工时间</div><div class="v">${esc(fmtDateTime(p.finishedAt))}</div></div>` : ""}
        ${p.startedAt && p.finishedAt ? `<div class="info-item"><div class="k">⏱️ 实际施工时长</div><div class="v"><b>${esc(calcActualWorkDuration(p))}</b></div></div>` : ""}
      </div>
      ${p.estimatedHours > 0 ? `
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="font-size:13px;color:var(--muted)">项目进度</span>
          <span style="font-weight:bold;font-size:14px;">${(() => {
            const { est, act, hasActual } = hoursDiff(p);
            return Math.round(getProjectProgress(p, est, act, hasActual, totalHours)) + '%';
          })()}</span>
          ${p.status === STATUS.PAUSED && p.pauseReason ? `<span style="font-size:12px;color:#f59e0b;margin-left:8px;">暂停原因：${esc(p.pauseReason)}</span>` : ""}
          ${p.status === STATUS.DELAYED && p.delayReason ? `<span style="font-size:12px;color:#ef4444;margin-left:8px;">延期原因：${esc(p.delayReason)}</span>` : ""}
        </div>
        <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${(() => {
            const { est, act, hasActual } = hoursDiff(p);
            return Math.min(100, getProjectProgress(p, est, act, hasActual, totalHours)) + '%';
          })()};background:${(() => {
            const { est, act, hasActual } = hoursDiff(p);
            const progress = getProjectProgress(p, est, act, hasActual, totalHours);
            if (progress >= 100) return '#10b981';
            if (p.status === STATUS.PAUSED) return '#f59e0b';
            if (p.status === STATUS.DELAYED) return '#dc2626';
            return '#3b82f6';
          })()};border-radius:4px;transition:width 0.3s ease;"></div>
        </div>
      </div>` : ""}
      ${canEdit || (canReview && !reviewed) ? `
      <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:16px;align-items:center">
        <div style="display:flex;align-items:center;gap:8px">
          <label style="font-size:13px;color:var(--muted)">状态</label>
          <select class="input" id="cStatus" onchange="updateProjectStatus('${p.id}', this.value)" style="width:auto;min-width:100px;">
            <option value="${p.status}" selected>${p.status}</option>
            ${getAllowedStatuses(p.status).map((s) =>
              `<option value="${s}">${s}</option>`).join("")}
          </select>
        </div>
        
        ${canReview && !reviewed ? `
        <button class="btn small primary" onclick="reviewProject('${p.id}')">✅ 审核项目</button>
        ` : ""}
        ${p.status === STATUS.WORKING ? `
        <button class="btn small" style="background:#f59e0b;color:#fff" onclick="pauseProject('${p.id}')">⏸️ 暂停施工</button>
        <button class="btn small" style="background:#ef4444;color:#fff" onclick="delayProject('${p.id}')">📅 项目延期</button>
        ` : ""}
        ${p.status === STATUS.PAUSED ? `
        <button class="btn small primary" onclick="resumeProject('${p.id}')">▶️ 恢复施工</button>
        <button class="btn small" style="background:#ef4444;color:#fff" onclick="delayProject('${p.id}')">📅 项目延期</button>
        ` : ""}
        ${p.status === STATUS.DELAYED ? `
        <button class="btn small primary" onclick="resumeProject('${p.id}')">▶️ 恢复施工</button>
        ` : ""}
        ${[STATUS.BOOKED, STATUS.WORKING, STATUS.PAUSED, STATUS.DELAYED].includes(p.status) ? `
        <button class="btn small danger" onclick="cancelProject('${p.id}')"><span style="font-size:16px;font-weight:bold;">×</span> 取消项目</button>
        ` : ""}
      </div>` : ""}
      ${reviewed && perm.unreviewProject(p) ? `
      <div class="card-actions" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn" onclick="unreviewProject('${p.id}')" style="color:var(--warn)">↩ 反审核</button>
      </div>` : ""}
      ${(reviewed || p.status === STATUS.ACCEPTED) && perm.createRepair() ? `
      <div class="card-actions" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn" onclick="openRepairOrderForm('${p.id}')" style="background:#f59e0b;color:#fff">🔧 发起维修单</button>
      </div>` : ""}
    </div>

    ${p.repairOrder ? `
    <div class="detail-block" style="border-left:4px solid #f59e0b">
      <h3>🔧 维修单信息</h3>
      <div class="info-grid">
        <div class="info-item"><div class="k">维修项目</div><div class="v" style="color:#f59e0b">${esc(p.repairOrder.items || "—")}</div></div>
        <div class="info-item"><div class="k">维修原因</div><div class="v">${esc(p.repairOrder.reason || "—")}</div></div>
        <div class="info-item"><div class="k">预约维修时间</div><div class="v">${p.repairOrder.appointmentTime ? fmtDateTime(p.repairOrder.appointmentTime) : "—"}</div></div>
        <div class="info-item"><div class="k">维修状态</div><div class="v">${p.repairOrder.status || "待维修"}</div></div>
      </div>
      ${perm.completeRepair() && p.repairOrder.status === "待维修" ? `
      <div class="card-actions" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn primary" onclick="completeRepair('${p.id}')">✅ 完成维修</button>
      </div>` : ""}
    </div>` : ""}

    ${assignBlock}

    ${(p.startedAt || p.finishedAt || p.workSessions.length > 0 || p.pauseCount > 0 || p.reviewedAt || p.pauseHistory.length > 0 || p.delayHistory.length > 0 || p.workerChangeHistory.length > 0 || p.actionLogs.length > 0) ? `
    <div class="detail-block">
      <h3>📝 施工记录</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;">
        ${p.startedAt ? `<div style="background:#f0f9ff;border-radius:8px;padding:10px;">
          <div style="font-size:11px;color:#0369a1;margin-bottom:2px;">🚀 开工时间</div>
          <div style="font-size:14px;font-weight:600;color:#1e40af;">${esc(fmtDateTime(p.startedAt))}</div>
        </div>` : ""}
        ${p.finishedAt ? `<div style="background:#ecfdf5;border-radius:8px;padding:10px;">
          <div style="font-size:11px;color:#047857;margin-bottom:2px;">✅ 完工时间</div>
          <div style="font-size:14px;font-weight:600;color:#065f46;">${esc(fmtDateTime(p.finishedAt))}</div>
        </div>` : ""}
        ${p.reviewedAt ? `<div style="background:#fef3c7;border-radius:8px;padding:10px;">
          <div style="font-size:11px;color:#b45309;margin-bottom:2px;">🔍 审核时间</div>
          <div style="font-size:14px;font-weight:600;color:#92400e;">${esc(fmtDateTime(p.reviewedAt))}</div>
        </div>` : ""}
        ${p.startedAt ? `<div style="background:#e0e7ff;border-radius:8px;padding:10px;">
          <div style="font-size:11px;color:#6366f1;margin-bottom:2px;">⏱️ 工时时长</div>
          <div style="font-size:14px;font-weight:600;color:#4338ca;">${(() => {
            const projectEndTime = getProjectEffectiveEndTime(p);
            let totalHours = 0;
            (p.assignedWorkerIds || []).forEach(wid => {
              const periods = buildWorkerPeriods(p, wid);
              periods.forEach(pr => {
                const start = new Date(pr.start);
                const end = pr.end ? new Date(pr.end) : projectEndTime;
                let dur = (end - start) / (1000 * 60 * 60);
                (p.pauseHistory || []).forEach(ph => {
                  if (ph.pauseAt && ph.resumedAt) {
                    const ps = new Date(ph.pauseAt);
                    const pe = new Date(ph.resumedAt);
                    const os = ps > start ? ps : start;
                    const oe = pe < end ? pe : end;
                    if (oe > os) dur -= (oe - os) / (1000 * 60 * 60);
                  }
                });
                totalHours += dur;
              });
            });
            return Math.round(totalHours * 10) / 10;
          })().toFixed(1)} 小时</div>
        </div>` : ""}
      </div>
      
      ${p.pauseHistory.length > 0 ? `
      <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-size:12px;color:#92400e;font-weight:500;margin-bottom:8px;">⏸️ 暂停/恢复明细</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${p.pauseHistory.map((ph, idx) => {
            const pauseTime = new Date(ph.pauseAt);
            const pauseStr = `${pauseTime.getMonth() + 1}/${pauseTime.getDate()} ${String(pauseTime.getHours()).padStart(2, "0")}:${String(pauseTime.getMinutes()).padStart(2, "0")}`;
            const resumeStr = ph.resumedAt ? ((() => {
              const resumeTime = new Date(ph.resumedAt);
              return `${resumeTime.getMonth() + 1}/${resumeTime.getDate()} ${String(resumeTime.getHours()).padStart(2, "0")}:${String(resumeTime.getMinutes()).padStart(2, "0")}`;
            })()) : "未恢复";
            const durHours = ph.duration ? Math.floor(ph.duration) : 0;
            const durMins = ph.duration ? Math.floor((ph.duration - durHours) * 60) : 0;
            const durStr = ph.duration ? (durHours > 0 ? `${durHours}h${durMins}m` : `${durMins}m`) : "";
            return `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px;color:#78350f;">
              <span style="font-weight:600;">第${idx + 1}次：</span>
              <span>⏸ ${pauseStr}</span>
              <span>→</span>
              <span>▶ ${resumeStr}</span>
              ${durStr ? `<span style="color:#f59e0b;font-weight:500;">(${durStr})</span>` : ""}
              ${ph.reason ? `<span>· 原因：${esc(ph.reason)}</span>` : ""}
            </div>`;
          }).join("")}
        </div>
      </div>` : p.pauseCount > 0 ? `
      <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-size:12px;color:#92400e;font-weight:500;margin-bottom:6px;">⏸️ 暂停记录</div>
        <div style="font-size:13px;color:#78350f;">已暂停 ${p.pauseCount} 次，累计暂停 ${(() => {
          const pauseDuration = derivePauseDuration(p);
          const hours = Math.floor(pauseDuration);
          const mins = Math.floor((pauseDuration - hours) * 60);
          return hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`;
        })()}，已从总用时中扣除</div>
      </div>` : ""}
      
      ${p.delayHistory.length > 0 ? `
      <div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-size:12px;color:#b91c1c;font-weight:500;margin-bottom:8px;">⚠️ 延期记录</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${p.delayHistory.map((dh, idx) => {
            const delayTime = new Date(dh.time);
            const timeStr = `${delayTime.getMonth() + 1}/${delayTime.getDate()} ${String(delayTime.getHours()).padStart(2, "0")}:${String(delayTime.getMinutes()).padStart(2, "0")}`;
            return `<div style="font-size:13px;color:#991b1b;">
              <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                <span style="font-weight:600;">第${idx + 1}次：</span>
                <span>${timeStr}</span>
                <span>${dh.originalDate} ${dh.originalTime}</span>
                <span>→</span>
                <span style="color:#ef4444;font-weight:600;">${dh.newDate} ${dh.newTime}</span>
              </div>
              <div style="margin-top:2px;padding-left:8px;color:#b91c1c;">原因：${esc(dh.reason)}</div>
            </div>`;
          }).join("")}
        </div>
      </div>` : ""}
      
      ${p.workerChangeHistory.length > 0 ? `
      <div style="background:#f0fdf4;border-left:4px solid #22c55e;border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-size:12px;color:#166534;font-weight:500;margin-bottom:8px;">👥 人员变动</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${p.workerChangeHistory.map((wch, idx) => {
            const changeTime = new Date(wch.time);
            const timeStr = `${changeTime.getMonth() + 1}/${changeTime.getDate()} ${String(changeTime.getHours()).padStart(2, "0")}:${String(changeTime.getMinutes()).padStart(2, "0")}`;
            return `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px;color:#15803d;">
              <span>${timeStr}</span>
              <span style="font-weight:600;">${wch.action === "assign" ? "➕ 分配" : "➖ 移除"}：</span>
              <span>${esc(wch.workerName)}</span>
              ${wch.workerPhone ? `<span>(${wch.workerPhone})</span>` : ""}
            </div>`;
          }).join("")}
        </div>
      </div>` : ""}
      
      ${p.workSessions.length > 0 ? `
      <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-size:12px;color:#1d4ed8;font-weight:500;margin-bottom:8px;">🔧 施工时段明细</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${p.workSessions.map((s, idx) => {
            const start = new Date(s.startTime);
            const end = new Date(s.endTime);
            const hours = Math.floor(s.duration);
            const mins = Math.floor((s.duration - hours) * 60);
            const durationStr = hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`;
            const startStr = `${start.getMonth() + 1}/${start.getDate()} ${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
            const endStr = `${end.getMonth() + 1}/${end.getDate()} ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
            return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#374151;">
              <span>第${idx + 1}段：${startStr} → ${endStr}</span>
              <span style="font-weight:600;color:#1d4ed8;">${durationStr}</span>
            </div>`;
          }).join("")}
          <div style="border-top:1px dashed #93c5fd;margin-top:4px;padding-top:4px;display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#1d4ed8;">
            <span style="font-weight:600;">合计</span>
            <span style="font-weight:600;">${(() => {
              const total = p.workSessions.reduce((sum, s) => sum + s.duration, 0);
              const hours = Math.floor(total);
              const mins = Math.floor((total - hours) * 60);
              return hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`;
            })()}</span>
          </div>
        </div>
      </div>` : ""}
      
      ${(() => {
        const workerLogs = {};
        (p.workLogs || []).forEach((log) => {
          const key = log.workerId || log.workerName || "unknown";
          if (!workerLogs[key]) {
            workerLogs[key] = { name: log.workerName, hours: 0, isOutsourced: log.isOutsourced || (log.workerId && log.workerId.startsWith("outsourced:")) };
          }
          workerLogs[key].hours += Number(log.hours) || 0;
        });
        
        const workerPeriods = {};
        (p.assignedWorkerIds || []).forEach((wid) => {
          workerPeriods[wid] = buildWorkerPeriods(p, wid);
        });
        
        (p.workerChangeHistory || []).forEach((ch) => {
          const wid = ch.workerId;
          if (ch.action === "unassign" && workerPeriods[wid]) {
            const lastPeriod = workerPeriods[wid][workerPeriods[wid].length - 1];
            if (lastPeriod) {
              lastPeriod.end = ch.time;
              lastPeriod.autoHours = ch.autoHours;
            }
          }
        });
        
        const periodEndTime = getProjectEffectiveEndTime(p).toISOString();
        (p.assignedWorkerIds || []).forEach((wid) => {
          if (workerPeriods[wid] && workerPeriods[wid].length > 0) {
            const lastPeriod = workerPeriods[wid][workerPeriods[wid].length - 1];
            if (!lastPeriod.end) {
              lastPeriod.end = periodEndTime;
            }
          }
        });
        
        const pauseDurations = {};
        (p.pauseHistory || []).forEach((ph) => {
          if (ph.pauseAt && ph.resumedAt) {
            const pauseStart = new Date(ph.pauseAt);
            const pauseEnd = new Date(ph.resumedAt);
            pauseDurations[ph.pauseAt] = (pauseEnd - pauseStart) / (1000 * 60 * 60);
          }
        });
        
        const allWorkers = new Set([...(p.assignedWorkerIds || []), ...Object.keys(workerLogs), ...Object.keys(workerPeriods)]);
        const workerStats = [];
        
        allWorkers.forEach((wid) => {
          const isAssigned = (p.assignedWorkerIds || []).includes(wid);
          const logEntry = workerLogs[wid];
          const worker = getWorker(wid);
          const name = logEntry ? logEntry.name : (worker ? worker.name : "未知");
          const isOutsourced = logEntry ? logEntry.isOutsourced : false;
          const periods = workerPeriods[wid] || [];
          
          let hours = 0;
          
          if (isAssigned && periods.length > 0) {
            hours = calcWorkerRealtimeHours(p, wid, periods);
          } else if (logEntry && logEntry.hours > 0) {
            hours = logEntry.hours;
          } else if (periods.length > 0) {
            hours = calcWorkerRealtimeHours(p, wid, periods);
          }
          
          hours = Math.round(hours * 10) / 10;
          
          workerStats.push({ name, hours, isAssigned, isOutsourced, id: wid, periods });
        });
        
        if (workerStats.length === 0) return "";
        
        return `
        <div style="background:#ecfdf5;border-left:4px solid #22c55e;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="font-size:12px;color:#166534;font-weight:500;margin-bottom:8px;">👷 工人工时统计</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${workerStats.map((ws) => `
              <div style="border-bottom:1px dashed #86efac;padding-bottom:6px;">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:4px;">
                  <span style="color:${ws.isAssigned ? "#15803d" : "#6b7280"}">
                    ${ws.name}${ws.isOutsourced ? ` <span style="color:#8b5cf6;font-size:11px">(外协)</span>` : ""}${!ws.isAssigned ? ` <span style="color:#9ca3af;font-size:11px">(已移除)</span>` : ""}
                  </span>
                  <span style="font-weight:600;color:${ws.isAssigned ? "#166534" : "#9ca3af"};">${ws.hours.toFixed(1)} 工时</span>
                </div>
                ${ws.periods.length > 0 ? `
                  <div style="display:flex;flex-direction:column;gap:2px;padding-left:8px;">
                    ${ws.periods.map((pr) => `
                      <div style="font-size:11px;color:#65a30d;">
                        ${fmtDateShort(pr.start)} ${fmtTime(pr.start)} - ${pr.end ? fmtDateShort(pr.end) + " " + fmtTime(pr.end) : "至今"}
                        ${pr.autoHours ? ` <span style="color:#f59e0b;">(自动记录 ${pr.autoHours} 工时)</span>` : ""}
                      </div>
                    `).join("")}
                  </div>
                ` : ""}
              </div>
            `).join("")}
            <div style="border-top:1px dashed #86efac;margin-top:4px;padding-top:4px;display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#166534;">
              <span style="font-weight:600;">合计</span>
              <span style="font-weight:600;">${workerStats.reduce((sum, ws) => sum + ws.hours, 0).toFixed(1)} 工时</span>
            </div>
          </div>
        </div>`;
      })()}
      
      ${p.actionLogs.length > 0 ? `
      <div style="background:#f9fafb;border-left:4px solid #6b7280;border-radius:8px;padding:12px;">
        <div style="font-size:12px;color:#4b5563;font-weight:500;margin-bottom:8px;">📋 操作日志</div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${p.actionLogs.slice().reverse().map((log) => {
            const logTime = new Date(log.time);
            const timeStr = `${logTime.getMonth() + 1}/${logTime.getDate()} ${String(logTime.getHours()).padStart(2, "0")}:${String(logTime.getMinutes()).padStart(2, "0")}`;
            const iconMap = { start: "🚀", pause: "⏸️", resume: "▶️", delay: "⚠️", assign: "👥", unassign: "➖", finish: "✅", review: "🔍" };
            const icon = iconMap[log.action] || "📋";
            return `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:#6b7280;">
              <span>${icon}</span>
              <span style="font-weight:500;">${timeStr}</span>
              <span>${esc(log.description)}</span>
            </div>`;
          }).join("")}
        </div>
      </div>` : ""}
    </div>` : ""}

    <div class="detail-block">
      <h3>👷 施工人员工时（分人填写）</h3>
      <table class="data">
        <thead>
          <tr><th>施工人员</th><th>施工日期</th><th>施工工时</th><th>等级</th><th>说明</th><th></th></tr>
        </thead>
        <tbody>${logsRows}</tbody>
        <tfoot>
          <tr><td colspan="3">合计施工工时</td><td colspan="3">${totalHours} 小时</td></tr>
        </tfoot>
      </table>

      ${canEdit ? `
      <div class="worklog-form">
        <div class="field">
          <label>人员类型</label>
          <select class="input" id="logType" onchange="toggleLogWorkerType()">
            <option value="internal">内部施工人员</option>
            <option value="outsourced">外协人员</option>
          </select>
        </div>
        <div class="field" id="logInternalWorkerField">
          <label>选择施工人员</label>
          <select class="input" id="logWorker">
            ${workerOptions || `<option value="">请先添加人员</option>`}
          </select>
        </div>
        <div class="field outsourced-field" id="logOutsourcedField" style="display:none">
          <label>外协人员</label>
          <small class="hint" style="font-size:11px;color:#8b5cf6;margin-bottom:4px;display:block;">可从常用列表选择，或手动输入新的外协人员</small>
          <div style="display:flex;gap:6px;align-items:center;">
            <select class="input" id="logOutsourcedSelect" onchange="updateLogOutsourcedInput()">
              <option value="">从常用列表选择</option>
              ${cache.outsourcedWorkers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}${w.phone ? ` (${esc(w.phone)})` : ''}</option>`).join("")}
            </select>
            <input class="input" id="logOutsourcedName" placeholder="或手动输入" />
          </div>
        </div>
        <div class="field">
          <label>施工日期</label>
          <input class="input" type="date" id="logDate" value="${new Date().toISOString().slice(0,10)}" />
        </div>
        <div class="field">
          <label>施工工时(小时)</label>
          <input class="input" type="number" min="0" step="0.5" id="logHours" placeholder="0" style="width:120px" />
        </div>
        <div class="field">
          <label>工时等级</label>
          <select class="input" id="logLevel" style="width:100px">
            <option value="初级">初级</option>
            <option value="中级" selected>中级</option>
            <option value="高级">高级</option>
            <option value="特级">特级</option>
          </select>
        </div>
        <div class="field" style="flex:1;min-width:150px">
          <label>说明</label>
          <input class="input" id="logNote" placeholder="选填" />
        </div>
        <button class="btn primary" onclick="addWorkLog('${p.id}')">添加工时</button>
      </div>` : ""}
    </div>

    <div class="detail-block">
      <h3>✅ 验收信息</h3>
      ${ac ? `
        <div class="info-grid">
          <div class="info-item"><div class="k">验收人</div><div class="v">${esc(ac.acceptedBy)}</div></div>
          <div class="info-item"><div class="k">验收时间</div><div class="v">${fmtDate(ac.acceptedAt)}</div></div>
          <div class="info-item"><div class="k">验收类型</div><div class="v">${esc(ac.type || "—")}</div></div>
          <div class="info-item"><div class="k">验收方式</div><div class="v">${esc(ac.method || "—")}</div></div>
          <div class="info-item"><div class="k">验收结果</div><div class="v">${esc(ac.quality)}</div></div>
          <div class="info-item"><div class="k">验收结论</div><div class="v">${esc(ac.conclusion || "—")}</div></div>
        </div>
        ${ac.items && ac.items.length > 0 ? `
        <div style="margin-top:10px">
          <div class="k">验收项检查</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;">
            ${ac.items.map(item => `<span class="badge">✓ ${esc(item)}</span>`).join("")}
          </div>
        </div>` : ""}
        <div class="info-item" style="margin-top:10px"><div class="k">验收备注</div><div class="v" style="font-weight:400">${esc(ac.note || "—")}</div></div>
        ${canEdit ? `<div class="card-actions"><button class="btn small" onclick="openAcceptance('${p.id}')">修改验收</button></div>` : ""}
      ` : (canEdit ? `
        <p class="hint" style="margin:0 0 10px">项目完成后填写验收信息。</p>
        <button class="btn primary" onclick="openAcceptance('${p.id}')">填写验收信息</button>
      ` : `<p class="hint" style="margin:0">暂无验收信息。</p>`)}
    </div>
  `;
}

/* 找出某安装人员已被分配、且与本项目时间段重叠的其它项目 */
function assignConflicts(project, workerId) {
  const s = projectStart(project), e = projectEnd(project);
  if (!s || !e) return [];
  return cache.projects.filter((o) => {
    if (o.id === project.id) return false;
    if (isCompleted(o)) return false;
    if (!(o.assignedWorkerIds || []).includes(workerId)) return false;
    const os = projectStart(o), oe = projectEnd(o);
    return os && oe && intervalsOverlap(s, e, os, oe);
  });
}

/* 判断项目是否已完成（不参与人员冲突检测） */
function isCompleted(p) {
  // 注意：CANCELLED 状态也视为"无需后续操作"，与 DONE/REVIEWED/ACCEPTED 一致
  return [STATUS.DONE, STATUS.REVIEWED, STATUS.ACCEPTED, STATUS.CANCELLED].includes(p.status);
}

/* 判断项目是否为外协任务（只有外协人员，没有内部施工人员） */
function isOutsourced(p) {
  const hasInternal = (p.assignedWorkerIds || []).length > 0;
  const hasOutsourced = (p.outsourcedWorkers || "").trim().length > 0;
  return !hasInternal && hasOutsourced;
}

/* 检查工人在指定日期是否处于请假状态 */
function isWorkerOnLeave(workerId, dateStr) {
  if (!workerId || !dateStr) return null;
  return cache.leaveRecords.find((l) => {
    if (l.workerId !== workerId) return false;
    if (l.status !== "approved") return false;
    return dateStr >= l.startDate && dateStr <= l.endDate;
  });
}

/* 检查工人在项目时间段内是否有请假冲突 */
function getProjectLeaveConflict(workerId, projectStartDate, projectEndDate) {
  if (!workerId || !projectStartDate || !projectEndDate) return null;
  
  const start = new Date(projectStartDate);
  const end = new Date(projectEndDate);
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = fmtDate(d);
    const leaveRecord = isWorkerOnLeave(workerId, dateStr);
    if (leaveRecord) return leaveRecord;
  }
  
  return null;
}

/* 判断请假时段与项目时段是否冲突 */
function isLeaveConflict(leaveRecord, projectStartTime, projectEndTime) {
  if (!leaveRecord) return false;
  
  const typeTimes = {
    all: { start: "00:00", end: "23:59" },
    morning: { start: "08:00", end: "12:00" },
    afternoon: { start: "13:00", end: "18:00" },
  };
  
  const leaveStart = leaveRecord.startType === "custom" && leaveRecord.startTime
    ? leaveRecord.startTime
    : (typeTimes[leaveRecord.startType] || typeTimes.all).start;
  
  const leaveEnd = leaveRecord.endType === "custom" && leaveRecord.endTime
    ? leaveRecord.endTime
    : (typeTimes[leaveRecord.endType] || typeTimes.all).end;
  
  const projStart = projectStartTime || "08:00";
  const projEnd = projectEndTime || "18:00";
  
  return !(leaveEnd <= projStart || leaveStart >= projEnd);
}

/* 检查施工人员在项目时段内是否有日程冲突 */
function getProjectScheduleConflict(workerId, projectStartDate, projectEndDate, projectStartTime, projectEndTime) {
  if (!workerId || !projectStartDate || !projectEndDate) return null;
  
  const start = new Date(projectStartDate);
  const end = new Date(projectEndDate);
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = fmtDate(d);
    const schedules = cache.workerSchedules.filter(s => s.workerId === workerId && s.startDate === dateStr);
    
    for (const schedule of schedules) {
      const scheduleStart = schedule.startTime || "00:00";
      const scheduleEnd = schedule.endTime || "23:59";
      const projStart = projectStartTime || "08:00";
      const projEnd = projectEndTime || "18:00";
      
      if (!(scheduleEnd <= projStart || scheduleStart >= projEnd)) {
        return schedule;
      }
    }
  }
  
  return null;
}

/* 获取工人的所有请假记录 */
function getWorkerLeaveRecords(workerId) {
  return cache.leaveRecords.filter((l) => l.workerId === workerId && l.status === "approved");
}

/* 格式化请假时间显示 */
function formatLeaveTime(lr) {
  let startPart = lr.startDate;
  if (lr.startTime) {
    startPart += ` ${lr.startTime}`;
  } else if (lr.startType) {
    const typeLabels = { all: "", morning: "上午", afternoon: "下午", custom: "" };
    startPart += ` ${typeLabels[lr.startType] || ""}`;
  }
  let endPart = lr.endDate;
  if (lr.endTime) {
    endPart += ` ${lr.endTime}`;
  } else if (lr.endType) {
    const typeLabels = { all: "", morning: "上午", afternoon: "下午", custom: "" };
    endPart += ` ${typeLabels[lr.endType] || ""}`;
  }
  return `${startPart} ~ ${endPart}`;
}

/* 获取某安装人员在指定日期已分配的项目列表 */
function getWorkerAssignmentsOnDate(workerId, dateStr) {
  if (!workerId || !dateStr) return [];
  const [y, m, d] = dateStr.split("-").map(Number);
  const targetDate = new Date(y, m - 1, d);
  const nextDate = new Date(y, m - 1, d + 1);
  return cache.projects.filter((p) => {
    if (!(p.assignedWorkerIds || []).includes(workerId)) return false;
    const s = projectStart(p);
    if (!s) return false;
    return s >= targetDate && s < nextDate;
  }).sort((a, b) => {
    const sa = projectStart(a), sb = projectStart(b);
    return (sa || new Date()).getTime() - (sb || new Date()).getTime();
  });
}

/* 格式化时间段显示（仅当天时间） */
function fmtTimeOnly(p) {
  const s = projectStart(p);
  const e = projectEnd(p);
  if (!s) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  const startStr = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
  if (!e) return startStr;
  return `${startStr} ~ ${pad(e.getHours())}:${pad(e.getMinutes())}`;
}

/* 显示安装人员当天已分配的时间段 */
function showWorkerSchedule(pid, workerId) {
  const container = document.getElementById("workerSchedule");
  if (!container) return;
  if (!workerId) {
    container.innerHTML = "";
    return;
  }
  const p = getProject(pid);
  if (!p) return;
  const s = projectStart(p);
  if (!s) {
    container.innerHTML = `<p class="hint" style="margin:8px 0 0">请先设置项目预约时间</p>`;
    return;
  }
  const dateStr = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
  const assignments = getWorkerAssignmentsOnDate(workerId, dateStr);
  const w = getWorker(workerId);
  const workerName = w ? w.name : "未知人员";
  
  if (!assignments.length) {
    container.innerHTML = `
      <div class="worker-schedule-box">
        <div class="worker-schedule-title">📅 ${workerName} 在 ${dateStr} 的安排</div>
        <div class="worker-schedule-empty">✓ 当天暂无其他分配</div>
      </div>`;
    return;
  }
  
  const currentProject = assignments.find((a) => a.id === pid);
  const itemsHtml = assignments.map((item) => {
    const isCurrent = item.id === pid;
    const conflicts = assignConflicts(item, workerId);
    const conflictCount = conflicts.length;
    return `
      <div class="worker-schedule-item ${isCurrent ? "current" : ""} ${conflictCount > 0 ? "conflict" : ""}">
        <div class="worker-schedule-time">${fmtTimeOnly(item)}</div>
        <div class="worker-schedule-project">${esc(item.name)}</div>
        <div class="worker-schedule-meta">${esc(storeName(item.storeId))} · ${item.estimatedHours}h · ${item.status}${conflictCount > 0 ? ` · ⚠${conflictCount}冲突` : ""}</div>
      </div>`;
  }).join("");
  
  container.innerHTML = `
    <div class="worker-schedule-box">
      <div class="worker-schedule-title">📅 ${workerName} 在 ${dateStr} 的安排</div>
      <div class="worker-schedule-list">${itemsHtml}</div>
      ${currentProject ? `<div class="worker-schedule-hint">当前项目已标记</div>` : ""}
    </div>`;
}

async function assignWorker(pid) {
  const sel = document.getElementById("assignWorkerSel");
  const wid = sel ? sel.value : "";
  if (!wid) { toast("请选择安装人员"); return; }
  const p = getProject(pid);
  if (isCompleted(p)) { toast("项目已完工，不允许再分配人员"); return; }
  const cur = p.assignedWorkerIds || [];
  if (cur.includes(wid)) { toast("该人员已分配"); return; }
  
  const s = projectStart(p);
  const e = projectEnd(p);
  
  const pad = (n) => String(n).padStart(2, "0");
  const projStartTime = s ? `${pad(s.getHours())}:${pad(s.getMinutes())}` : "08:00";
  const projEndTime = e ? `${pad(e.getHours())}:${pad(e.getMinutes())}` : "18:00";
  
  const startDateStr = s ? `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}` : null;
  const endDateStr = e ? `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}` : startDateStr;
  
  const leaveRecord = startDateStr ? getProjectLeaveConflict(wid, startDateStr, endDateStr || startDateStr) : null;
  const hasLeaveConflict = leaveRecord ? isLeaveConflict(leaveRecord, projStartTime, projEndTime) : false;
  
  if (hasLeaveConflict) {
    const w = getWorker(wid);
    toast(`${w ? w.name : "该人员"} 在此时间段正在请假，无法分配！\n请假时段：${formatLeaveTime(leaveRecord)}`);
    return;
  }
  
  const scheduleConflict = startDateStr ? getProjectScheduleConflict(wid, startDateStr, endDateStr || startDateStr, projStartTime, projEndTime) : null;
  if (scheduleConflict) {
    const w = getWorker(wid);
    toast(`${w ? w.name : "该人员"} 在此时间段已有日程安排，无法分配！\n日程：${scheduleConflict.title}（${scheduleConflict.startDate} ${scheduleConflict.startTime || "全天"} ~ ${scheduleConflict.endDate} ${scheduleConflict.endTime || "全天"}）`);
    return;
  }
  
  const conflicts = assignConflicts(p, wid);
  if (conflicts.length) {
    const w = getWorker(wid);
    const msg = `${w ? w.name : "该人员"} 在此时间段已被分配到：<br>` +
      conflicts.map((c) => `· ${c.name}（${fmtTimeRange(c)}）`).join("<br>") +
      `<br><br>存在时间冲突，仍要分配吗？`;
    if (!(await confirmDialog(msg, "时间冲突"))) return;
  }
  
  const worker = getWorker(wid);
  const workerChangeHistory = [...(p.workerChangeHistory || [])];
  workerChangeHistory.push({
    time: new Date().toISOString(),
    action: "assign",
    workerId: wid,
    workerName: worker ? worker.name : "未知",
    workerPhone: worker ? worker.phone : ""
  });
  
  const actionLogs = [...(p.actionLogs || [])];
  actionLogs.push({
    time: new Date().toISOString(),
    action: "assign",
    description: `分配安装人员：${worker ? worker.name : "未知"}`,
    operator: currentProfile.name || currentUser?.email || "系统",
    operatorRole: currentProfile.role
  });
  
  try {
    await repo.setAssignedWorkers(pid, cur.concat(wid));
    await repo.patchProject(pid, { workerChangeHistory, actionLogs });
    await repo.loadAll();
    renderAll();
    toast(conflicts.length ? "已分配（存在时间冲突）" : "已分配安装人员");
    logOperation("PROJECT_ASSIGN", p.name || "项目", `ID: ${pid}, 人员: ${worker ? worker.name : "未知"}${worker?.phone ? `(${worker.phone})` : ""}`);
  } catch (error) {
    console.error("分配人员失败:", error);
    toast("分配失败，请重试");
  }
}

/* 保存外协人员信息 */
async function saveOutsourcedWorkers(pid, names) {
  const p = getProject(pid);
  if (!p) return;
  const oldWorkers = (p.outsourcedWorkers || "").split(/[,，]/).map(n => n.trim()).filter(n => n);
  const newWorkers = names.trim().split(/[,，]/).map(n => n.trim()).filter(n => n);
  
  const added = newWorkers.filter(n => !oldWorkers.includes(n));
  const removed = oldWorkers.filter(n => !newWorkers.includes(n));
  
  await repo.saveProject({ outsourcedWorkers: names.trim() }, pid);
  await repo.loadAll();
  renderAll();
  toast(names.trim() ? "外协人员已保存，该任务不再占用内部施工人员" : "外协人员已清除");
  
  added.forEach(name => {
    logOperation("PROJECT_OUTSOURCE_ADD", p.name || "项目", `ID: ${pid}, 外协人员: ${name}`);
  });
  removed.forEach(name => {
    logOperation("PROJECT_OUTSOURCE_REMOVE", p.name || "项目", `ID: ${pid}, 外协人员: ${name}`);
  });
}

/* 添加单个外协人员 */
async function addOutsourcedWorker(pid, name) {
  const p = getProject(pid);
  if (!p || !name.trim()) return;
  const currentWorkers = (p.outsourcedWorkers || "").split(/[,，]/).map(n => n.trim()).filter(n => n);
  if (currentWorkers.includes(name.trim())) {
    toast("该外协人员已添加");
    return;
  }
  currentWorkers.push(name.trim());
  await saveOutsourcedWorkers(pid, currentWorkers.join(","));
}

/* 通过名称添加外协人员 */
async function addOutsourcedWorkerByName(pid, name) {
  const names = (name || "").split(/[,，]/).map(n => n.trim()).filter(n => n);
  for (const n of names) {
    await addOutsourcedWorker(pid, n);
  }
}

/* 移除单个外协人员 */
async function removeOutsourcedWorker(pid, name) {
  const p = getProject(pid);
  if (!p || !name.trim()) return;
  const currentWorkers = (p.outsourcedWorkers || "").split(/[,，]/).map(n => n.trim()).filter(n => n);
  const newWorkers = currentWorkers.filter(n => n !== name.trim());
  await saveOutsourcedWorkers(pid, newWorkers.join(","));
}

async function unassignWorker(pid, wid) {
  const p = getProject(pid);
  if (isCompleted(p)) { toast("项目已完工，不允许移除人员"); return; }
  const next = (p.assignedWorkerIds || []).filter((x) => x !== wid);
  
  const worker = getWorker(wid);
  const workerChangeHistory = [...(p.workerChangeHistory || [])];
  
  const now = new Date();
  const nowStr = now.toISOString();
  
  let autoHours = 0;
  if (p.status === STATUS.WORKING && p.startedAt) {
    const started = new Date(p.startedAt);
    let endTime = now;
    if (p.status === STATUS.PAUSED && p.pausedAt) {
      endTime = new Date(p.pausedAt);
    }
    const workDuration = (endTime - started) / (1000 * 60 * 60);
    const workerCount = (p.assignedWorkerIds || []).length;
    autoHours = Math.round((workDuration / workerCount) * 10) / 10;
  }
  
  workerChangeHistory.push({
    time: nowStr,
    action: "unassign",
    workerId: wid,
    workerName: worker ? worker.name : "未知",
    workerPhone: worker ? worker.phone : "",
    autoHours: autoHours > 0 ? autoHours : null,
    accumulatedWorkHoursAtRemoval: p.accumulatedWorkHours || 0
  });
  
  const actionLogs = [...(p.actionLogs || [])];
  let logDesc = `移除安装人员：${worker ? worker.name : "未知"}`;
  
  if (autoHours > 0) {
    logDesc += `，自动记录工时 ${autoHours} 小时`;
    
    const workLog = {
      id: 'log_' + Date.now() + '_' + wid,
      projectId: pid,
      workerId: wid,
      workerName: worker ? worker.name : "未知",
      hours: autoHours,
      date: dateKey(now),
      note: `系统自动计算：从${fmtDateTime(p.startedAt)}到${fmtDateTime(nowStr)}，共${autoHours}小时`,
      level: "中级",
      isOutsourced: false,
      createdAt: nowStr
    };
    
    await repo.addWorkLog(pid, workLog);
  }
  
  actionLogs.push({
    time: nowStr,
    action: "unassign",
    description: logDesc,
    operator: currentProfile.name || currentUser?.email || "系统",
    operatorRole: currentProfile.role
  });
  
  await repo.setAssignedWorkers(pid, next);
  await repo.patchProject(pid, { workerChangeHistory, actionLogs });
  await repo.loadAll();
  renderAll();
  toast(autoHours > 0 ? `已移除，自动记录 ${autoHours} 工时` : "已移除");
  logOperation("PROJECT_UNASSIGN", p.name || "项目", `ID: ${pid}, 人员: ${worker ? worker.name : "未知"}${worker?.phone ? `(${worker.phone})` : ""}, 自动记录工时: ${autoHours}`);
}

async function updateProjectStatus(id, newStatus) {
  const p = getProject(id);
  if (!p) {
    toast("项目不存在");
    return;
  }
  
  if (newStatus === p.status) {
    return;
  }
  
  const allowed = getAllowedStatuses(p.status);
  if (!allowed.includes(newStatus)) {
    toast(`无法从「${p.status}」变更为「${newStatus}」`);
    renderConstruction();
    return;
  }
  
  if (newStatus === STATUS.DONE) {
    openCompleteProjectForm(id);
    return;
  }
  
  if (newStatus === STATUS.ACCEPTED) {
    openAcceptance(id);
    return;
  }
  
  if (newStatus === STATUS.WORKING) {
    const assignedWorkers = p.assignedWorkerIds || [];
    if (assignedWorkers.length === 0) {
      toast("请先分配安装人员后再开始施工");
      renderConstruction();
      return;
    }
  }
  
  const patch = { status: newStatus };
  const now = new Date().toISOString();
  if (newStatus === STATUS.WORKING) {
    patch.startedAt = now;
    if (!p.originalStartedAt) {
      patch.originalStartedAt = now;
    }
    
    const actionLogs = [...(p.actionLogs || [])];
    actionLogs.push({
      time: now,
      action: "start",
      description: "开始施工",
      operator: currentProfile.name || currentUser?.email || "系统",
      operatorRole: currentProfile.role
    });
    patch.actionLogs = actionLogs;
    
    const workerChangeHistory = [...(p.workerChangeHistory || [])];
    const assignedWorkers = p.assignedWorkerIds || [];
    assignedWorkers.forEach(wid => {
      let hasActiveAssign = false;
      let lastAction = null;
      for (let i = 0; i < workerChangeHistory.length; i++) {
        const ch = workerChangeHistory[i];
        if (ch.workerId === wid) {
          lastAction = ch.action;
        }
      }
      if (lastAction === "assign") {
        hasActiveAssign = true;
      }
      if (!hasActiveAssign) {
        const worker = getWorker(wid);
        workerChangeHistory.push({
          time: now,
          action: "assign",
          workerId: wid,
          workerName: worker ? worker.name : "未知",
          workerPhone: worker ? worker.phone : ""
        });
      }
    });
    patch.workerChangeHistory = workerChangeHistory;
  }
  clearTimeout(reloadTimer);
  try {
    await repo.patchProject(id, patch);
    await repo.loadAll();
    renderAll();
    toast("状态已更新");
    
    if (newStatus === STATUS.WORKING) {
      sendNotificationForProjectChange("start", p);
      logOperation("PROJECT_START", p.name || "项目", `ID: ${id}`);
    } else if (newStatus === STATUS.DONE) {
      sendNotificationForProjectChange("done", p);
    } else if (newStatus === STATUS.ACCEPTED) {
      sendNotificationForProjectChange("accepted", p);
    }
  } catch (error) {
    console.error("更新状态失败:", error);
    toast("更新失败，请重试");
  }
}

async function pauseProject(id) {
  const p = getProject(id);
  if (!p) {
    toast("项目不存在");
    return;
  }
  if (p.status !== STATUS.WORKING) {
    toast("只有施工中的项目才能暂停");
    return;
  }
  
  const pauseReasons = ["客户原因", "材料不足", "天气原因", "其他"];
  
  const form = `
    <div class="form-row">
      <label><span style="color:#f59e0b;">📝</span> 暂停原因（可选）</label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
        ${pauseReasons.map(r => `<button class="btn small" onclick="document.getElementById('pauseReasonInput').value='${esc(r)}'">${esc(r)}</button>`).join("")}
      </div>
      <input type="text" id="pauseReasonInput" class="input" placeholder="选择快速原因或手动输入..." />
    </div>
  `;
  
  const result = await new Promise((resolve) => {
    let resolved = false;
    modal.open("暂停施工", form, {
      confirmText: "确认暂停",
      cancelText: "取消",
      onConfirm: () => {
        if (resolved) return;
        resolved = true;
        const input = document.getElementById("pauseReasonInput");
        const value = input ? input.value.trim() : "";
        resolve(value);
        return true;
      },
      onClose: () => {
        if (resolved) return;
        resolved = true;
        resolve(null);
      }
    });
    setTimeout(() => {
      const input = document.getElementById("pauseReasonInput");
      if (input) input.focus();
    }, 100);
  });
  
  if (result === null) return;
  const reason = result || null;
  
  try {
    const now = new Date();
    const nowStr = now.toISOString();
    
    const started = new Date(p.startedAt);
    const workDuration = (now - started) / (1000 * 60 * 60);
    const accumulatedWorkHours = (p.accumulatedWorkHours || 0) + workDuration;
    
    const workSessions = [...(p.workSessions || [])];
    workSessions.push({
      startTime: p.startedAt,
      endTime: nowStr,
      duration: workDuration
    });
    
    const pauseCount = (p.pauseCount || 0) + 1;
    
    const pauseHistory = [...(p.pauseHistory || [])];
    pauseHistory.push({
      pauseAt: nowStr,
      reason: reason,
      duration: null
    });
    
    const actionLogs = [...(p.actionLogs || [])];
    actionLogs.push({
      time: nowStr,
      action: "pause",
      description: `暂停施工${reason ? "，原因：" + reason : ""}`,
      operator: currentProfile.name || currentUser?.email || "系统",
      operatorRole: currentProfile.role
    });
    
    const patch = {
      status: STATUS.PAUSED,
      pausedAt: nowStr,
      pauseReason: reason,
      pauseCount: pauseCount,
      accumulatedWorkHours: accumulatedWorkHours,
      workSessions: workSessions,
      pauseHistory: pauseHistory,
      actionLogs: actionLogs
    };
    
    clearTimeout(reloadTimer);
    await repo.patchProject(id, patch);
    await repo.loadAll();
    renderAll();
    toast(`项目已暂停：${reason}`);
    sendNotificationForProjectChange("pause", getProject(id));
    logOperation("PROJECT_PAUSE", p.name || "项目", `ID: ${id}, 原因: ${reason || "未填写"}`);
  } catch (error) {
    console.error("暂停项目失败:", error);
    toast("暂停失败：" + (error.message || "未知错误"));
  }
}

async function resumeProject(id) {
  const p = getProject(id);
  if (!p) {
    toast("项目不存在");
    return;
  }
  if (![STATUS.PAUSED, STATUS.DELAYED].includes(p.status)) {
    toast("只有已暂停或已延期的项目才能恢复施工");
    return;
  }
  
  try {
    const now = new Date().toISOString();
    
    const pauseHistory = [...(p.pauseHistory || [])];
    if (pauseHistory.length > 0 && !pauseHistory[pauseHistory.length - 1].resumedAt) {
      const lastPause = pauseHistory[pauseHistory.length - 1];
      const pauseDuration = (new Date(now) - new Date(lastPause.pauseAt)) / (1000 * 60 * 60);
      pauseHistory[pauseHistory.length - 1] = { ...lastPause, resumedAt: now, duration: pauseDuration };
    }
    
    const actionLogs = [...(p.actionLogs || [])];
    actionLogs.push({
      time: now,
      action: "resume",
      description: "恢复施工",
      operator: currentProfile.name || currentUser?.email || "系统",
      operatorRole: currentProfile.role
    });
    
    const patch = {
      status: STATUS.WORKING,
      startedAt: now,
      pausedAt: null,
      pauseReason: null,
      resumedAt: now,
      pauseHistory: pauseHistory,
      actionLogs: actionLogs
    };
    
    clearTimeout(reloadTimer);
    await repo.patchProject(id, patch);
    await repo.loadAll();
    renderAll();
    toast("项目已恢复施工");
    sendNotificationForProjectChange("resume", getProject(id));
    logOperation("PROJECT_RESUME", p.name || "项目", `ID: ${id}`);
  } catch (error) {
    console.error("恢复项目失败:", error);
    toast("恢复失败：" + (error.message || "未知错误"));
  }
}

function delayProject(id) {
  const p = getProject(id);
  if (!p) {
    toast("项目不存在");
    return;
  }
  
  const validStatuses = [STATUS.BOOKED, STATUS.WORKING, STATUS.PAUSED];
  if (!validStatuses.includes(p.status)) {
    toast("只有预约中、施工中或已暂停的项目才能延期");
    return;
  }
  
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = dateKey(tomorrow);
  
  const originalTime = p.appointmentTime ? new Date(p.appointmentTime) : null;
  const originalDateStr = originalTime ? dateKey(originalTime) : "";
  const originalTimeStr = originalTime ? `${String(originalTime.getHours()).padStart(2, '0')}:${String(originalTime.getMinutes()).padStart(2, '0')}` : "";
  
  let times = "";
  for (let h = 7; h <= 21; h++) {
    for (let m = 0; m < 60; m += 10) {
      const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const selected = t === "08:00" ? " selected" : "";
      times += `<option value="${t}"${selected}>${t}</option>`;
    }
  }
  times += '<option value="22:00">22:00</option>';
  
  const form = `
    <div class="form-row">
      <label><span style="color:#ef4444;">⚠️</span> 原预约时间</label>
      <div style="font-weight:600;color:#6b7280;">${originalDateStr} ${originalTimeStr}</div>
    </div>
    <div class="form-row">
      <label><span style="color:#f59e0b;">📝</span> 延期原因</label>
      <textarea id="delayReason" rows="2" class="input" placeholder="请输入延期原因..."></textarea>
    </div>
    <div class="form-row">
      <label><span style="color:#2563eb;">📅</span> 新预约日期</label>
      <input type="date" id="delayDate" value="${tomorrowDate}" class="input" min="${tomorrowDate}">
    </div>
    <div class="form-row">
      <label><span style="color:#2563eb;">⏰</span> 新预约时间</label>
      <select id="delayTime" class="input">${times}</select>
    </div>
  `;
  
  modal.open("项目延期", form, {
    confirmText: "确认延期",
    cancelText: "取消",
    onConfirm: async () => {
      const reason = document.getElementById("delayReason").value.trim();
      const newDate = document.getElementById("delayDate").value;
      const newTime = document.getElementById("delayTime").value;
      
      if (!reason) {
        toast("请填写延期原因");
        return false;
      }
      if (!newDate || !newTime) {
        toast("请选择新预约时间");
        return false;
      }
      
      const newAppointmentTime = `${newDate}T${newTime}`;
      if (new Date(newAppointmentTime) <= new Date()) {
        toast("新预约时间必须晚于当前时间");
        return false;
      }
      
      let newEndTime = "";
      const estimatedHours = p.estimatedHours || 0;
      if (estimatedHours > 0) {
        let remainingHours = estimatedHours;
        
        if (p.startedAt) {
          const started = new Date(p.startedAt);
          let endTime = new Date();
          
          if (p.status === STATUS.PAUSED && (p.pausedAt)) {
            endTime = new Date(p.pausedAt);
          }
          
          const accumulatedWorkHours = p.accumulatedWorkHours || 0;
          const currentWorkDuration = (endTime - started) / (1000 * 60 * 60);
          const actualWorkedHours = Math.max(0, accumulatedWorkHours + currentWorkDuration);
          remainingHours = Math.max(0, estimatedHours - actualWorkedHours);
        }
        
        const newStart = new Date(newAppointmentTime);
        const newEnd = new Date(newStart.getTime() + remainingHours * 60 * 60 * 1000);
        newEndTime = newEnd.toISOString();
      } else if (p.endTime) {
        const originalStart = new Date(p.appointmentTime);
        const originalEnd = new Date(p.endTime);
        const durationMs = originalEnd.getTime() - originalStart.getTime();
        const newEnd = new Date(new Date(newAppointmentTime).getTime() + durationMs);
        newEndTime = newEnd.toISOString();
      }
      
      const existingHistory = p.scheduleHistory || [];
      const scheduleHistory = [...existingHistory, {
        original_time: p.appointmentTime,
        changed_at: new Date().toISOString(),
        reason: reason,
        changed_by: currentUser?.name || "系统"
      }];
      
      const delayCount = (p.delayCount || 0) + 1;
      
      const delayHistory = [...(p.delayHistory || [])];
      delayHistory.push({
        time: new Date().toISOString(),
        originalDate: originalDateStr,
        originalTime: originalTimeStr,
        newDate: newDate,
        newTime: newTime,
        reason: reason
      });
      
      const actionLogs = [...(p.actionLogs || [])];
      actionLogs.push({
        time: new Date().toISOString(),
        action: "delay",
        description: `项目延期，新预约时间：${newDate} ${newTime}，原因：${reason}`,
        operator: currentProfile.name || currentUser?.email || "系统",
        operatorRole: currentProfile.role
      });
      
      const patch = {
        status: STATUS.DELAYED,
        appointmentTime: newAppointmentTime,
        endTime: newEndTime,
        delayReason: reason,
        delayCount: delayCount,
        scheduleHistory: scheduleHistory,
        delayHistory: delayHistory,
        actionLogs: actionLogs
      };
      
      clearTimeout(reloadTimer);
      await repo.patchProject(id, patch);
      await repo.loadAll();
      renderAll();
      toast(`项目已延期至 ${newDate} ${newTime}`);
      sendNotificationForProjectChange("delay", getProject(id));
      logOperation("PROJECT_DELAY", p.name || "项目", `ID: ${id}, 原时间: ${originalDateStr} ${originalTimeStr}, 新时间: ${newDate} ${newTime}, 原因: ${reason}`);
    }
  });
}

async function reviewProject(id) {
  const p = getProject(id);
  if (!p) {
    toast("项目不存在");
    return;
  }
  if (!(await confirmDialog("确定审核该项目？审核后项目信息将无法更改。", "审核项目"))) return;
  clearTimeout(reloadTimer);
  await repo.patchProject(id, { status: STATUS.REVIEWED, reviewedAt: new Date().toISOString() });
  await repo.loadAll();
  renderAll();
  toast("已审核");
  logOperation("PROJECT_REVIEW", p.name || "项目", `ID: ${id}`);
}

async function unreviewProject(id) {
  const p = getProject(id);
  if (!p) {
    toast("项目不存在");
    return;
  }
  if (!(await confirmDialog("确定取消审核？取消后项目将恢复为「已完工」状态，可继续编辑。", "取消审核"))) return;
  clearTimeout(reloadTimer);
  await repo.patchProject(id, { status: STATUS.DONE });
  await repo.loadAll();
  renderAll();
  toast("已取消审核");
}

async function saveActualHours(id) {
  const v = Number(document.getElementById("cActual").value) || 0;
  await repo.patchProject(id, { actual_hours: v });
  await repo.loadAll();
  renderConstruction();
  toast("已保存实际工时");
}

function toggleLogWorkerType() {
  const type = document.getElementById("logType").value;
  document.getElementById("logInternalWorkerField").style.display = type === "internal" ? "block" : "none";
  document.getElementById("logOutsourcedField").style.display = type === "outsourced" ? "block" : "none";
}

function updateLogOutsourcedInput() {
  const sel = document.getElementById("logOutsourcedSelect");
  const input = document.getElementById("logOutsourcedName");
  if (sel && input && sel.value) {
    input.value = sel.value;
  }
}



async function addWorkLog(id) {
  const p = getProject(id);
  const type = document.getElementById("logType").value;
  const hoursInput = document.getElementById("logHours").value;
  const date = document.getElementById("logDate").value;
  const note = document.getElementById("logNote").value.trim();
  const level = document.getElementById("logLevel").value;
  
  if (!validateHours(hoursInput)) { toast("工时必须在 0.1-24 小时之间"); return; }
  const hours = Number(hoursInput);
  if (!date) { toast("请选择施工日期"); return; }
  
  let workerId, workerName;
  if (type === "internal") {
    workerId = document.getElementById("logWorker").value;
    if (!workerId) { toast("请选择施工人员"); return; }
    const worker = getWorker(workerId);
    workerName = worker.name;
  } else {
    workerName = document.getElementById("logOutsourcedName").value.trim();
    if (!workerName) { toast("请输入外协人员姓名"); return; }
    workerId = "outsourced:" + workerName;
  }
  
  try {
    await repo.addWorkLog(id, { workerId, workerName, hours, date, note, level, isOutsourced: type === "outsourced" });
    if (p.status === STATUS.BOOKED) {
        const now = new Date().toISOString();
        await repo.patchProject(id, { status: STATUS.WORKING, startedAt: now, originalStartedAt: now });
      }
    clearTimeout(reloadTimer);
    await repo.loadAll();
    const updatedProject = getProject(id);
    
    const totalHours = (updatedProject.workLogs || []).reduce((sum, log) => sum + (Number(log.hours) || 0), 0);
    
    await repo.patchProject(id, { actualHours: totalHours });
    updatedProject.actualHours = totalHours;
    logOperation("WORK_LOG_ADD", `${p.name} - ${workerName}`, `工时：${hours}小时，日期：${date}，等级：${level}，备注：${note || "无"}，类型：${type === "outsourced" ? "外协" : "内部"}`);
    renderAll();
    toast("已添加施工工时");
  } catch (error) {
    console.error("添加工时失败:", error);
  }
}

async function deleteWorkLog(pid, lid) {
  if (!(await confirmDialog("确定删除该工时记录？此操作不可撤销。", "删除工时"))) return;
  const p = getProject(pid);
  const log = (p.workLogs || []).find(l => l.id === lid);
  await repo.deleteWorkLog(pid, lid);
  await repo.loadAll();
  const updatedProject = getProject(pid);
  const totalHours = (updatedProject.workLogs || []).reduce((sum, log) => sum + (Number(log.hours) || 0), 0);
  await repo.patchProject(pid, { actualHours: totalHours });
  updatedProject.actualHours = totalHours;
  logOperation("WORK_LOG_DELETE", `${p.name} - ${log?.workerName || ""}`, `工时：${log?.hours || 0}小时，日期：${log?.date || "未知"}，等级：${log?.level || "未知"}，类型：${log?.isOutsourced ? "外协" : "内部"}`);
  renderAll();
  toast("已删除");
}

function generateWorkerScheduleDescription(dateStr = null) {
  const targetDate = dateStr ? new Date(dateStr) : new Date();
  const dateStrFormatted = dateKey(targetDate);
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][targetDate.getDay()];
  
  const allTodayProjects = cache.projects.filter(p => {
    const pStart = projectStart(p);
    if (!pStart) return false;
    return dateKey(pStart) === dateStrFormatted;
  }).sort((a, b) => projectStart(a) - projectStart(b));
  
  const todayProjects = allTodayProjects.filter(p => !isCompleted(p));
  
  const workerSchedule = {};
  todayProjects.forEach(p => {
    const workerIds = p.assignedWorkerIds || [];
    workerIds.forEach(wid => {
      if (!workerSchedule[wid]) {
        workerSchedule[wid] = [];
      }
      workerSchedule[wid].push(p);
    });
  });
  
  const availableWorkers = cache.workers.filter(w => {
    const wid = w.id;
    if (workerSchedule[wid] && workerSchedule[wid].length > 0) return false;
    
    const leaveRecords = cache.leaveRecords.filter(r => {
      if (r.status === "rejected") return false;
      const leaveStart = new Date(`${r.startDate}T${r.startTime || "08:00"}`);
      const leaveEnd = new Date(`${r.endDate}T${r.endTime || "18:00"}`);
      const checkDate = new Date(dateStrFormatted + "T09:00");
      return checkDate >= leaveStart && checkDate <= leaveEnd;
    });
    
    return leaveRecords.length === 0;
  });
  
  const onLeaveWorkers = cache.workers.filter(w => {
    const leaveRecords = cache.leaveRecords.filter(r => {
      if (r.status === "rejected") return false;
      if (r.workerId !== w.id) return false;
      const leaveStart = new Date(`${r.startDate}T${r.startTime || "08:00"}`);
      const leaveEnd = new Date(`${r.endDate}T${r.endTime || "18:00"}`);
      const checkDate = new Date(dateStrFormatted + "T09:00");
      return checkDate >= leaveStart && checkDate <= leaveEnd;
    });
    return leaveRecords.length > 0;
  });
  
  let description = `<div class="schedule-description">`;
  description += `<h3>📅 ${dateStrFormatted} （周${weekday}）施工人员安排</h3>`;
  
  if (todayProjects.length === 0) {
    description += `<p style="color:#6b7280">今天没有安排施工任务，大家可以休息一下~</p>`;
  }
  
  const workersWithProjects = Object.keys(workerSchedule).filter(wid => workerSchedule[wid].length > 0);
  
  workersWithProjects.forEach(wid => {
    const worker = getWorker(wid);
    const name = worker ? worker.name : "未知人员";
    const projects = workerSchedule[wid];
    
    description += `<div class="schedule-item">`;
    description += `<div class="schedule-worker">👤 ${name}</div>`;
    
    projects.forEach((p, idx) => {
      const store = getStore(p.storeId);
      const storeName = store ? store.name : "未知门店";
      const pStart = projectStart(p);
      const pEnd = projectEnd(p);
      const startTime = pStart ? `${String(pStart.getHours()).padStart(2, "0")}:${String(pStart.getMinutes()).padStart(2, "0")}` : "08:00";
      const endTime = pEnd ? `${String(pEnd.getHours()).padStart(2, "0")}:${String(pEnd.getMinutes()).padStart(2, "0")}` : "18:00";
      
      const internalWorkers = (p.assignedWorkerIds || []).map(wid2 => {
        const w2 = getWorker(wid2);
        return w2 ? w2.name : "未知";
      });
      const outsourcedWorkers = (p.outsourcedWorkers || "").split(",").map(n => n.trim()).filter(n => n);
      const allWorkers = [...internalWorkers, ...outsourcedWorkers].filter(w => w !== name);
      const pWorkers = allWorkers.join("、");
      
      const actualDuration = pStart && pEnd ? ((pEnd - pStart) / (1000 * 60 * 60)).toFixed(1) : 0;
      
      let timePrefix = "";
      if (pStart) {
        const hour = pStart.getHours();
        if (hour < 6) timePrefix = "凌晨";
        else if (hour < 9) timePrefix = "早上";
        else if (hour < 12) timePrefix = "上午";
        else if (hour < 14) timePrefix = "中午";
        else if (hour < 18) timePrefix = "下午";
        else if (hour < 22) timePrefix = "晚上";
        else timePrefix = "深夜";
      } else {
        timePrefix = "早上";
      }
      
      let taskDesc = "";
      if (idx === 0) {
        taskDesc = `${timePrefix}${startTime}出发，`;
      } else {
        const prevProject = projects[idx - 1];
        const prevEnd = projectEnd(prevProject) || new Date((projectStart(prevProject) || new Date()).getTime() + (prevProject.estimatedHours || 2) * 3600000);
        const currStart = projectStart(p);
        const gapMinutes = currStart && prevEnd ? (currStart - prevEnd) / (1000 * 60) : 60;
        
        if (gapMinutes < TIGHT_GAP_MINUTES) {
          taskDesc = `尽快忙完，抓紧时间赶往下一个，${startTime}到达，`;
        } else {
          taskDesc = `忙完后，${startTime}再去，`;
        }
      }
      
      if (p.address) {
        taskDesc += `前往 <strong>${esc(p.address)}</strong>，`;
      } else if (storeName) {
        taskDesc += `前往 <strong>${esc(storeName)}</strong>，`;
      }
      
      if (p.customer) {
        taskDesc += `客户 <strong>${esc(p.customer)}</strong>，`;
      }
      
      if (p.phone) {
        taskDesc += `电话 <strong>${esc(p.phone)}</strong>，`;
      }
      
      taskDesc += `做 <strong>${esc(p.name)}</strong>`;
      
      if (actualDuration > 0) {
        taskDesc += `，预计从${startTime}到${endTime}，大概 <strong>${actualDuration}</strong> 个小时`;
      }
      
      if (p.estimatedHours > 0) {
        taskDesc += `，预计总工时 <strong>${p.estimatedHours}</strong> 工时`;
      }
      
      if (pWorkers) {
        taskDesc += `，一起去的有 <strong>${pWorkers}</strong>`;
      }
      
      if (p.note) {
        taskDesc += `。施工内容和注意事项：<strong>${esc(p.note)}</strong>`;
      }
      
      if (pStart) {
        const startHour = pStart.getHours();
        if (startHour < 8) {
          const advanceHours = (8 - startHour).toFixed(1);
          taskDesc += `（🌅 今日开工较早，请提前${advanceHours}小时出发，注意安全！）`;
        }
      }
      
      if (pStart) {
        const startHour = pStart.getHours();
        if (startHour >= 18) {
          let overtimeHours = 0;
          if (pEnd) {
            overtimeHours = Math.max(0, (pEnd.getHours() - 18) + (pEnd.getMinutes() / 60));
          } else {
            overtimeHours = Math.max(0, startHour - 18);
          }
          taskDesc += `（🌙 预计加班${overtimeHours.toFixed(1)}小时，请提前做好准备！）`;
        }
      }
      
      description += `<div class="schedule-task">${taskDesc}</div>`;
    });
    
    let totalActualHours = 0;
    projects.forEach(p => {
      if (p.startedAt) {
        const end = p.finishedAt ? new Date(p.finishedAt) : new Date();
        const start = new Date(p.startedAt);
        let elapsedMs = end - start;
        (p.pauseHistory || []).forEach(ph => {
          if (ph.startTime && ph.endTime) {
            const pauseStart = new Date(ph.startTime);
            const pauseEnd = new Date(ph.endTime);
            elapsedMs -= pauseEnd - pauseStart;
          }
        });
        totalActualHours += elapsedMs / (1000 * 60 * 60);
      }
    });
    
    const workerInternalTasks = getInternalTasks().filter(t => 
      t.workerName === name && 
      t.date === dateStrFormatted && 
      t.actualStartTime && 
      ['in_progress', 'completed', 'verified'].includes(t.status)
    );
    workerInternalTasks.forEach(t => {
      if (t.actualEndTime) {
        const start = new Date(`${t.date} ${t.actualStartTime}`);
        const end = new Date(`${t.date} ${t.actualEndTime}`);
        totalActualHours += (end - start) / (1000 * 60 * 60);
      } else if (t.status === 'in_progress') {
        const start = new Date(`${t.date} ${t.actualStartTime}`);
        const end = new Date();
        totalActualHours += (end - start) / (1000 * 60 * 60);
      }
    });
    
    const totalEstimatedHours = projects.reduce((sum, p) => {
      const workerCount = Math.max(1, p.workerCount || (p.assignedWorkerIds || []).length || 1);
      return sum + ((p.estimatedHours || 0) / workerCount);
    }, 0);
    
    if (totalActualHours > 0) {
      if (totalActualHours > 10) {
        description += `<div class="schedule-warning">⚠️ <strong>工时预警</strong>：${name}今日实际工作已达 ${totalActualHours.toFixed(1)} 小时，连续工作这么长时间了，请注意休息！</div>`;
      } else if (totalActualHours > 8) {
        description += `<div class="schedule-warning">⚠️ <strong>工时预警</strong>：${name}今日实际工作 ${totalActualHours.toFixed(1)} 小时，已超过8小时标准工作时间，请注意劳逸结合！</div>`;
      }
    } else if (totalEstimatedHours > 8) {
      description += `<div class="schedule-warning">⚠️ <strong>工时预警</strong>：${name}今日预计工时 ${totalEstimatedHours.toFixed(1)} 小时，超过8小时标准工作时间，请注意劳逸结合！</div>`;
    }
    
    for (let i = 1; i < projects.length; i++) {
      const prevProject = projects[i - 1];
      const currProject = projects[i];
      const prevEnd = projectEnd(prevProject) || new Date((projectStart(prevProject) || new Date()).getTime() + (prevProject.estimatedHours || 2) * 3600000);
      const currStart = projectStart(currProject);
      if (currStart && prevEnd) {
        const gapMinutes = (currStart - prevEnd) / (1000 * 60);
        
        const addressSimilar = isAddressSimilar(prevProject.address || "", currProject.address || "");
        
        if (gapMinutes < 0) {
          const overlapMinutes = Math.round(Math.abs(gapMinutes));
          const overlapHours = Math.floor(overlapMinutes / 60);
          const overlapMins = overlapMinutes % 60;
          const overlapStr = overlapHours > 0 ? `${overlapHours}小时${overlapMins}分钟` : `${overlapMins}分钟`;
          let suggestion = "";
          if (addressSimilar) {
            suggestion = "两个项目地址相近，建议合并安排或调整顺序，避免来回奔波。";
          } else {
            suggestion = "请及时调整项目时间或安排其他人员协助，确保施工顺利。";
          }
          description += `<div class="schedule-warning" style="background:#fef2f2;border-left:4px solid #ef4444;">🔴 <strong>时间冲突</strong>：上一个项目预计 ${prevEnd.getHours()}:${String(prevEnd.getMinutes()).padStart(2, "0")} 结束，下一个项目 ${currStart.getHours()}:${String(currStart.getMinutes()).padStart(2, "0")} 开始，重叠 ${overlapStr}！${suggestion}</div>`;
        } else if (gapMinutes < TIGHT_GAP_MINUTES) {
          let transportTip = "";
          if (addressSimilar) {
            transportTip = "两个项目地址相近，可顺路前往，注意提前做好衔接。";
          } else {
            transportTip = "两个项目地址不同，请预留充足交通时间，避免迟到。";
          }
          description += `<div class="schedule-warning">⏰ <strong>时间紧迫</strong>：上一个项目预计 ${prevEnd.getHours()}:${String(prevEnd.getMinutes()).padStart(2, "0")} 结束，下一个项目 ${currStart.getHours()}:${String(currStart.getMinutes()).padStart(2, "0")} 开始，间隔仅 ${Math.round(gapMinutes)} 分钟。${transportTip}</div>`;
        } else if (gapMinutes >= TIGHT_GAP_MINUTES && gapMinutes < 60) {
          if (addressSimilar) {
            description += `<div class="schedule-warning" style="background:#fefce8;border-left:4px solid #eab308;">💡 <strong>顺路提示</strong>：两个项目地址相近，间隔 ${Math.round(gapMinutes)} 分钟，可考虑合并施工或快速转场。</div>`;
          }
        }
      }
    }
    
    const nearbyProjects = [];
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        if (isAddressSimilar(projects[i].address || "", projects[j].address || "")) {
          nearbyProjects.push({ p1: projects[i], p2: projects[j] });
        }
      }
    }
    
    if (nearbyProjects.length > 0) {
      description += `<div class="schedule-warning" style="background:#dbeafe;border-left:4px solid #3b82f6;">📍 <strong>地址相近提示</strong>：您今日有${nearbyProjects.length}组项目地址相近，建议提前规划路线，可顺路完成，提高效率。</div>`;
    }
    
    const workerSchedules = cache.workerSchedules.filter(s => s.workerId === wid && s.startDate === dateStr);
    if (workerSchedules.length > 0) {
      description += `<div class="schedule-schedules">`;
      description += `<div class="schedule-schedules-title">📝 个人日程</div>`;
      workerSchedules.forEach(s => {
        const timeStr = s.startTime && s.endTime 
          ? `${s.startTime} ~ ${s.endTime}`
          : "全天";
        description += `<div class="schedule-schedule-item">${SCHEDULE_TYPE_LABEL[s.type] || s.type}：${esc(s.title)}（${timeStr}）${s.description ? `· ${esc(s.description)}` : ""}</div>`;
      });
      description += `</div>`;
    }
    
    description += `</div>`;
  });
  
  if (availableWorkers.length > 0) {
    description += `<div class="schedule-item standby">`;
    description += `<div class="schedule-worker">👥 待命人员</div>`;
    
    const standbyWithSchedules = availableWorkers.filter(w => 
      cache.workerSchedules.some(s => s.workerId === w.id && s.startDate === dateStr)
    );
    
    if (standbyWithSchedules.length > 0) {
      standbyWithSchedules.forEach(w => {
        const schedules = cache.workerSchedules.filter(s => s.workerId === w.id && s.startDate === dateStr);
        description += `<div class="schedule-task">${w.name} 今日有个人日程安排：`;
        schedules.forEach(s => {
          const timeStr = s.startTime && s.endTime 
            ? `${s.startTime} ~ ${s.endTime}`
            : "全天";
          description += `${SCHEDULE_TYPE_LABEL[s.type] || s.type}：${esc(s.title)}（${timeStr}）；`;
        });
        description += `</div>`;
      });
    }
    
    const standbyWithoutSchedules = availableWorkers.filter(w => 
      !cache.workerSchedules.some(s => s.workerId === w.id && s.startDate === dateStr)
    );
    
    if (standbyWithoutSchedules.length > 0) {
      description += `<div class="schedule-task">${standbyWithoutSchedules.map(w => w.name).join("、")} 今天没有安排任务，随时待命，有突发情况可以随时调配。</div>`;
    }
    
    description += `</div>`;
  }
  
  if (onLeaveWorkers.length > 0) {
    description += `<div class="schedule-item leave">`;
    description += `<div class="schedule-worker">🌴 请假人员</div>`;
    description += `<div class="schedule-task">${onLeaveWorkers.map(w => w.name).join("、")} 今天请假，不在岗，请大家注意人手安排。</div>`;
    description += `</div>`;
  }
  
  const allWorkerIds = new Set();
  todayProjects.forEach(p => {
    (p.assignedWorkerIds || []).forEach(wid => allWorkerIds.add(wid));
  });
  const totalProjects = allTodayProjects.length;
  const statusCounts = {
    [STATUS.BOOKED]: allTodayProjects.filter(p => p.status === STATUS.BOOKED).length,
    [STATUS.WORKING]: allTodayProjects.filter(p => p.status === STATUS.WORKING).length,
    [STATUS.PAUSED]: allTodayProjects.filter(p => p.status === STATUS.PAUSED).length,
    [STATUS.DELAYED]: allTodayProjects.filter(p => p.status === STATUS.DELAYED).length,
    [STATUS.DONE]: allTodayProjects.filter(p => p.status === STATUS.DONE).length,
    [STATUS.ACCEPTED]: allTodayProjects.filter(p => p.status === STATUS.ACCEPTED).length,
    [STATUS.REVIEWED]: allTodayProjects.filter(p => p.status === STATUS.REVIEWED).length,
    [STATUS.CANCELLED]: allTodayProjects.filter(p => p.status === STATUS.CANCELLED).length,
  };
  const completedProjects = statusCounts[STATUS.DONE] + statusCounts[STATUS.ACCEPTED] + statusCounts[STATUS.REVIEWED];
  const inProgressProjects = statusCounts[STATUS.BOOKED] + statusCounts[STATUS.WORKING] + statusCounts[STATUS.PAUSED] + statusCounts[STATUS.DELAYED];
  const totalWorkers = allWorkerIds.size;
  const onJobWorkers = workersWithProjects.length;
  const totalAvailable = cache.workers.length;
  
  const unassignedProjects = allTodayProjects.filter(p => 
      (p.status === STATUS.BOOKED || p.status === STATUS.WORKING) && 
      (!p.assignedWorkerIds || p.assignedWorkerIds.length === 0)
    );
    
    if (totalProjects > 0) {
    description += `<div class="schedule-summary">`;
    description += `<div class="schedule-summary-item">📋 今日项目：${totalProjects} 个（进行中 ${inProgressProjects} 个，已暂停 ${statusCounts[STATUS.PAUSED]} 个，已延期 ${statusCounts[STATUS.DELAYED]} 个，已完工 ${statusCounts[STATUS.DONE]} 个，已验收 ${statusCounts[STATUS.ACCEPTED]} 个，已审核 ${statusCounts[STATUS.REVIEWED]} 个${statusCounts[STATUS.CANCELLED] > 0 ? `，已取消 ${statusCounts[STATUS.CANCELLED]} 个` : ``}）</div>`;
    description += `<div class="schedule-summary-item">👷 出勤人员：${onJobWorkers} 人</div>`;
    description += `<div class="schedule-summary-item">🌴 请假人员：${onLeaveWorkers.length} 人</div>`;
    description += `<div class="schedule-summary-item">👤 总人数：${totalAvailable} 人</div>`;
    
    if (unassignedProjects.length > 0) {
      const unassignedNames = unassignedProjects.slice(0, 5).map(p => p.name).join("、");
      const moreCount = unassignedProjects.length > 5 ? `等${unassignedProjects.length}个` : "";
      description += `<div class="schedule-summary-item warning" style="background:#fef2f2;padding:8px;border-radius:4px;">⚠️ <strong>未分配人员</strong>：${unassignedNames}${moreCount}项目尚未分配施工人员，请尽快安排！</div>`;
    }
    
    const workerHours = {};
    workersWithProjects.forEach(wid => {
      const projects = workerSchedule[wid];
      const totalHrs = projects.reduce((sum, p) => {
        const workerCount = Math.max(1, p.workerCount || (p.assignedWorkerIds || []).length || 1);
        return sum + ((p.estimatedHours || 0) / workerCount);
      }, 0);
      const worker = getWorker(wid);
      workerHours[worker ? worker.name : "未知"] = totalHrs.toFixed(1);
    });
    
    if (Object.keys(workerHours).length > 0) {
      const hoursList = Object.entries(workerHours).map(([name, hrs]) => {
        const color = parseFloat(hrs) > 8 ? "#ef4444" : parseFloat(hrs) > 6 ? "#d97706" : "#16a34a";
        return `<span style="color:${color}">${name} ${hrs}小时</span>`;
      }).join(" · ");
      description += `<div class="schedule-summary-item">📊 <strong>工时分布</strong>：${hoursList}</div>`;
    }
    
    const teamProjects = allTodayProjects.filter(p => 
      p.assignedWorkerIds && p.assignedWorkerIds.length >= 2
    );
    
    if (teamProjects.length > 0) {
      const teamProjectNames = teamProjects.slice(0, 5).map(p => {
        const workerNames = p.assignedWorkerIds.map(wid => {
          const w = getWorker(wid);
          return w ? w.name : "未知";
        }).join("、");
        return `${p.name}(${workerNames})`;
      }).join("；");
      const moreCount = teamProjects.length > 5 ? `等${teamProjects.length}个` : "";
      description += `<div class="schedule-summary-item" style="background:#ecfdf5;padding:8px;border-radius:4px;">👥 <strong>协作项目</strong>：${teamProjectNames}${moreCount}需要多人配合，请提前沟通好分工！</div>`;
    }
    
    const overtimeProjects = allTodayProjects.filter(p => {
      if (!p.startedAt || p.status !== STATUS.WORKING) return false;
      const started = new Date(p.startedAt);
      const now = new Date();
      let elapsedMs = now - started;
      (p.pauseHistory || []).forEach(ph => {
        if (ph.startTime && ph.endTime) {
          const pauseStart = new Date(ph.startTime);
          const pauseEnd = new Date(ph.endTime);
          elapsedMs -= pauseEnd - pauseStart;
        }
      });
      const elapsedHours = elapsedMs / (1000 * 60 * 60);
      return elapsedHours > (p.estimatedHours || 8);
    });
    
    if (overtimeProjects.length > 0) {
      const overtimeNames = overtimeProjects.slice(0, 5).map(p => {
        const started = new Date(p.startedAt);
        const now = new Date();
        let elapsedMs = now - started;
        (p.pauseHistory || []).forEach(ph => {
          if (ph.startTime && ph.endTime) {
            const pauseStart = new Date(ph.startTime);
            const pauseEnd = new Date(ph.endTime);
            elapsedMs -= pauseEnd - pauseStart;
          }
        });
        const elapsedHours = (elapsedMs / (1000 * 60 * 60)).toFixed(1);
        const overtimeHours = (elapsedHours - (p.estimatedHours || 8)).toFixed(1);
        return `${p.name}（已超时${overtimeHours}小时）`;
      }).join("、");
      const moreCount = overtimeProjects.length > 5 ? `等${overtimeProjects.length}个` : "";
      description += `<div class="schedule-summary-item warning" style="background:#fee2e2;padding:8px;border-radius:4px;">⏰ <strong>超时提醒</strong>：${overtimeNames}${moreCount}项目已超出预计工时，请关注进度！</div>`;
    }
    
    const highLoadWorkers = Object.entries(workerHours).filter(([name, hrs]) => parseFloat(hrs) > 10);
    if (highLoadWorkers.length > 0) {
      const highLoadList = highLoadWorkers.map(([name, hrs]) => `${name}(${hrs}小时)`).join("、");
      description += `<div class="schedule-summary-item warning" style="background:#fef3c7;padding:8px;border-radius:4px;">⚠️ <strong>高负载提醒</strong>：${highLoadList}今日任务较重，建议关注工作状态！</div>`;
    }
    
    const totalEstimatedHours = allTodayProjects.reduce((sum, p) => {
      return sum + (p.estimatedHours || 0);
    }, 0);
    const totalActualPersonHours = allTodayProjects.reduce((sum, p) => {
      if (!p.startedAt) return sum;
      const end = p.finishedAt ? new Date(p.finishedAt) : new Date();
      const start = new Date(p.startedAt);
      let elapsedMs = end - start;
      (p.pauseHistory || []).forEach(ph => {
        if (ph.startTime && ph.endTime) {
          const pauseStart = new Date(ph.startTime);
          const pauseEnd = new Date(ph.endTime);
          elapsedMs -= pauseEnd - pauseStart;
        }
      });
      const workerCount = Math.max(1, (p.assignedWorkerIds || []).length);
      return sum + (elapsedMs / (1000 * 60 * 60)) * workerCount;
    }, 0);
    
    const internalTasksToday = getInternalTasks().filter(t => 
      t.date === todayStr && 
      t.actualStartTime && 
      ['in_progress', 'completed', 'verified'].includes(t.status)
    );
    const internalActualHours = internalTasksToday.reduce((sum, t) => {
      if (t.actualEndTime) {
        const start = new Date(`${t.date} ${t.actualStartTime}`);
        const end = new Date(`${t.date} ${t.actualEndTime}`);
        return sum + (end - start) / (1000 * 60 * 60);
      } else if (t.status === 'in_progress') {
        const start = new Date(`${t.date} ${t.actualStartTime}`);
        const end = new Date();
        return sum + (end - start) / (1000 * 60 * 60);
      }
      return sum;
    }, 0);
    
    const hoursRemaining = Math.max(0, totalEstimatedHours - totalActualPersonHours);
    const totalActualWithInternal = totalActualPersonHours + internalActualHours;
    description += `<div class="schedule-summary-item">📈 <strong>工时预测</strong>：预计总工时 ${totalEstimatedHours.toFixed(1)} 小时，已完成 ${totalActualWithInternal.toFixed(1)} 小时（项目 ${totalActualPersonHours.toFixed(1)} + 内务 ${internalActualHours.toFixed(1)}），剩余 ${hoursRemaining.toFixed(1)} 小时</div>`;
    
    const avgActualHours = onJobWorkers > 0 ? (totalActualPersonHours / onJobWorkers).toFixed(1) : 0;
    
    if (totalProjects > 0 && onJobWorkers > 0) {
      const avgProjects = (totalProjects / onJobWorkers).toFixed(1);
      if (avgActualHours > 10) {
        description += `<div class="schedule-summary-item warning">⚠️ 大家已经连续工作 ${avgActualHours} 小时了，注意适当休息，别太累了！</div>`;
      } else if (avgActualHours > 8) {
        description += `<div class="schedule-summary-item warning">⚠️ 今日平均工作已达 ${avgActualHours} 小时，请注意劳逸结合！</div>`;
      } else if (avgProjects > 2) {
        description += `<div class="schedule-summary-item warning">⚠️ 人手有点紧张，平均每人要跑 ${avgProjects} 个项目，大家加油！需要加人的话及时说。</div>`;
      } else if (avgProjects > 1) {
        description += `<div class="schedule-summary-item">💪 任务适中，大家合理安排时间，注意安全。</div>`;
      } else {
        description += `<div class="schedule-summary-item">😎 今天任务轻松，大家好好干！</div>`;
      }
    }
    description += `</div>`;
  }
  
  if (allTodayProjects.length > 0) {
    description += `<div class="schedule-progress">`;
    description += `<div class="schedule-section-title">📊 项目进度跟踪</div>`;
    
    allTodayProjects.forEach(p => {
      const store = getStore(p.storeId);
      const storeName = store ? store.name : "未知门店";
      const pStart = projectStart(p);
      const pEnd = projectEnd(p);
      const startTime = pStart ? `${String(pStart.getHours()).padStart(2, "0")}:${String(pStart.getMinutes()).padStart(2, "0")}` : "08:00";
      const endTime = pEnd ? `${String(pEnd.getHours()).padStart(2, "0")}:${String(pEnd.getMinutes()).padStart(2, "0")}` : "12:00";
      
      let statusText = p.status;
      let statusColor = "#6b7280";
      let progress = 0;
      
      const now = new Date();
      const durationMs = pStart && pEnd ? pEnd - pStart : 0;
      const elapsedMs = pStart ? Math.max(0, now - pStart) : 0;
      const autoProgress = durationMs > 0 ? Math.min(100, Math.round((elapsedMs / durationMs) * 100)) : 0;
      
      const isOverdue = p.status === STATUS.BOOKED && !p.startedAt && pStart && now > pStart;
      
      switch (p.status) {
        case STATUS.BOOKED:
          if (isOverdue) {
            statusColor = "#ef4444";
            statusText = "预约中（已超期）";
            progress = 0;
          } else {
            statusColor = "#3b82f6";
            progress = now >= pStart ? Math.min(30, autoProgress) : 0;
          }
          break;
        case STATUS.WORKING:
          statusColor = "#f59e0b";
          progress = Math.max(30, Math.min(90, autoProgress));
          break;
        case STATUS.DONE:
          statusColor = "#10b981";
          progress = 95;
          break;
        case STATUS.ACCEPTED:
        case STATUS.REVIEWED:
          statusColor = "#06b6d4";
          progress = 100;
          break;
        case STATUS.PAUSED:
          statusColor = "#f59e0b";
          statusText = "已暂停";
          progress = Math.max(30, Math.min(90, autoProgress));
          break;
        case STATUS.CANCELLED:
          statusColor = "#ef4444";
          progress = 0;
          break;
        default:
          statusColor = "#6b7280";
          progress = 0;
      }
      
      const statusActions = [];
      if ((isManager() || isWorker() || isStoreManager()) && p.status === STATUS.BOOKED) {
        statusActions.push('<button class="btn tiny ' + (isOverdue ? 'danger' : '') + '" onclick="updateProjectStatus(\'' + p.id + '\', \'' + STATUS.WORKING + '\')">开始施工</button>');
        statusActions.push('<button class="btn tiny" onclick="gotoConstruction(\'' + p.id + '\')">人员调整</button>');
        statusActions.push('<button class="btn tiny" onclick="delayProject(\'' + p.id + '\')">延期</button>');
        statusActions.push('<button class="btn tiny danger" onclick="if(confirm(\'确定取消该预约项目？\')){updateProjectStatus(\'' + p.id + '\', \'' + STATUS.CANCELLED + '\')}">取消</button>');
      }
      if ((isManager() || isWorker() || isStoreManager()) && p.status === STATUS.WORKING) {
        statusActions.push('<button class="btn tiny" onclick="updateProjectStatus(\'' + p.id + '\', \'' + STATUS.DONE + '\')">完成安装</button>');
        statusActions.push('<button class="btn tiny" onclick="gotoConstruction(\'' + p.id + '\')">人员调整</button>');
        statusActions.push('<button class="btn tiny" style="background:#f59e0b;color:#fff" onclick="pauseProject(\'' + p.id + '\')">暂停施工</button>');
        statusActions.push('<button class="btn tiny" onclick="delayProject(\'' + p.id + '\')">延期</button>');
      }
      if ((isManager() || isWorker() || isStoreManager()) && p.status === STATUS.DONE) {
        statusActions.push('<button class="btn tiny" onclick="updateProjectStatus(\'' + p.id + '\', \'' + STATUS.ACCEPTED + '\')">确认验收</button>');
      }
      if ((isManager() || isWorker() || isStoreManager()) && p.status === STATUS.PAUSED) {
        statusActions.push('<button class="btn tiny" onclick="updateProjectStatus(\'' + p.id + '\', \'' + STATUS.WORKING + '\')">恢复施工</button>');
        statusActions.push('<button class="btn tiny" onclick="gotoConstruction(\'' + p.id + '\')">人员调整</button>');
        statusActions.push('<button class="btn tiny" onclick="delayProject(\'' + p.id + '\')">延期</button>');
      }
      
      const workers = (p.assignedWorkerIds || []).map(wid => {
        const w = getWorker(wid);
        return w ? w.name : "未知";
      });
      const outsourcedWorkers = (p.outsourcedWorkers || "").split(",").map(n => n.trim()).filter(n => n);
      const allWorkers = [...workers, ...outsourcedWorkers.map(n => `${n}（外协）`)];
      
      const statusClass = isOverdue ? 'overdue' : `status-${p.status}`;
      
      description += `
        <div class="schedule-progress-item ${statusClass}" style="--status-color: ${statusColor};">
          <div class="schedule-progress-header">
            <span class="schedule-progress-name">${esc(p.name)}</span>
            <span class="schedule-progress-store">${esc(storeName)}</span>
            <span class="schedule-progress-time">${startTime} ~ ${endTime} ${isOverdue ? '<span class="overdue-badge">🔴 已超期</span>' : ''}</span>
          </div>
          <div class="schedule-progress-bar-container">
            <div class="schedule-progress-bar" style="width: ${progress}%; background-color: ${statusColor};"></div>
          </div>
          <div class="schedule-progress-info">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="schedule-progress-status" style="color: ${statusColor};">${statusText}</span>
              ${allWorkers.length > 0 ? `<span style="font-size:12px;color:#6b7280;">👷 ${esc(allWorkers.join(", "))}</span>` : ""}
            </div>
            <span class="schedule-progress-percent">${progress}%</span>
          </div>
          ${statusActions.length > 0 ? `<div class="schedule-progress-actions">${statusActions.join(" ")}</div>` : ""}
        </div>
      `;
    });
    
    description += `</div>`;
  }
  
  description += `</div>`;
  
  return description;
}

function openCompleteProjectForm(id) {
  const p = getProject(id);
  if (!p) return;
  
  const assignedWorkerIds = p.assignedWorkerIds || [];
  const allWorkerIds = new Set([...assignedWorkerIds]);
  
  (p.workerChangeHistory || []).forEach(ch => {
    if (ch.workerId) {
      allWorkerIds.add(ch.workerId);
    }
  });
  
  (p.workLogs || []).forEach(log => {
    if (log.workerId && !log.workerId.startsWith("outsourced:")) {
      allWorkerIds.add(log.workerId);
    }
  });
  
  const workers = Array.from(allWorkerIds).map(wid => {
    const w = getWorker(wid);
    return w ? w : { id: wid, name: "未知", phone: "" };
  });
  
  const outsourcedWorkers = (p.outsourcedWorkers || "").split(",").map(n => n.trim()).filter(n => n);
  
  const dateStr = dateKey(new Date());
  
  const originalStartedAt = p.originalStartedAt || p.startedAt;
  const displayStartedAt = originalStartedAt ? new Date(originalStartedAt) : null;
  const now = new Date();
  
  const accumulatedWorkHours = p.accumulatedWorkHours || 0;
  
  let currentWorkDuration = 0;
  if (p.startedAt) {
    const sessionStartedAt = new Date(p.startedAt);
    let endTime = now;
    if (p.status === STATUS.PAUSED && (p.pausedAt)) {
      endTime = new Date(p.pausedAt);
    }
    currentWorkDuration = (endTime - sessionStartedAt) / (1000 * 60 * 60);
  }
  
  const actualHours = Math.max(0, accumulatedWorkHours + currentWorkDuration);
  const durationHours = displayStartedAt ? actualHours.toFixed(2) : "未知";
  
  const startTimeStr = displayStartedAt ? `${displayStartedAt.getFullYear()}/${String(displayStartedAt.getMonth() + 1).padStart(2, "0")}/${String(displayStartedAt.getDate()).padStart(2, "0")} ${String(displayStartedAt.getHours()).padStart(2, "0")}:${String(displayStartedAt.getMinutes()).padStart(2, "0")}` : "未记录";
  const endTimeStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  
  let form = `<div class="form-grid">`;
  
  form += `<div class="form-row">
    <label>项目名称</label>
    <input type="text" value="${esc(p.name || "")}" disabled class="input">
  </div>`;
  
  form += `<div class="form-row">
    <label>门店</label>
    <input type="text" value="${esc(storeName(p.storeId))}" disabled class="input">
  </div>`;
  
  form += `<div class="form-row" style="grid-column:1/-1;background:#f0f9ff;padding:12px;border-radius:8px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;gap:16px;">
      <div>
        <div style="font-size:12px;color:#6b7280;">开工时间</div>
        <div style="font-weight:600;color:#1e40af;">${esc(startTimeStr)}</div>
      </div>
      <div>
        <div style="font-size:12px;color:#6b7280;">完工时间</div>
        <div style="font-weight:600;color:#1e40af;">${esc(endTimeStr)}</div>
      </div>
      <div>
        <div style="font-size:12px;color:#6b7280;">总用时</div>
        <div style="font-weight:600;color:#059669;">${(() => {
          const projectEndTime = getProjectEffectiveEndTime(p);
          let totalHours = 0;
          (p.assignedWorkerIds || []).forEach(wid => {
            const periods = buildWorkerPeriods(p, wid);
            periods.forEach(pr => {
              const start = new Date(pr.start);
              const end = pr.end ? new Date(pr.end) : projectEndTime;
              let dur = (end - start) / (1000 * 60 * 60);
              (p.pauseHistory || []).forEach(ph => {
                if (ph.pauseAt && ph.resumedAt) {
                  const ps = new Date(ph.pauseAt);
                  const pe = new Date(ph.resumedAt);
                  const os = ps > start ? ps : start;
                  const oe = pe < end ? pe : end;
                  if (oe > os) dur -= (oe - os) / (1000 * 60 * 60);
                }
              });
              totalHours += dur;
            });
          });
          return Math.round(totalHours * 10) / 10;
        })().toFixed(1)} 小时</div>
      </div>
    </div>
  </div>`;
  
  const pauseCount = derivePauseCount(p);
  if (pauseCount > 0) {
    const pauseDurationTotal = derivePauseDuration(p);
    const pauseHours = Math.floor(pauseDurationTotal);
    const pauseMins = Math.floor((pauseDurationTotal - pauseHours) * 60);
    const pauseTimeStr = pauseHours > 0 ? `${pauseHours}小时${pauseMins}分钟` : `${pauseMins}分钟`;
    form += `<div class="form-row" style="grid-column:1/-1;background:#fffbeb;padding:10px;border-radius:6px;border-left:4px solid #f59e0b;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:16px;">⏸️</span>
        <div>
          <div style="font-size:12px;color:#92400e;font-weight:500;">施工过程中有暂停记录</div>
          <div style="font-size:11px;color:#b45309;">已暂停 ${pauseCount} 次，累计暂停 ${pauseTimeStr}，已从总用时中扣除</div>
        </div>
      </div>
    </div>`;
  }
  
  const workSessions = p.workSessions || [];
  if (workSessions.length > 0 || p.startedAt) {
    form += `<div class="form-row" style="grid-column:1/-1;background:#eff6ff;padding:10px;border-radius:6px;border-left:4px solid #3b82f6;margin-bottom:8px;">
      <div style="font-size:12px;color:#1d4ed8;font-weight:500;margin-bottom:6px;">🔧 施工时间段明细</div>
      <div style="display:flex;flex-direction:column;gap:4px;">`;
    
    const allSessions = [...workSessions];
    if (p.startedAt && p.status === STATUS.WORKING) {
      const now = new Date();
      const sessionStarted = new Date(p.startedAt);
      const duration = (now - sessionStarted) / (1000 * 60 * 60);
      allSessions.push({
        startTime: p.startedAt,
        endTime: now.toISOString(),
        duration: duration
      });
    } else if (p.startedAt && [STATUS.DONE, STATUS.ACCEPTED, STATUS.REVIEWED].includes(p.status) && p.finishedAt && workSessions.length === 0) {
      const endTime = new Date(p.finishedAt);
      const sessionStarted = new Date(p.startedAt);
      const duration = (endTime - sessionStarted) / (1000 * 60 * 60);
      allSessions.push({
        startTime: p.startedAt,
        endTime: p.finishedAt,
        duration: duration
      });
    }
    
    let totalDuration = 0;
    allSessions.forEach((session, idx) => {
      const start = new Date(session.startTime);
      const end = new Date(session.endTime);
      const hours = Math.floor(session.duration);
      const mins = Math.floor((session.duration - hours) * 60);
      const durationStr = hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`;
      totalDuration += session.duration;
      
      const startTimeStr = `${start.getMonth() + 1}/${start.getDate()} ${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
      const endTimeStr = `${end.getMonth() + 1}/${end.getDate()} ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
      
      form += `<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#374151;">
        <span>第${idx + 1}段：${startTimeStr} → ${endTimeStr}</span>
        <span style="font-weight:600;color:#1d4ed8;">${durationStr}</span>
      </div>`;
    });
    
    const totalHours = Math.floor(totalDuration);
    const totalMins = Math.floor((totalDuration - totalHours) * 60);
    const totalStr = totalHours > 0 ? `${totalHours}小时${totalMins}分钟` : `${totalMins}分钟`;
    
    form += `<div style="border-top:1px dashed #93c5fd;margin-top:4px;padding-top:4px;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#1d4ed8;">
        <span style="font-weight:600;">合计</span>
        <span style="font-weight:600;">${totalStr}</span>
      </div></div></div>`;
  }
  
  if (workers.length > 0) {
    const workerPeriods = {};
    assignedWorkerIds.forEach((wid) => {
      workerPeriods[wid] = buildWorkerPeriods(p, wid);
    });
    
    (p.workerChangeHistory || []).forEach((ch) => {
      const wid = ch.workerId;
      if (ch.action === "unassign" && workerPeriods[wid]) {
        const lastPeriod = workerPeriods[wid][workerPeriods[wid].length - 1];
        if (lastPeriod) {
          lastPeriod.end = ch.time;
          lastPeriod.autoHours = ch.autoHours;
        }
      }
    });
    
    const periodEndTime = getProjectEffectiveEndTime(p).toISOString();
    assignedWorkerIds.forEach((wid) => {
      if (workerPeriods[wid] && workerPeriods[wid].length > 0) {
        const lastPeriod = workerPeriods[wid][workerPeriods[wid].length - 1];
        if (!lastPeriod.end) {
          lastPeriod.end = periodEndTime;
        }
      }
    });
    
    let totalAutoHours = 0;
    const workerAutoHours = {};
    workers.forEach((w) => {
      const periods = workerPeriods[w.id] || [];
      const rtHours = calcWorkerRealtimeHours(p, w.id, periods);
      workerAutoHours[w.id] = Math.round(rtHours * 10) / 10;
      totalAutoHours += workerAutoHours[w.id];
    });
    
    form += `<div class="form-row" style="grid-column:1/-1;">
      <label>施工人员工时</label>
      <span style="font-size:12px;color:#6b7280;">根据实际工作时间填写</span>
    </div>`;
    
    form += `<div class="form-row" style="grid-column:1/-1;background:#f0fdf4;padding:10px;border-radius:6px;border-left:4px solid #22c55e;margin-bottom:8px;">
      <div style="display:flex;flex-wrap:wrap;gap:16px;font-size:12px;">
        <div><span style="color:#6b7280;">总工作时长：</span><span style="font-weight:600;color:#15803d;">${totalAutoHours.toFixed(1)} 小时</span></div>
        <div><span style="color:#6b7280;">施工人数：</span><span style="font-weight:600;color:#15803d;">${workers.length} 人</span></div>
      </div>
      <div style="margin-top:4px;font-size:11px;color:#86efac;">💡 系统已根据工作时长和人数自动计算每人工时，如有特殊情况可手动调整</div>
    </div>`;
    
    workers.forEach((w, idx) => {
      const isAssigned = assignedWorkerIds.includes(w.id);
      const allLogs = (p.workLogs || []).filter(l => l.workerId === w.id);
      const loggedHours = allLogs.reduce((sum, l) => sum + (Number(l.hours) || 0), 0);
      
      let autoHours = workerAutoHours[w.id] || 0;
      if (!isAssigned && loggedHours > 0) {
        autoHours = loggedHours;
      }
      
      const existingLog = allLogs.find(l => l.date === dateStr);
      const existingHours = autoHours > 0 ? autoHours.toFixed(1) : "";
      const existingLevel = existingLog ? existingLog.level : "中级";
      const existingNote = existingLog ? existingLog.note : (autoHours > 0 ? "系统自动计算" : "");
      
      form += `<div class="form-row" style="grid-column:1/-1;margin-bottom:8px;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;">
          <span style="min-width:80px;font-weight:500;flex-shrink:0;color:${isAssigned ? "#1f2937" : "#9ca3af"};">👷 ${esc(w.name)}${!isAssigned ? ` <span style="font-size:11px;color:#d1d5db;">(已移除)</span>` : ""}</span>
          <div style="flex:0 0 auto;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">工时</label>
            <input type="number" id="workerHours_${idx}" value="${existingHours}" placeholder="0" step="0.1" min="0" max="24" class="input" style="width:70px;padding:4px 6px;font-size:13px;">
          </div>
          <div style="flex:0 0 auto;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">等级</label>
            <select id="workerLevel_${idx}" class="input" style="width:80px;padding:4px 6px;font-size:13px;">
              <option value="初级"${existingLevel === "初级" ? " selected" : ""}>初级</option>
              <option value="中级"${existingLevel === "中级" ? " selected" : ""}>中级</option>
              <option value="高级"${existingLevel === "高级" ? " selected" : ""}>高级</option>
              <option value="特级"${existingLevel === "特级" ? " selected" : ""}>特级</option>
            </select>
          </div>
          <div style="flex:1;min-width:150px;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">备注</label>
            <input type="text" id="workerNote_${idx}" value="${esc(existingNote)}" placeholder="备注" class="input" style="width:100%;padding:4px 6px;font-size:13px;">
          </div>
        </div>
      </div>`;
    });
  }
  
  if (outsourcedWorkers.length > 0) {
    form += `<div class="form-row" style="grid-column:1/-1;margin-top:8px;">
      <label>外协人员工时</label>
      <span style="font-size:12px;color:#6b7280;">根据实际工作时间填写</span>
    </div>`;
    
    outsourcedWorkers.forEach((name, idx) => {
      const workerId = "outsourced:" + name;
      const existingLog = (p.workLogs || []).find(l => l.workerId === workerId && l.date === dateStr);
      const existingHours = existingLog ? existingLog.hours : "";
      const existingLevel = existingLog ? existingLog.level : "中级";
      const existingNote = existingLog ? existingLog.note : "";
      
      form += `<div class="form-row" style="grid-column:1/-1;margin-bottom:8px;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;">
          <span style="min-width:80px;font-weight:500;flex-shrink:0;color:#8b5cf6;">👤 ${esc(name)}（外协）</span>
          <div style="flex:0 0 auto;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">工时</label>
            <input type="number" id="outsourcedHours_${idx}" value="${existingHours}" placeholder="0" step="0.1" min="0" max="24" class="input" style="width:70px;padding:4px 6px;font-size:13px;">
          </div>
          <div style="flex:0 0 auto;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">等级</label>
            <select id="outsourcedLevel_${idx}" class="input" style="width:80px;padding:4px 6px;font-size:13px;">
              <option value="初级"${existingLevel === "初级" ? " selected" : ""}>初级</option>
              <option value="中级"${existingLevel === "中级" ? " selected" : ""}>中级</option>
              <option value="高级"${existingLevel === "高级" ? " selected" : ""}>高级</option>
              <option value="特级"${existingLevel === "特级" ? " selected" : ""}>特级</option>
            </select>
          </div>
          <div style="flex:1;min-width:150px;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">备注</label>
            <input type="text" id="outsourcedNote_${idx}" value="${esc(existingNote)}" placeholder="备注" class="input" style="width:100%;padding:4px 6px;font-size:13px;">
          </div>
        </div>
      </div>`;
    });
  }
  
  form += `<div class="form-row" style="grid-column:1/-1;">
    <label>项目备注</label>
    <textarea id="projectNote" rows="3" class="input" placeholder="请输入项目备注..."></textarea>
  </div>`;
  
  form += `</div>`;
  
  modal.open("完成项目 - 填写工时", form, {
    confirmText: "确认完工",
    cancelText: "取消",
    onConfirm: async () => {
      let totalHours = 0;
      const logs = [];
      
      workers.forEach((w, idx) => {
        const hoursInput = document.getElementById(`workerHours_${idx}`);
        const hours = hoursInput ? Number(hoursInput.value) : 0;
        const level = document.getElementById(`workerLevel_${idx}`)?.value || "中级";
        const note = document.getElementById(`workerNote_${idx}`)?.value;
        if (!isNaN(hours) && hours > 0) {
          totalHours += hours;
          logs.push({
            workerId: w.id,
            workerName: w.name,
            hours: hours,
            level: level,
            date: dateStr,
            note: note || null
          });
        }
      });
      
      outsourcedWorkers.forEach((name, idx) => {
        const hoursInput = document.getElementById(`outsourcedHours_${idx}`);
        const hours = hoursInput ? Number(hoursInput.value) : 0;
        const level = document.getElementById(`outsourcedLevel_${idx}`)?.value || "中级";
        const note = document.getElementById(`outsourcedNote_${idx}`)?.value;
        if (!isNaN(hours) && hours > 0) {
          totalHours += hours;
          logs.push({
            workerId: "outsourced:" + name,
            workerName: name,
            hours: hours,
            level: level,
            date: dateStr,
            note: note || null,
            isOutsourced: true
          });
        }
      });
      
      if (workers.length === 0 && outsourcedWorkers.length === 0) {
        toast("项目未分配施工人员，无法登记工时");
        return false;
      }
      
      if (totalHours <= 0) {
        toast("请至少填写一个人员的工时");
        return false;
      }
      
      const pauseCount = derivePauseCount(p);
      if (pauseCount > 0) {
        const pauseDurationTotal = derivePauseDuration(p);
        const pauseHours = Math.floor(pauseDurationTotal);
        const pauseMins = Math.floor((pauseDurationTotal - pauseHours) * 60);
        const pauseTimeStr = pauseHours > 0 ? `${pauseHours}小时${pauseMins}分钟` : `${pauseMins}分钟`;
        const confirmHtml = `该项目施工过程中曾暂停 ${pauseCount} 次，累计暂停 ${pauseTimeStr}，已从总用时中扣除。<br><br>确认要完成该项目吗？`;
        if (!(await confirmDialog(confirmHtml, "确认完工"))) {
          return false;
        }
      }
      
      const now = new Date();
      const nowStr = now.toISOString();
      
      const accumulatedWorkHours = p.accumulatedWorkHours || 0;
      let currentWorkDuration = 0;
      if (p.startedAt) {
        const started = new Date(p.startedAt);
        let endTime = now;
        if (p.status === STATUS.PAUSED && (p.pausedAt)) {
          endTime = new Date(p.pausedAt);
        }
        currentWorkDuration = (endTime - started) / (1000 * 60 * 60);
      }
      const totalWorkHours = Math.max(0, accumulatedWorkHours + currentWorkDuration);
      
      const workSessions = [...(p.workSessions || [])];
      if (p.startedAt && currentWorkDuration > 0) {
        let endTime = nowStr;
        if (p.status === STATUS.PAUSED && (p.pausedAt)) {
          endTime = p.pausedAt;
        }
        workSessions.push({
          startTime: p.startedAt,
          endTime: endTime,
          duration: currentWorkDuration
        });
      }
      
      p.status = STATUS.DONE;
      p.actualHours = totalHours;
      p.finishedAt = nowStr;
      p.accumulatedWorkHours = totalWorkHours;
      p.workSessions = workSessions;
      
      const newLogs = logs.map(log => ({ id: uid(), ...log }));
      const newLogKeys = new Set(newLogs.map(l => `${l.workerId}_${l.date}`));
      const preservedLogs = (p.workLogs || []).filter(l => !newLogKeys.has(`${l.workerId}_${l.date}`));
      p.workLogs = [...preservedLogs, ...newLogs];
      
      if (MODE === "cloud" && cloudConfigured()) {
        sb.from("work_logs").delete().eq("project_id", id).eq("date", dateStr).then(() => {
          return Promise.all([
            sb.from("projects").update({ 
              status: STATUS.DONE, 
              actual_hours: p.actualHours, 
              finished_at: nowStr, 
              accumulated_work_hours: totalWorkHours, 
              work_sessions: workSessions,
              updated_at: nowStr 
            }).eq("id", id),
            ...newLogs.map(log => 
              sb.from("work_logs").insert({
                id: log.id, project_id: id, worker_id: log.workerId,
                worker_name: log.workerName, hours: log.hours, date: log.date, note: log.note,
                level: log.level || "中级",
                is_outsourced: log.isOutsourced || false
              })
            )
          ]);
        }).then(async () => {
          await repo.loadAll();
          toast(`项目已完工，总工时：${totalHours}小时`);
          renderConstruction();
          renderAll();
        }).catch((error) => {
          console.error("标记完工失败:", error);
          toast("更新失败：" + (error.message || "未知错误"));
        });
      } else {
        saveLocal();
        await repo.loadAll();
        toast(`项目已完工，总工时：${totalHours}小时`);
        renderConstruction();
        renderAll();
      }
      
      return true;
    }
  });
}

function openAcceptance(id) {
  const p = getProject(id);
  const ac = p.acceptance || {};
  modal.open("确认验收 - 填写验收信息", `
    <div class="form-grid">
      <div class="form-row">
        <label>验收人 *</label>
        <input class="input" id="acBy" value="${esc(ac.acceptedBy || "")}" placeholder="验收负责人" />
      </div>
      <div class="form-row">
        <label>验收时间</label>
        <input class="input" type="date" id="acAt" value="${esc(ac.acceptedAt || new Date().toISOString().slice(0,10))}" />
      </div>
      <div class="form-row">
        <label>验收类型</label>
        <select class="input" id="acType">
          ${["现场验收", "远程验收", "第三方验收", "内部验收"].map((t) =>
            `<option value="${t}" ${ac.type === t ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </div>
      <div class="form-row">
        <label>验收方式</label>
        <select class="input" id="acMethod">
          ${["实物验收", "图片验收", "视频验收", "混合验收"].map((m) =>
            `<option value="${m}" ${ac.method === m ? "selected" : ""}>${m}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="form-row">
      <label>验收结果</label>
      <select class="input" id="acQuality">
        ${["合格", "整改后合格", "不合格"].map((q) =>
          `<option value="${q}" ${ac.quality === q ? "selected" : ""}>${q}</option>`).join("")}
      </select>
    </div>
    <div class="form-row">
      <label>验收结论</label>
      <select class="input" id="acConclusion">
        ${["通过", "有条件通过", "不通过"].map((c) =>
          `<option value="${c}" ${ac.conclusion === c ? "selected" : ""}>${c}</option>`).join("")}
      </select>
    </div>
    <div class="form-row">
      <label>验收备注</label>
      <textarea class="input" id="acNote" placeholder="现场情况、遗留问题、整改要求等">${esc(ac.note || "")}</textarea>
    </div>
    <div class="form-row" style="grid-column:1/-1;">
      <label>验收项检查</label>
      <div style="display:flex;flex-wrap:wrap;gap:12px;">
        ${["安装位置准确", "安装牢固", "外观整洁", "功能正常", "安全达标"].map((item, idx) => `
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" id="acItem_${idx}" ${ac.items && ac.items.includes(item) ? "checked" : ""} />
            <span>${item}</span>
          </label>
        `).join("")}
      </div>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="modal.close()">取消</button>
      <button class="btn primary" onclick="saveAcceptance('${id}')">确认验收</button>
    </div>
  `);
}

async function saveAcceptance(id) {
  const by = document.getElementById("acBy").value.trim();
  if (!by) { toast("请填写验收人"); return; }
  
  const items = [];
  const checkItems = ["安装位置准确", "安装牢固", "外观整洁", "功能正常", "安全达标"];
  checkItems.forEach((item, idx) => {
    if (document.getElementById(`acItem_${idx}`)?.checked) {
      items.push(item);
    }
  });
  
  const acceptance = {
    acceptedBy: by,
    acceptedAt: document.getElementById("acAt").value,
    type: document.getElementById("acType").value,
    method: document.getElementById("acMethod").value,
    quality: document.getElementById("acQuality").value,
    conclusion: document.getElementById("acConclusion").value,
    note: document.getElementById("acNote").value.trim(),
    items: items,
  };
  await repo.patchProject(id, { acceptance, status: STATUS.ACCEPTED });
  await repo.loadAll();
  modal.close();
  renderAll();
  toast("验收信息已保存");
  
  const p = getProject(id);
  if (p) {
    sendNotificationForProjectChange("accepted", p);
    logOperation("PROJECT_ACCEPT", p.name || "项目", `ID: ${id}, 验收人: ${by}, 结果: ${acceptance.quality}, 结论: ${acceptance.conclusion}`);
  }
}

/* ============================================================
 * 月底工时统计模块
 * ============================================================ */
function refreshWorkerSelectors() {
  const sel = document.getElementById("statsWorker");
  const prev = sel.value;
  sel.innerHTML = `<option value="">全部人员</option>` +
    cache.workers.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("");
  if (prev) sel.value = prev;
}

function refreshStoreSelectors() {
  const sel = document.getElementById("statsStore");
  const prev = sel.value;
  
  if (!perm.viewGlobalStats() && myStore()) {
    const myStoreId = myStore();
    const myStoreObj = cache.stores.find(s => s.id === myStoreId);
    sel.innerHTML = myStoreObj ? `<option value="${myStoreId}" selected>${esc(myStoreObj.name)}</option>` : `<option value="">请选择门店</option>`;
    sel.disabled = true;
  } else {
    sel.innerHTML = `<option value="">全部店面</option>` +
      cache.stores.map((s) => `<option value="${s.id}" ${s.id === myStore() ? 'selected' : ''}>${esc(s.name)}</option>`).join("");
    sel.disabled = false;
  }
  
  if (prev) sel.value = prev;
}

function collectStats() {
  const period = document.getElementById("statsPeriod").value;
  const month = document.getElementById("statsMonth").value;
  let storeFilter = document.getElementById("statsStore").value;
  const workerFilter = document.getElementById("statsWorker").value;
  const statusFilter = document.getElementById("statsStatus").value;
  
  if (!perm.viewGlobalStats() && myStore() && !storeFilter) {
    storeFilter = myStore();
  }
  
  function isInPeriod(dateStr) {
    if (!month) return true;
    const [year, m] = month.split("-").map(Number);
    if (period === "month") {
      return monthKey(dateStr) === month;
    } else if (period === "quarter") {
      const quarter = Math.ceil(m / 3);
      const [logYear, logMonth] = monthKey(dateStr).split("-").map(Number);
      const logQuarter = Math.ceil(logMonth / 3);
      return logYear === year && logQuarter === quarter;
    } else if (period === "year") {
      return dateStr.startsWith(year + "-");
    }
    return true;
  }

  const rows = {};
  cache.projects.forEach((p) => {
    if (storeFilter && p.storeId !== storeFilter) return;
    (p.workLogs || []).forEach((l) => {
      const logMonth = monthKey(l.date);
      if (!isInPeriod(l.date)) return;
      if (workerFilter && l.workerId !== workerFilter) return;
      const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
      const key = l.workerId || l.workerName || l.id;
      if (!rows[key]) {
        rows[key] = { name: l.workerName || "未知", hours: 0, levelHours: {初级:0, 中级:0, 高级:0, 特级:0}, days: new Set(), projects: new Set(), daily: {}, leaveDays: new Set(), leaveRecords: [], isOutsourced: false };
      }
      if (isOutsourced) rows[key].isOutsourced = true;
      const level = l.level || "中级";
      const hours = Number(l.hours) || 0;
      rows[key].hours += hours;
      rows[key].levelHours[level] += hours;
      rows[key].days.add(fmtDate(l.date));
      rows[key].projects.add(p.name);
      const dayKey = l.date;
      if (!rows[key].daily[dayKey]) {
        rows[key].daily[dayKey] = [];
      }
      rows[key].daily[dayKey].push({ hours: Number(l.hours) || 0, level: level, project: p.name });
    });
  });
  
  getInternalWorkLogs().forEach((l) => {
    if (!isInPeriod(l.date)) return;
    if (workerFilter && l.workerId !== workerFilter) return;
    const key = l.workerId || l.workerName || l.id;
    if (!rows[key]) {
      const w = getWorker(l.workerId);
      rows[key] = { name: l.workerName || (w ? w.name : "未知"), hours: 0, levelHours: {初级:0, 中级:0, 高级:0, 特级:0}, days: new Set(), projects: new Set(), daily: {}, leaveDays: new Set(), leaveRecords: [], isOutsourced: false };
    }
    const level = l.level || "中级";
    const hours = Number(l.hours) || 0;
    rows[key].hours += hours;
    rows[key].levelHours[level] += hours;
    rows[key].days.add(fmtDate(l.date));
    rows[key].projects.add("内部工作");
    const dayKey = l.date;
    if (!rows[key].daily[dayKey]) {
      rows[key].daily[dayKey] = [];
    }
    rows[key].daily[dayKey].push({ hours: hours, level: level, project: l.workType, isInternal: true });
  });
  
  cache.leaveRecords.forEach((l) => {
    if (l.status !== "approved") return;
    if (workerFilter && l.workerId !== workerFilter) return;
    if (!rows[l.workerId]) {
      const w = getWorker(l.workerId);
      rows[l.workerId] = { name: l.workerName || (w ? w.name : "未知"), hours: 0, levelHours: {初级:0, 中级:0, 高级:0, 特级:0}, days: new Set(), projects: new Set(), daily: {}, leaveDays: new Set(), leaveRecords: [], isOutsourced: false };
    }
    const start = new Date(l.startDate);
    const end = new Date(l.endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateKey = fmtDate(d);
      if (!isInPeriod(dateKey)) continue;
      rows[l.workerId].leaveDays.add(dateKey);
    }
    if (!month || isInPeriod(l.startDate) || isInPeriod(l.endDate)) {
      rows[l.workerId].leaveRecords.push(l);
    }
  });
  
  return Object.values(rows).map((r) => ({
    name: r.name,
    hours: r.hours,
    levelHours: r.levelHours,
    days: r.days.size,
    projects: r.projects.size,
    daily: r.daily,
    leaveDays: r.leaveDays.size,
    leaveRecords: r.leaveRecords,
    isOutsourced: r.isOutsourced,
  })).sort((a, b) => b.hours - a.hours);
}

/* 按预约时间归月的项目工时差异统计 */
function collectProjectStats() {
  const period = document.getElementById("statsPeriod").value;
  const month = document.getElementById("statsMonth").value;
  let storeFilter = document.getElementById("statsStore").value;
  const workerFilter = document.getElementById("statsWorker").value;
  const statusFilter = document.getElementById("statsStatus").value;
  
  if (!perm.viewGlobalStats() && myStore() && !storeFilter) {
    storeFilter = myStore();
  }
  
  function isInPeriod(dateStr) {
    if (!month) return true;
    const [year, m] = month.split("-").map(Number);
    if (period === "month") {
      return monthKey(dateStr) === month;
    } else if (period === "quarter") {
      const quarter = Math.ceil(m / 3);
      const [logYear, logMonth] = monthKey(dateStr).split("-").map(Number);
      const logQuarter = Math.ceil(logMonth / 3);
      return logYear === year && logQuarter === quarter;
    } else if (period === "year") {
      return dateStr.startsWith(year + "-");
    }
    return true;
  }

  return cache.projects
    .filter((p) => {
      if (!isInPeriod(p.appointmentTime)) return false;
      if (storeFilter && p.storeId !== storeFilter) return false;
      if (statusFilter && p.status !== statusFilter) return false;
      return true;
    })
    .map((p) => {
      const est = Number(p.estimatedHours) || 0;
      const act = (p.workLogs || []).reduce((sum, l) => sum + (Number(l.hours) || 0), 0);
      const diff = act - est;
      const hasActual = act > 0;
      // 按施工人员汇总工时（区分内部和外协）
      const workerMap = {};
      const outsourcedWorkerMap = {};
      const levelHours = {初级:0, 中级:0, 高级:0, 特级:0};
      (p.workLogs || []).forEach((l) => {
        if (workerFilter && l.workerId !== workerFilter) return;
        const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
        const key = l.workerId || l.workerName || "未知";
        const nm = l.workerName || "未知";
        const level = l.level || "中级";
        const hours = Number(l.hours) || 0;
        levelHours[level] += hours;
        if (isOutsourced) {
          if (!outsourcedWorkerMap[key]) outsourcedWorkerMap[key] = { name: nm, hours: 0, levelHours: {初级:0, 中级:0, 高级:0, 特级:0} };
          outsourcedWorkerMap[key].hours += hours;
          outsourcedWorkerMap[key].levelHours[level] += hours;
        } else {
          if (!workerMap[key]) workerMap[key] = { name: nm, hours: 0, levelHours: {初级:0, 中级:0, 高级:0, 特级:0} };
          workerMap[key].hours += hours;
          workerMap[key].levelHours[level] += hours;
        }
      });
      const workerHours = Object.values(workerMap)
        .sort((a, b) => b.hours - a.hours)
        .map((data) => ({ name: data.name, hours: data.hours, levelHours: data.levelHours, isOutsourced: false }));
      const outsourcedWorkerHours = Object.values(outsourcedWorkerMap)
        .sort((a, b) => b.hours - a.hours)
        .map((data) => ({ name: data.name, hours: data.hours, levelHours: data.levelHours, isOutsourced: true }));
      const outsourcedCount = outsourcedWorkerHours.length;
      const totalOutsourcedHoursFromLogs = Object.values(outsourcedWorkerMap).reduce((sum, h) => sum + (h.hours || 0), 0);
      const autoWorkerHours = [];
      if ([STATUS.DONE, STATUS.ACCEPTED, STATUS.REVIEWED].includes(p.status) && p.startedAt && p.finishedAt) {
        const workerPeriods = {};
        const allWorkerIds = new Set([...(p.assignedWorkerIds || [])]);
        (p.workerChangeHistory || []).forEach(ch => {
          if (ch.workerId) allWorkerIds.add(ch.workerId);
        });
        allWorkerIds.forEach((wid) => {
          workerPeriods[wid] = buildWorkerPeriods(p, wid);
        });
        (p.workerChangeHistory || []).forEach((ch) => {
          const wid = ch.workerId;
          if (ch.action === "unassign" && workerPeriods[wid]) {
            const lastPeriod = workerPeriods[wid][workerPeriods[wid].length - 1];
            if (lastPeriod) {
              lastPeriod.end = ch.time;
              lastPeriod.autoHours = ch.autoHours;
            }
          }
        });
        const projectEndTime = getProjectEffectiveEndTime(p).toISOString();
        allWorkerIds.forEach((wid) => {
          if (workerPeriods[wid] && workerPeriods[wid].length > 0) {
            const lastPeriod = workerPeriods[wid][workerPeriods[wid].length - 1];
            if (!lastPeriod.end) {
              lastPeriod.end = projectEndTime;
            }
          }
        });
        allWorkerIds.forEach((wid) => {
          if (workerFilter && wid !== workerFilter) return;
          const worker = cache.workers.find(w => w.id === wid);
          const name = worker ? worker.name : "未知";
          const periods = workerPeriods[wid] || [];
          let hours = 0;
          periods.forEach(pr => {
            const start = new Date(pr.start);
            const end = pr.end ? new Date(pr.end) : new Date(projectEndTime);
            let duration = (end - start) / (1000 * 60 * 60);
            hours += duration;
          });
          hours = Math.round(hours * 10) / 10;
          if (hours > 0) {
            autoWorkerHours.push({ name, hours });
          }
        });
      } else {
        const autoLogs = (p.workLogs || []).filter(l => {
          if (workerFilter && l.workerId !== workerFilter) return false;
          return l.note && l.note.includes("系统自动计算");
        });
        autoLogs.forEach(l => {
          autoWorkerHours.push({ name: l.workerName || "未知", hours: Number(l.hours) || 0 });
        });
      }
      if ([STATUS.WORKING].includes(p.status) && p.startedAt) {
        const workerPeriods = {};
        (p.assignedWorkerIds || []).forEach((wid) => {
          workerPeriods[wid] = buildWorkerPeriods(p, wid);
        });
        (p.workerChangeHistory || []).forEach((ch) => {
          const wid = ch.workerId;
          if (ch.action === "unassign" && workerPeriods[wid]) {
            const lastPeriod = workerPeriods[wid][workerPeriods[wid].length - 1];
            if (lastPeriod) {
              lastPeriod.end = ch.time;
              lastPeriod.autoHours = ch.autoHours;
            }
          }
        });
        const projectEndTime = getProjectEffectiveEndTime(p).toISOString();
        (p.assignedWorkerIds || []).forEach((wid) => {
          if (workerPeriods[wid] && workerPeriods[wid].length > 0) {
            const lastPeriod = workerPeriods[wid][workerPeriods[wid].length - 1];
            if (!lastPeriod.end) {
              lastPeriod.end = projectEndTime;
            }
          }
        });
        (p.assignedWorkerIds || []).forEach((wid) => {
          if (workerFilter && wid !== workerFilter) return;
          const worker = cache.workers.find(w => w.id === wid);
          const name = worker ? worker.name : "未知";
          const periods = workerPeriods[wid] || [];
          let hours = 0;
          periods.forEach(pr => {
            const start = new Date(pr.start);
            const end = pr.end ? new Date(pr.end) : new Date(projectEndTime);
            let duration = (end - start) / (1000 * 60 * 60);
            hours += duration;
          });
          hours = Math.round(hours * 10) / 10;
          if (hours > 0) {
            autoWorkerHours.push({ name, hours });
          }
        });
      }
      const autoHours = autoWorkerHours.reduce((sum, w) => sum + w.hours, 0);
      const notes = (p.workLogs || [])
        .filter(l => l.note && l.note.trim() && (!workerFilter || l.workerId === workerFilter))
        .map(l => (l.workerName || "未知") + "：" + l.note.trim())
        .join("；");
      return { 
        id: p.id, 
        name: p.name, 
        status: p.status, 
        est, 
        act, 
        diff, 
        hasActual, 
        workerHours, 
        outsourcedWorkerHours,
        levelHours,
        outsourcedCount, 
        hasOutsourced: outsourcedCount > 0, 
        outsourcedHours: p.outsourcedHours || 0, 
        outsourcedHoursFromLogs: Math.max(p.outsourcedHoursFromLogs || 0, totalOutsourcedHoursFromLogs),
        date: p.appointmentTime,
        store: storeName(p.storeId),
        autoHours,
        autoWorkerHours,
        notes,
        appointmentTime: p.appointmentTime,
        startedAt: p.startedAt
      };
    })
    .sort((a, b) => b.diff - a.diff);
}

function renderStats() {
  const rows = collectStats();
  const totalHours = rows.reduce((s, r) => s + r.hours, 0);

  const projRows = collectProjectStats();
  
  const period = document.getElementById("statsPeriod").value;
  const month = document.getElementById("statsMonth").value;
  let storeFilter = document.getElementById("statsStore").value;
  
  if (!perm.viewGlobalStats() && myStore() && !storeFilter) {
    storeFilter = myStore();
  }
  
  function isInPeriod(dateStr) {
    if (!month) return true;
    const [year, m] = month.split("-").map(Number);
    if (period === "month") {
      return monthKey(dateStr) === month;
    } else if (period === "quarter") {
      const quarter = Math.ceil(m / 3);
      const [logYear, logMonth] = monthKey(dateStr).split("-").map(Number);
      const logQuarter = Math.ceil(logMonth / 3);
      return logYear === year && logQuarter === quarter;
    } else if (period === "year") {
      return dateStr.startsWith(year + "-");
    }
    return true;
  }
  
  const allProjects = cache.projects.filter(p => {
    if (!isInPeriod(p.appointmentTime)) return false;
    if (storeFilter && p.storeId !== storeFilter) return false;
    return true;
  });
  const recorded = projRows.filter((r) => r.hasActual);
  const totalEst = allProjects.reduce((s, r) => s + (Number(r.estimatedHours) || 0), 0);
  const totalAct = allProjects.reduce((s, r) => s + ((r.workLogs || []).reduce((sum, l) => sum + (Number(l.hours) || 0), 0)), 0);
  const totalDiff = totalAct - totalEst;
  
  const totalOutsourcedHours = rows.filter(r => r.isOutsourced).reduce((s, r) => s + r.hours, 0);
  const totalOutsourcedWorkers = rows.filter(r => r.isOutsourced).length;

  const internalRows = rows.filter(r => !r.isOutsourced);
  const avgHours = internalRows.length > 0 ? (internalRows.reduce((s, r) => s + r.hours, 0) / internalRows.length).toFixed(1) : 0;
  const topWorker = internalRows.length > 0 ? internalRows[0].name : "";
  const topHours = internalRows.length > 0 ? internalRows[0].hours : 0;
  
  const efficiencyRate = totalEst > 0 ? ((totalAct / totalEst) * 100).toFixed(0) : 0;
  let efficiencyColor = "#10b981";
  let efficiencyLabel = "高效";
  if (efficiencyRate < 80) { efficiencyColor = "#ef4444"; efficiencyLabel = "低效"; }
  else if (efficiencyRate < 100) { efficiencyColor = "#f59e0b"; efficiencyLabel = "正常"; }
  
  const summary = document.getElementById("statsSummary");
  
  if (!perm.viewGlobalStats() && myStore()) {
    summary.innerHTML = `
      <div class="stat-card"><div class="num">${totalEst}</div><div class="lbl">预计工时(小时)</div></div>
      <div class="stat-card"><div class="num">${totalAct}</div><div class="lbl">实际工时(小时)</div></div>
      <div class="stat-card"><div class="num" style="color:${diffColor(totalDiff)}">${fmtSignedDiff(totalDiff)}</div><div class="lbl">工时差异</div></div>
      <div class="stat-card"><div class="num" style="color:${efficiencyColor}">${efficiencyRate}%</div><div class="lbl">效率(${efficiencyLabel})</div></div>
    `;
  } else {
    summary.innerHTML = `
      <div class="stat-card"><div class="num">${rows.length}</div><div class="lbl">参与施工人数</div></div>
      <div class="stat-card"><div class="num">${totalHours}</div><div class="lbl">合计工时(小时)</div></div>
      <div class="stat-card"><div class="num">${totalEst}</div><div class="lbl">预计工时(小时)</div></div>
      <div class="stat-card"><div class="num">${totalAct}</div><div class="lbl">实际工时(小时)</div></div>
      <div class="stat-card"><div class="num" style="color:#8b5cf6">${totalOutsourcedHours}h</div><div class="lbl">外协工时</div></div>
      <div class="stat-card"><div class="num" style="color:#8b5cf6">${totalOutsourcedWorkers}人</div><div class="lbl">外协人员</div></div>
      <div class="stat-card"><div class="num" style="color:${diffColor(totalDiff)}">${fmtSignedDiff(totalDiff)}</div><div class="lbl">工时差异</div></div>
      <div class="stat-card"><div class="num">${avgHours}</div><div class="lbl">人均工时(小时)</div></div>
      <div class="stat-card"><div class="num" style="color:${efficiencyColor}">${efficiencyRate}%</div><div class="lbl">效率(${efficiencyLabel})</div></div>
    `;
  }

  const workerTable = rows.length === 0
    ? `<div class="empty">所选月份暂无施工工时记录。</div>`
    : rows.map((r) => {
        const monthVal = document.getElementById("statsMonth").value;
        let calGrid = "";
        if (monthVal) {
          const [year, month] = monthVal.split("-").map(Number);
          const startWeekday = new Date(year, month - 1, 1).getDay();
          const daysInMonth = new Date(year, month, 0).getDate();
          const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
          
          calGrid = `
            <div class="worker-cal-header">${weekdays.map((w) => `<div>${w}</div>`).join("")}</div>
            <div class="worker-cal-grid">`;
          
          const daysInPrevMonth = new Date(year, month - 1, 0).getDate();
          for (let i = startWeekday - 1; i >= 0; i--) {
            const day = daysInPrevMonth - i;
            calGrid += `<div class="worker-cal-cell other-month">${day}</div>`;
          }
          
          for (let day = 1; day <= daysInMonth; day++) {
            const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const dayLogs = r.daily[dateKey] || [];
            const hours = dayLogs.length > 0 ? dayLogs.reduce((sum, log) => sum + log.hours, 0) : 0;
            const isLeaveDay = r.leaveRecords.some((lr) => dateKey >= lr.startDate && dateKey <= lr.endDate);
            const hasInternal = dayLogs.some(log => log.isInternal);
            calGrid += `<div class="worker-cal-cell ${hours ? "has-hours" : ""} ${isLeaveDay ? "leave-day" : ""} ${hasInternal ? "internal-hours" : ""}">
              <div class="day-num">${day}</div>
              ${hours ? `<div class="day-hours">${hours}h</div>` : ""}
              ${hasInternal ? `<div class="day-internal">📋</div>` : ""}
              ${isLeaveDay ? `<div class="day-leave">🌴</div>` : ""}
            </div>`;
          }
          
          let totalCells = startWeekday + daysInMonth;
          const remainingCells = (Math.ceil(totalCells / 7) * 7) - totalCells;
          for (let i = 1; i <= remainingCells; i++) {
            calGrid += `<div class="worker-cal-cell other-month">${i}</div>`;
          }
          
          calGrid += `</div>`;
        }
        
        const dailyTable = monthVal ? `
          <div class="worker-cal-container">
            <div class="worker-cal-label">📅 本月工时日历</div>
            <div class="worker-cal">${calGrid}</div>
          </div>` : `
          <div class="daily-hours-list">
            ${Object.entries(r.daily).sort(([a], [b]) => a.localeCompare(b)).flatMap(([date, logs]) => 
              logs.map((log) => `<div class="daily-item"><span class="daily-date">${esc(date)}</span><span class="daily-hours">${log.hours}h</span><span class="daily-level">${esc(log.level)}</span><span class="daily-project">${log.isInternal ? '📋 ' : ''}${esc(log.project || '')}</span></div>`)
            ).join("")}
          </div>`;
          
        const rowColor = r.isOutsourced ? 'color:#8b5cf6' : '';
        const vsAvg = r.isOutsourced ? "" : ((r.hours - avgHours) >= 0 ? "+" : "") + (r.hours - avgHours).toFixed(1);
        const vsAvgColor = r.isOutsourced ? "" : (r.hours >= avgHours ? "#10b981" : "#ef4444");
        return `
        <div class="detail-block" style="padding:0;overflow:hidden;margin-bottom:16px">
          <table class="data">
            <thead>
              <tr><th>施工人员</th><th>工时(小时)</th><th>vs平均</th><th>初级</th><th>中级</th><th>高级</th><th>特级</th><th>施工天数</th><th>请假天数</th><th>参与项目数</th></tr>
            </thead>
            <tbody>
              <tr>
                <td style="${rowColor}">${esc(r.name)}${r.isOutsourced ? ' (外协)' : ''}</td>
                <td style="${rowColor}"><b>${r.hours}</b></td>
                <td style="${vsAvgColor}">${vsAvg || "—"}</td>
                <td style="color:#6b7280">${r.levelHours?.初级 || 0}</td>
                <td style="color:#3b82f6">${r.levelHours?.中级 || 0}</td>
                <td style="color:#f59e0b">${r.levelHours?.高级 || 0}</td>
                <td style="color:#dc2626">${r.levelHours?.特级 || 0}</td>
                <td>${r.days}</td>
                <td>${r.leaveDays > 0 ? `<span style="color:#ef4444;font-weight:600">${r.leaveDays}天</span>` : "0"}</td>
                <td>${r.projects}</td>
              </tr>
            </tbody>
          </table>
          ${r.leaveRecords.length > 0 ? `
            <div style="padding:12px;border-top:1px solid var(--border);background:#fef2f2">
              <div style="font-weight:600;color:#dc2626;margin-bottom:8px">🌴 本月请假记录</div>
              <div style="display:flex;flex-direction:column;gap:4px">
                ${r.leaveRecords.map((lr) => `
                  <div style="font-size:13px">
                    <span>${formatLeaveTime(lr)}</span>
                    ${lr.reason ? `<span style="margin-left:8px;color:var(--muted)">· ${esc(lr.reason)}</span>` : ""}
                  </div>
                `).join("")}
              </div>
            </div>` : ""}
          ${dailyTable}
        </div>`;
      }).join("") + `
      <div class="detail-block" style="padding:0;overflow:hidden">
        <table class="data">
          <tbody>
            <tr><td><b>合计</b></td><td><b>${totalHours}</b></td><td></td>
              <td>${rows.reduce((s, r) => s + (r.levelHours?.初级 || 0), 0)}</td>
              <td>${rows.reduce((s, r) => s + (r.levelHours?.中级 || 0), 0)}</td>
              <td>${rows.reduce((s, r) => s + (r.levelHours?.高级 || 0), 0)}</td>
              <td>${rows.reduce((s, r) => s + (r.levelHours?.特级 || 0), 0)}</td>
              <td colspan="4"></td>
            </tr>
          </tbody>
        </table>
      </div>`;

  const projectTable = projRows.length === 0
    ? `<div class="empty">所选月份暂无项目。</div>`
    : `
    <div class="detail-block hours-diff-wrap" style="padding:0">
      <table class="data project-hours-diff">
        <thead>
          <tr>
            <th class="col-date">日期</th>
            <th class="col-time">预约开工</th>
            <th class="col-time">实际开工</th>
            <th class="col-store">店面</th>
            <th class="col-name">项目</th>
            <th class="col-status">状态</th>
            <th class="col-num">预计<br>工时</th>
            <th class="col-num">实际<br>工时</th>
            <th class="col-num">差异</th>
            <th class="col-num">初级</th>
            <th class="col-num">中级</th>
            <th class="col-num">高级</th>
            <th class="col-num">特级</th>
            <th class="col-workers">施工人员工时</th>
            <th class="col-num" style="color:#8b5cf6">外协人数</th>
            <th class="col-auto">系统自动工时</th>
            <th class="col-notes">工时备注</th>
          </tr>
        </thead>
        <tbody>
          ${projRows.map((r) => {
            const workerChips = [
              ...r.workerHours.map((w) => `<span class="worker-chip internal">${esc(w.name)} <b>${w.hours}h</b></span>`),
              ...r.outsourcedWorkerHours.map((w) => `<span class="worker-chip outsourced">${esc(w.name)} <b>${w.hours}h</b></span>`)
            ].join("");
            const outsourcedCount = r.outsourcedWorkerHours.length;
            const autoChips = (r.autoWorkerHours || []).map((w) => `<span class="worker-chip auto">${esc(w.name)} <b>${w.hours}h</b></span>`).join("");
            return `
            <tr>
              <td class="col-date">${r.date ? fmtDate(r.date) : "—"}</td>
              <td class="col-time">${r.appointmentTime ? fmtTime(r.appointmentTime) : "—"}</td>
              <td class="col-time">${r.startedAt ? fmtTime(r.startedAt) : "—"}</td>
              <td class="col-store">${esc(r.store || "—")}</td>
              <td class="col-name">${esc(r.name)}</td>
              <td class="col-status"><span class="badge ${r.status}">${r.status}</span></td>
              <td class="col-num">${r.est}</td>
              <td class="col-num">${r.hasActual ? r.act : "—"}</td>
              <td class="col-num" style="color:${r.hasActual ? diffColor(r.diff) : "var(--muted)"};font-weight:600">${r.hasActual ? fmtSignedDiff(r.diff) : "未登记"}</td>
              <td class="col-num" style="color:#6b7280">${r.levelHours?.初级 || 0}</td>
              <td class="col-num" style="color:#3b82f6">${r.levelHours?.中级 || 0}</td>
              <td class="col-num" style="color:#f59e0b">${r.levelHours?.高级 || 0}</td>
              <td class="col-num" style="color:#dc2626">${r.levelHours?.特级 || 0}</td>
              <td class="col-workers wrap">${workerChips || `<span style="color:var(--muted)">—</span>`}</td>
              <td class="col-num" style="color:#8b5cf6;font-weight:600">${outsourcedCount > 0 ? outsourcedCount + "人" : "—"}</td>
              <td class="col-auto wrap">${autoChips || `<span style="color:var(--muted)">—</span>`}</td>
              <td class="col-notes wrap">${r.notes || `<span style="color:var(--muted)">—</span>`}</td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot>
          <tr><td colspan="6">合计（已登记实际）</td><td>${totalEst}</td><td>${totalAct}</td><td style="color:${diffColor(totalDiff)};font-weight:600">${fmtSignedDiff(totalDiff)}</td>
            <td>${projRows.reduce((s, r) => s + (r.levelHours?.初级 || 0), 0)}</td>
            <td>${projRows.reduce((s, r) => s + (r.levelHours?.中级 || 0), 0)}</td>
            <td>${projRows.reduce((s, r) => s + (r.levelHours?.高级 || 0), 0)}</td>
            <td>${projRows.reduce((s, r) => s + (r.levelHours?.特级 || 0), 0)}</td>
            <td></td><td style="color:#8b5cf6;font-weight:600">${totalOutsourcedWorkers}人</td>
            <td style="color:#f59e0b;font-weight:600">${projRows.reduce((s, r) => s + (r.autoHours || 0), 0)}</td><td></td>
          </tr>
        </tfoot>
      </table>
    </div>`;

  let smartAnalysis = "";
  if (rows.length > 0 && perm.viewGlobalStats()) {
    const lowEfficiencyWorkers = internalRows.filter(r => r.hours > 0 && r.days > 0 && (r.hours / r.days) < 4);
    const highWorkloadWorkers = internalRows.filter(r => r.hours > 40);
    
    if (highWorkloadWorkers.length > 0) {
      smartAnalysis += `<div class="stats-analysis warning">🔥 <strong>高负荷预警</strong>：${highWorkloadWorkers.map(w => w.name).join("、")} 本月工时超过40小时，建议关注工作强度！</div>`;
    }
    
    if (lowEfficiencyWorkers.length > 0) {
      smartAnalysis += `<div class="stats-analysis info">💡 <strong>效率建议</strong>：${lowEfficiencyWorkers.map(w => w.name).join("、")} 日均工时不足4小时，可考虑增加任务量或培训提升。</div>`;
    }
    
    if (topWorker && topHours > 0) {
      smartAnalysis += `<div class="stats-analysis success">⭐ <strong>本月之星</strong>：${topWorker} 以 ${topHours} 小时领跑全队！</div>`;
    }
  }
  
  if (!perm.viewGlobalStats() && myStore()) {
    document.getElementById("statsTable").innerHTML = `
      <h3 class="stats-subhead">📐 项目工时差异（预计 vs 实际）</h3>
      ${projectTable}`;
  } else {
    document.getElementById("statsTable").innerHTML = `
      <h3 class="stats-subhead">🧠 智能分析</h3>
      ${smartAnalysis || `<div class="empty" style="padding:16px">暂无分析数据</div>`}
      <h3 class="stats-subhead">👷 人员安装工时</h3>
      ${workerTable}
      <h3 class="stats-subhead">📐 项目工时差异（预计 vs 实际）</h3>
      ${projectTable}`;
  }
}

function getWageConfig() {
  const stored = localStorage.getItem("wageConfig");
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.error("Failed to parse wage config:", e);
    }
  }
  return {初级: 10, 中级: 15, 高级: 20, 特级: 30};
}

function saveWageConfig(config) {
  localStorage.setItem("wageConfig", JSON.stringify(config));
}

function closeWageConfigModal() {
  const mask = document.getElementById("wageConfigModal");
  if (mask) mask.remove();
}

function showWageConfig() {
  if (!perm.manageWageConfig()) { toast("权限不足：此功能仅总经理可见"); return; }
  const config = getWageConfig();
  const isMobile = window.innerWidth <= 768;
  const popup = document.createElement("div");
  popup.id = "wageConfigModal";
  popup.className = "modal-mask";
  if (!isMobile) {
    const btn = document.getElementById("btnWageConfig");
    const btnRect = btn.getBoundingClientRect();
    popup.style.alignItems = "flex-start";
    popup.style.justifyContent = "flex-start";
    popup.style.paddingLeft = btnRect.left + "px";
    popup.style.paddingTop = (btnRect.bottom + 8) + "px";
  }
  let isDragging = false;
  popup.addEventListener("mousedown", function(e) {
    isDragging = false;
  });
  popup.addEventListener("mousemove", function(e) {
    isDragging = true;
  });
  popup.addEventListener("mouseup", function(e) {
    if (!isDragging && e.target === popup) {
      closeWageConfigModal();
    }
  });
  popup.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:${isMobile ? '90%' : '280px'};width:${isMobile ? 'auto' : '280px'};max-height:none;overflow:hidden;">
      <div class="modal-head">
        <h3>💰 工时单价设置</h3>
        <button class="modal-close" onclick="closeWageConfigModal()">×</button>
      </div>
      <div class="modal-body" style="padding:12px;">
        <p style="color:#666;margin-bottom:12px;font-size:12px;">设置各等级工时的单价（元/小时）</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-weight:bold;color:#007bff;font-size:12px;">初级</label>
            <input type="number" id="wageLevel1" value="${config.初级 || 10}" class="input" placeholder="10" style="font-size:12px;padding:6px 8px;width:100%;box-sizing:border-box;" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-weight:bold;color:#28a745;font-size:12px;">中级</label>
            <input type="number" id="wageLevel2" value="${config.中级 || 15}" class="input" placeholder="15" style="font-size:12px;padding:6px 8px;width:100%;box-sizing:border-box;" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-weight:bold;color:#ffc107;font-size:12px;">高级</label>
            <input type="number" id="wageLevel3" value="${config.高级 || 20}" class="input" placeholder="20" style="font-size:12px;padding:6px 8px;width:100%;box-sizing:border-box;" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-weight:bold;color:#dc3545;font-size:12px;">特级</label>
            <input type="number" id="wageLevel4" value="${config.特级 || 30}" class="input" placeholder="30" style="font-size:12px;padding:6px 8px;width:100%;box-sizing:border-box;" />
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeWageConfigModal()">取消</button>
        <button class="btn" onclick="saveWageConfigFromDialog()">保存</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

function saveWageConfigFromDialog() {
  const config = {
    初级: Number(document.getElementById("wageLevel1").value) || 10,
    中级: Number(document.getElementById("wageLevel2").value) || 15,
    高级: Number(document.getElementById("wageLevel3").value) || 20,
    特级: Number(document.getElementById("wageLevel4").value) || 30
  };
  saveWageConfig(config);
  closeWageConfigModal();
  toast("工时单价设置已保存");
}

function getInternalWorkLogs() {
  const stored = localStorage.getItem("internalWorkLogs");
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.error("Failed to parse internal work logs:", e);
    }
  }
  return [];
}

function saveInternalWorkLogs(logs) {
  localStorage.setItem("internalWorkLogs", JSON.stringify(logs));
}

function addInternalWorkLog(log) {
  const logs = getInternalWorkLogs();
  logs.push({
    id: 'internal_' + Date.now(),
    ...log,
    createdAt: new Date().toISOString()
  });
  saveInternalWorkLogs(logs);
}

async function deleteInternalWorkLog(id) {
  if (!isManager()) {
    toast("权限不足，只有总经理可以删除");
    return;
  }
  if (!(await confirmDialog("确定删除这条内部工时记录？", "删除记录"))) return;
  const logs = getInternalWorkLogs().filter(l => l.id !== id);
  saveInternalWorkLogs(logs);
  toast("已删除");
  showInternalWorkLogModal();
}

function closeInternalWorkLogModal() {
  const mask = document.getElementById("internalWorkLogModal");
  if (mask) mask.remove();
}

function showInternalWorkLogModal() {
  closeInternalWorkLogModal();
  
  const logs = getInternalWorkLogs();
  const workerOptions = cache.workers.map(w => `<option value="${w.id}" data-name="${esc(w.name)}">${esc(w.name)}</option>`).join("");
  const logRows = logs.map(l => `
    <div class="internal-log-item">
      <div class="internal-log-info">
        <div class="internal-log-name">${esc(l.workerName)}</div>
        <div class="internal-log-meta">${esc(l.workType)} · ${esc(l.level)}</div>
        <div class="internal-log-time">⏰ ${esc(l.startTime || '-')} ~ ${esc(l.endTime || '-')}</div>
      </div>
      <div class="internal-log-date">${esc(l.date)}</div>
      <div class="internal-log-hours">${esc(l.hours)}h</div>
      ${l.note ? `<div class="internal-log-note">${esc(l.note)}</div>` : ''}
      ${isManager() ? `<button class="btn tiny danger" onclick="deleteInternalWorkLog('${l.id}')">删除</button>` : ''}
    </div>
  `).join("");
  
  const popup = document.createElement("div");
  popup.id = "internalWorkLogModal";
  popup.className = "modal-mask";
  
  let isDragging = false;
  popup.addEventListener("mousedown", function(e) {
    isDragging = false;
  });
  popup.addEventListener("mousemove", function(e) {
    isDragging = true;
  });
  popup.addEventListener("mouseup", function(e) {
    if (!isDragging && e.target === popup) {
      closeInternalWorkLogModal();
    }
  });
  popup.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:420px;width:95%;max-height:90vh;overflow:hidden;">
      <div class="modal-head">
        <h3>📝 内部工时记录</h3>
        <button class="modal-close" onclick="closeInternalWorkLogModal()">×</button>
      </div>
      <div class="modal-body" style="padding:12px;overflow-y:auto;max-height:calc(90vh - 60px);">
        <div style="margin-bottom:10px;">
          <label style="font-size:12px;font-weight:600;color:#333;">施工人员</label>
          <select class="input" id="iwlWorker" onchange="updateIwlWorkerName()" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;">
            <option value="">请选择人员</option>
            ${workerOptions}
          </select>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">工作类型</label>
            <select class="input" id="iwlWorkType" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;">
              <option value="仓库工作">仓库工作</option>
              <option value="送货">送货</option>
              <option value="外出安装">外出安装</option>
              <option value="其他">其他</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">工时等级</label>
            <select class="input" id="iwlLevel" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;">
              <option value="初级">初级</option>
              <option value="中级" selected>中级</option>
              <option value="高级">高级</option>
              <option value="特级">特级</option>
            </select>
          </div>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">工作日期</label>
            <input class="input" type="date" id="iwlDate" value="${new Date().toISOString().slice(0,10)}" style="width:100%;margin-top:4px;padding:4px 6px;font-size:12px;" />
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">开始时间</label>
            <select class="input" id="iwlStartTime" style="width:100%;margin-top:4px;padding:4px 6px;font-size:12px;" onchange="calculateIwlHours()">
              ${generateTimeOptions("08:00")}
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">结束时间</label>
            <select class="input" id="iwlEndTime" style="width:100%;margin-top:4px;padding:4px 6px;font-size:12px;" onchange="calculateIwlHours()">
              ${generateTimeOptions("12:00")}
            </select>
          </div>
        </div>
        
        <div style="margin-bottom:10px;">
          <label style="font-size:12px;font-weight:600;color:#333;">工时(小时) <span style="color:#999;font-weight:normal;font-size:11px;">(自动计算)</span></label>
          <input class="input" type="number" min="0" step="0.1" id="iwlHours" placeholder="0" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;" />
        </div>
        
        <div style="margin-bottom:12px;">
          <label style="font-size:12px;font-weight:600;color:#333;">备注说明</label>
          <input class="input" id="iwlNote" placeholder="选填" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;" />
        </div>
        
        <button class="btn primary" onclick="saveInternalWorkLog()" style="width:100%;padding:8px;font-size:14px;">保存记录</button>
        
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee;">
          <h4 style="font-size:13px;font-weight:600;color:#333;margin-bottom:8px;">已记录的内部工时</h4>
          ${logs.length > 0 ? `
            <div style="display:flex;flex-direction:column;gap:6px;">${logRows}</div>
          ` : '<p style="color:#999;font-size:12px;text-align:center;padding:12px 0;">暂无记录</p>'}
        </div>
      </div>
    </div>`;
  document.body.appendChild(popup);
  calculateIwlHours();
}

function updateIwlWorkerName() {
  const select = document.getElementById("iwlWorker");
  const option = select.options[select.selectedIndex];
  if (option) {
    select.setAttribute("data-name", option.getAttribute("data-name") || option.text);
  }
}

function calculateIwlHours() {
  const startTime = document.getElementById("iwlStartTime");
  const endTime = document.getElementById("iwlEndTime");
  const hoursInput = document.getElementById("iwlHours");
  if (!startTime || !endTime || !hoursInput) return;
  
  const startVal = startTime.value;
  const endVal = endTime.value;
  if (!startVal || !endVal) return;
  
  const [startH, startM] = startVal.split(":").map(Number);
  const [endH, endM] = endVal.split(":").map(Number);
  
  let diffMinutes = (endH * 60 + endM) - (startH * 60 + startM);
  if (diffMinutes < 0) diffMinutes += 24 * 60;
  
  const hours = (diffMinutes / 60).toFixed(1);
  hoursInput.value = hours;
}

function saveInternalWorkLog() {
  const workerId = document.getElementById("iwlWorker").value;
  const workerName = document.getElementById("iwlWorker").getAttribute("data-name") || 
                     document.getElementById("iwlWorker").options[document.getElementById("iwlWorker").selectedIndex]?.text || "";
  const workType = document.getElementById("iwlWorkType").value;
  const date = document.getElementById("iwlDate").value;
  const startTime = document.getElementById("iwlStartTime").value;
  const endTime = document.getElementById("iwlEndTime").value;
  const hours = Number(document.getElementById("iwlHours").value);
  const level = document.getElementById("iwlLevel").value;
  const note = document.getElementById("iwlNote").value;
  
  if (!workerId) { toast("请选择施工人员"); return; }
  if (!date) { toast("请选择工作日期"); return; }
  if (!hours || hours <= 0) { toast("请输入有效的工时"); return; }
  
  addInternalWorkLog({
    workerId,
    workerName,
    workType,
    date,
    startTime,
    endTime,
    hours,
    level,
    note
  });
  
  toast("内部工时记录已保存");
  showInternalWorkLogModal();
  renderStats();
}

function getInternalTasks() {
  const stored = localStorage.getItem("internalTasks");
  if (stored) {
    try {
      let tasks = JSON.parse(stored);
      const migrated = localStorage.getItem("internalTasksMigrated_v2") === "true";
      tasks = tasks.map(t => {
        if (!t.scheduledStartTime && t.startTime && t.status === 'pending') {
          t.scheduledStartTime = t.startTime;
          t.scheduledEndTime = t.endTime;
        }
        if (!t.actualStartTime && t.startTime && (t.status === 'in_progress' || t.status === 'completed' || t.status === 'verified')) {
          t.actualStartTime = t.startTime;
        }
        if (!t.actualEndTime && t.endTime && (t.status === 'completed' || t.status === 'verified')) {
          t.actualEndTime = t.endTime;
        }
        if (!migrated && !t.verifiedAt && t.status === 'completed' && t.actualHours) {
          t.status = 'verified';
          t.verifiedAt = new Date().toLocaleString('zh-CN');
        }
        return t;
      });
      if (!migrated) {
        localStorage.setItem("internalTasks", JSON.stringify(tasks));
        localStorage.setItem("internalTasksMigrated_v2", "true");
      }
      return tasks;
    } catch (e) {
      console.error("Failed to parse internal tasks:", e);
    }
  }
  return [];
}

function updateInternalTaskBadge() {
  const tasks = getInternalTasks();
  const pendingCount = tasks.filter(t => t.status === 'pending').length;
  const needVerifyCount = tasks.filter(t => t.status === 'completed').length;
  const totalCount = pendingCount + needVerifyCount;
  
  document.querySelectorAll('[data-tab="internalTasks"]').forEach(btn => {
    btn.style.position = 'relative';
    const existingBadge = btn.querySelector('.badge-count');
    if (existingBadge) {
      existingBadge.remove();
    }
    
    if (totalCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge-count';
      badge.textContent = totalCount > 99 ? '99+' : totalCount;
      btn.appendChild(badge);
    }
  });
}

function saveInternalTasks(tasks) {
  localStorage.setItem("internalTasks", JSON.stringify(tasks));
}

function addInternalTask(task) {
  const tasks = getInternalTasks();
  tasks.push({
    id: 'task_' + Date.now(),
    ...task,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  saveInternalTasks(tasks);
}

function updateInternalTask(id, updates) {
  const tasks = getInternalTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx !== -1) {
    tasks[idx] = { ...tasks[idx], ...updates };
    saveInternalTasks(tasks);
  }
}

async function deleteInternalTask(id) {
  if (!isManager()) {
    toast("权限不足，只有总经理可以删除");
    return;
  }
  if (!(await confirmDialog("确定删除这条内部任务记录？", "删除记录"))) return;
  const tasks = getInternalTasks().filter(t => t.id !== id);
  saveInternalTasks(tasks);
  toast("已删除");
  renderInternalTasks();
}

function closeNewInternalTaskModal() {
  const mask = document.getElementById("newInternalTaskModal");
  if (mask) mask.remove();
}

function showNewInternalTaskModal() {
  closeNewInternalTaskModal();
  
  const workerOptions = cache.workers.map(w => `<option value="${w.id}" data-name="${esc(w.name)}">${esc(w.name)}</option>`).join("");
  
  const popup = document.createElement("div");
  popup.id = "newInternalTaskModal";
  popup.className = "modal-mask";
  
  let isDragging = false;
  popup.addEventListener("mousedown", function(e) {
    isDragging = false;
  });
  popup.addEventListener("mousemove", function(e) {
    isDragging = true;
  });
  popup.addEventListener("mouseup", function(e) {
    if (!isDragging && e.target === popup) {
      closeNewInternalTaskModal();
    }
  });
  popup.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:420px;width:95%;max-height:90vh;overflow:hidden;">
      <div class="modal-head">
        <h3>📋 下达内部任务</h3>
        <button class="modal-close" onclick="closeNewInternalTaskModal()">×</button>
      </div>
      <div class="modal-body" style="padding:12px;overflow-y:auto;max-height:calc(90vh - 60px);">
        <div style="margin-bottom:10px;">
          <label style="font-size:12px;font-weight:600;color:#333;">任务名称</label>
          <input class="input" id="newTaskName" placeholder="如：仓库焊架子" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;" />
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">工作类型</label>
            <select class="input" id="newTaskType" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;">
              <option value="仓库工作">仓库工作</option>
              <option value="送货">送货</option>
              <option value="外出安装">外出安装</option>
              <option value="其他">其他</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">工时等级</label>
            <select class="input" id="newTaskLevel" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;">
              <option value="初级">初级</option>
              <option value="中级" selected>中级</option>
              <option value="高级">高级</option>
              <option value="特级">特级</option>
            </select>
          </div>
        </div>
        
        <div style="margin-bottom:10px;">
          <label style="font-size:12px;font-weight:600;color:#333;">分配人员</label>
          <select class="input" id="newTaskWorker" onchange="updateNewTaskWorkerName()" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;">
            <option value="">请选择人员</option>
            ${workerOptions}
          </select>
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">任务日期</label>
            <input class="input" type="date" id="newTaskDate" value="${new Date().toISOString().slice(0,10)}" style="width:100%;margin-top:4px;padding:4px 6px;font-size:12px;" />
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">开始时间</label>
            <select class="input" id="newTaskStartTime" style="width:100%;margin-top:4px;padding:4px 6px;font-size:12px;">
              ${generateTimeOptions("08:00")}
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:#333;">结束时间</label>
            <select class="input" id="newTaskEndTime" style="width:100%;margin-top:4px;padding:4px 6px;font-size:12px;">
              ${generateTimeOptions("10:00")}
            </select>
          </div>
        </div>
        
        <div style="margin-bottom:10px;">
          <label style="font-size:12px;font-weight:600;color:#333;">预计工时(小时)</label>
          <input class="input" type="number" min="0" step="0.1" id="newTaskEstHours" placeholder="0" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;" />
        </div>
        
        <div style="margin-bottom:12px;">
          <label style="font-size:12px;font-weight:600;color:#333;">任务备注</label>
          <textarea class="input" id="newTaskNote" placeholder="选填，如任务具体要求等" rows="2" style="width:100%;margin-top:4px;padding:6px 8px;font-size:13px;"></textarea>
        </div>
        
        <button class="btn primary" onclick="saveNewInternalTask()" style="width:100%;padding:8px;font-size:14px;">下达任务</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

function updateNewTaskWorkerName() {
  const select = document.getElementById("newTaskWorker");
  const option = select.options[select.selectedIndex];
  if (option) {
    select.setAttribute("data-name", option.getAttribute("data-name") || option.text);
  }
}

function saveNewInternalTask() {
  const name = document.getElementById("newTaskName").value.trim();
  const workType = document.getElementById("newTaskType").value;
  const level = document.getElementById("newTaskLevel").value;
  const workerId = document.getElementById("newTaskWorker").value;
  const workerName = document.getElementById("newTaskWorker").getAttribute("data-name") || 
                     document.getElementById("newTaskWorker").options[document.getElementById("newTaskWorker").selectedIndex]?.text || "";
  const date = document.getElementById("newTaskDate").value;
  const scheduledStartTime = document.getElementById("newTaskStartTime").value;
  const scheduledEndTime = document.getElementById("newTaskEndTime").value;
  const estHours = Number(document.getElementById("newTaskEstHours").value);
  const note = document.getElementById("newTaskNote").value.trim();
  
  if (!name) { toast("请输入任务名称"); return; }
  if (!workerId) { toast("请选择分配人员"); return; }
  if (!date) { toast("请选择任务日期"); return; }
  if (!scheduledStartTime) { toast("请选择开始时间"); return; }
  if (!scheduledEndTime) { toast("请选择结束时间"); return; }
  if (!estHours || estHours <= 0) { toast("请输入预计工时"); return; }
  
  addInternalTask({
    name,
    workType,
    level,
    workerId,
    workerName,
    date,
    scheduledStartTime,
    scheduledEndTime,
    estHours,
    note
  });
  
  toast("任务已下达");
  closeNewInternalTaskModal();
  renderInternalTasks();
  updateInternalTaskBadge();
}

function startInternalTask(id) {
  updateInternalTask(id, {
    status: 'in_progress',
    actualStartTime: new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute:'2-digit'}),
    startTimestamp: Date.now()
  });
  toast("任务已开始");
  renderInternalTasks();
  updateInternalTaskBadge();
}

function completeInternalTask(id) {
  const tasks = getInternalTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  
  const actualEndTime = new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute:'2-digit'});
  const endTimestamp = Date.now();
  
  let actualHours = 0;
  if (task.startTimestamp) {
    const diffMs = endTimestamp - task.startTimestamp;
    actualHours = (diffMs / (1000 * 60 * 60)).toFixed(1);
  }
  
  let finalHours = Number(actualHours);
  if (isNaN(finalHours)) {
    finalHours = task.estHours;
  }
  
  updateInternalTask(id, {
    status: 'completed',
    actualEndTime,
    endTimestamp,
    actualHours: finalHours,
    calculatedHours: Number(actualHours)
  });
  
  toast("任务已完成，等待审核");
  renderInternalTasks();
  updateInternalTaskBadge();
}

function showVerifyModal(id) {
  const tasks = getInternalTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  
  const popup = document.createElement("div");
  popup.id = "verifyInternalTaskModal";
  popup.className = "modal-mask";
  
  let isDragging = false;
  popup.addEventListener("mousedown", function(e) {
    isDragging = false;
  });
  popup.addEventListener("mousemove", function(e) {
    isDragging = true;
  });
  popup.addEventListener("mouseup", function(e) {
    if (!isDragging && e.target === popup) {
      closeVerifyModal();
    }
  });
  
  const defaultHours = task.calculatedHours !== undefined ? task.calculatedHours : task.actualHours;
  
  popup.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:480px;width:95%;max-height:90vh;overflow:hidden;">
      <div class="modal-head">
        <h3>✅ 审核任务</h3>
        <button class="modal-close" onclick="closeVerifyModal()">×</button>
      </div>
      <div class="modal-body" style="padding:16px;overflow-y:auto;max-height:calc(90vh - 60px);">
        <div style="margin-bottom:16px;padding:12px;background:#f8f9fa;border-radius:8px;">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px;">${esc(task.name)}</div>
          <div style="font-size:13px;color:#666;line-height:1.6;">
            <div>👤 ${esc(task.workerName)}</div>
            <div>📅 ${esc(task.date)}</div>
            <div>🏷️ ${esc(task.workType)} · ${esc(task.level)}</div>
          </div>
        </div>
        
        <div style="margin-bottom:12px;">
          <label style="font-size:14px;font-weight:bold;color:#333;">⏰ 安排时间</label>
          <div style="font-size:13px;color:#666;margin-top:4px;">${esc(task.scheduledStartTime || '-')} ~ ${esc(task.scheduledEndTime || '-')}</div>
        </div>
        
        <div style="margin-bottom:12px;">
          <label style="font-size:14px;font-weight:bold;color:#333;">⏰ 实际时间</label>
          <div style="font-size:13px;color:#666;margin-top:4px;">${esc(task.actualStartTime || '-')} ~ ${esc(task.actualEndTime || '-')}</div>
        </div>
        
        <div style="margin-bottom:12px;">
          <label style="font-size:14px;font-weight:bold;color:#333;">📊 预计工时</label>
          <div style="font-size:13px;color:#666;margin-top:4px;">${esc(task.estHours)}小时</div>
        </div>
        
        <div style="margin-bottom:16px;">
          <label style="font-size:14px;font-weight:bold;color:#333;">📊 系统自动计算工时</label>
          <div style="font-size:13px;color:#3b82f6;margin-top:4px;">${task.calculatedHours !== undefined ? esc(task.calculatedHours) + '小时' : '未计算'}</div>
        </div>
        
        <div style="margin-bottom:16px;">
          <label style="font-size:14px;font-weight:bold;color:#333;">✏️ 审核确认工时（小时）</label>
          <input class="input" type="number" min="0" step="0.1" id="verifyHours" value="${defaultHours}" style="width:100%;margin-top:6px;" />
        </div>
        
        <div style="margin-bottom:16px;">
          <label style="font-size:14px;font-weight:bold;color:#333;">📝 审核备注</label>
          <textarea class="input" id="verifyNote" placeholder="选填，如审核意见等" rows="2" style="width:100%;margin-top:6px;"></textarea>
        </div>
        
        <div style="display:flex;gap:12px;">
          <button class="btn" onclick="closeVerifyModal()" style="flex:1;">取消</button>
          <button class="btn primary" onclick="doVerifyInternalTask('${task.id}')" style="flex:1;">审核通过</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

function closeVerifyModal() {
  const mask = document.getElementById("verifyInternalTaskModal");
  if (mask) mask.remove();
}

function doVerifyInternalTask(id) {
  const verifyHours = Number(document.getElementById("verifyHours").value);
  const verifyNote = document.getElementById("verifyNote").value.trim();
  
  if (!verifyHours || verifyHours <= 0) {
    toast("请输入有效的工时");
    return;
  }
  
  const tasks = getInternalTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  
  updateInternalTask(id, {
    status: 'verified',
    verifiedAt: new Date().toLocaleString('zh-CN'),
    actualHours: verifyHours,
    verifyNote: verifyNote
  });
  
  addInternalWorkLog({
    workerId: task.workerId,
    workerName: task.workerName,
    workType: task.workType,
    date: task.date,
    startTime: task.actualStartTime || task.scheduledStartTime || '-',
    endTime: task.actualEndTime || '-',
    hours: verifyHours,
    level: task.level,
    note: verifyNote ? `审核备注: ${verifyNote}${task.note ? ' | ' + task.note : ''}` : (task.note || '')
  });
  
  closeVerifyModal();
  toast("审核通过，工时已计入内部工时统计");
  renderInternalTasks();
  renderStats();
  updateInternalTaskBadge();
}

function renderInternalTasks() {
  const container = document.getElementById("internalTaskList");
  if (!container) return;
  
  const tasks = getInternalTasks();
  const statusFilter = document.getElementById("internalTaskStatusFilter")?.value || "";
  const workerFilter = document.getElementById("internalTaskWorkerFilter")?.value || "";
  const typeFilter = document.getElementById("internalTaskTypeFilter")?.value || "";
  const dateFilter = document.getElementById("internalTaskDateFilter")?.value || "3days";
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const filtered = tasks.filter(t => {
    if (statusFilter && t.status !== statusFilter) return false;
    if (workerFilter && t.workerId !== workerFilter) return false;
    if (typeFilter && t.workType !== typeFilter) return false;
    
    if (dateFilter === "3days") {
      if (t.status === 'pending' || t.status === 'in_progress') return true;
      const taskDate = new Date(t.date);
      taskDate.setHours(0, 0, 0, 0);
      const diffDays = (taskDate - today) / (1000 * 60 * 60 * 24);
      return diffDays >= -2 && diffDays <= 0;
    } else if (dateFilter === "7days") {
      if (t.status === 'pending' || t.status === 'in_progress') return true;
      const taskDate = new Date(t.date);
      taskDate.setHours(0, 0, 0, 0);
      const diffDays = (taskDate - today) / (1000 * 60 * 60 * 24);
      return diffDays >= -6 && diffDays <= 0;
    }
    
    return true;
  }).sort((a, b) => {
    const statusOrder = { pending: 0, in_progress: 1, completed: 2, verified: 3 };
    if (statusOrder[a.status] !== statusOrder[b.status]) {
      return statusOrder[a.status] - statusOrder[b.status];
    }
    return new Date(b.date) - new Date(a.date);
  });
  
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty">暂无内部任务</div>';
    return;
  }
  
  container.innerHTML = filtered.map(t => {
    const statusText = { pending: '待开始', in_progress: '进行中', completed: '待审核', verified: '已审核' };
    const statusColor = { pending: '#6b7280', in_progress: '#3b82f6', completed: '#f59e0b', verified: '#10b981' };
    
    let actionButtons = '';
    if (t.status === 'pending') {
      actionButtons = `<button class="btn primary" onclick="startInternalTask('${t.id}')">任务开始</button>`;
    } else if (t.status === 'in_progress') {
      actionButtons = `<button class="btn success" onclick="completeInternalTask('${t.id}')">任务完成</button>`;
    } else if (t.status === 'completed') {
      actionButtons = isManager() ? `<button class="btn primary" onclick="showVerifyModal('${t.id}')">审核</button>` : '';
    }
    
    const timeInfo = t.status === 'pending' && t.scheduledStartTime && t.scheduledEndTime
      ? `<div style="margin-top:6px;padding:6px;background:#fef3c7;border-radius:4px;">
           <div style="font-size:11px;color:#666;">📅 安排: <b>${t.scheduledStartTime} ~ ${t.scheduledEndTime}</b></div>
         </div>`
      : t.status === 'in_progress' 
        ? `<div style="margin-top:6px;padding:6px;background:#eff6ff;border-radius:4px;">
             <div style="font-size:11px;color:#666;">📅 安排: <b>${t.scheduledStartTime || '-'} ~ ${t.scheduledEndTime || '-'}</b></div>
             <div style="font-size:11px;color:#666;margin-top:1px;">⏰ 实际开始: <b>${t.actualStartTime || '-'}</b></div>
           </div>`
        : t.status === 'completed'
          ? `<div style="margin-top:6px;padding:6px;background:#fef3c7;border-radius:4px;">
               <div style="font-size:11px;color:#666;">📅 安排: <b>${t.scheduledStartTime || '-'} ~ ${t.scheduledEndTime || '-'}</b></div>
               <div style="font-size:11px;color:#666;margin-top:1px;">⏰ 实际: <b>${t.actualStartTime || '-'} ~ ${t.actualEndTime || '-'}</b></div>
               <div style="font-size:11px;color:#666;margin-top:1px;">📊 预计: ${t.estHours}h / 记录: <b>${t.calculatedHours !== undefined ? t.calculatedHours : (t.actualHours || t.estHours)}h</b></div>
               <div style="font-size:11px;color:#f59e0b;margin-top:1px;">⚠️ 等待审核</div>
             </div>`
          : t.status === 'verified'
            ? `<div style="margin-top:6px;padding:6px;background:#ecfdf5;border-radius:4px;">
                 <div style="font-size:11px;color:#666;">📅 安排: <b>${t.scheduledStartTime || '-'} ~ ${t.scheduledEndTime || '-'}</b></div>
                 <div style="font-size:11px;color:#666;margin-top:1px;">⏰ 实际: <b>${t.actualStartTime || '-'} ~ ${t.actualEndTime || '-'}</b></div>
                 <div style="font-size:11px;color:#666;margin-top:1px;">📊 预计: ${t.estHours}h / 记录: <b>${t.calculatedHours !== undefined ? t.calculatedHours : (t.actualHours || t.estHours)}h</b></div>
                 <div style="font-size:11px;color:#10b981;margin-top:1px;">✅ 已审核</div>
                 ${t.verifyNote ? `<div style="font-size:11px;color:#666;margin-top:1px;">📝 ${esc(t.verifyNote)}</div>` : ''}
               </div>`
            : '';
    
    return `
      <div class="card internal-task-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <div>
            <h3 style="font-size:15px;font-weight:600;margin-bottom:2px;">${esc(t.name)}</h3>
            <div style="font-size:12px;color:#666;">${esc(t.workType)} · ${esc(t.level)}</div>
          </div>
          <span style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${statusColor[t.status]}15;color:${statusColor[t.status]};">
            ${statusText[t.status]}
          </span>
        </div>
        
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;font-size:12px;">
          <div><span style="color:#888;">👤</span> ${esc(t.workerName)}</div>
          <div><span style="color:#888;">📅</span> ${esc(t.date)}</div>
          <div><span style="color:#888;">⏱️</span> 预计 ${esc(t.estHours)}h</div>
        </div>
        
        ${t.note ? `<div style="font-size:12px;color:#666;margin-bottom:8px;padding:6px;background:#f8f9fa;border-radius:4px;">📝 ${esc(t.note)}</div>` : ''}
        
        ${timeInfo}
        
        ${actionButtons}
        
        ${isManager() ? `<button class="btn tiny" style="margin-top:6px;color:#ef4444;border-color:#fecaca;" onclick="deleteInternalTask('${t.id}')">删除</button>` : ''}
      </div>
    `;
  }).join("");
}

let internalTasksInitialized = false;
function initInternalTasks() {
  try {
    const workerSelect = document.getElementById("internalTaskWorkerFilter");
    if (workerSelect) {
      workerSelect.innerHTML = '<option value="">全部人员</option>' + 
        cache.workers.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join("");
    }
    
    if (!internalTasksInitialized) {
      const btn = document.getElementById("btnNewInternalTask");
      if (btn) {
        btn.addEventListener("click", showNewInternalTaskModal);
      }
      internalTasksInitialized = true;
    }
    renderInternalTasks();
  } catch (e) {
    console.error("Error initializing internal tasks:", e);
  }
}

function exportStats() {
  const rows = collectStats();
  const projRows = collectProjectStats();
  if (rows.length === 0 && projRows.length === 0) { toast("暂无数据可导出"); return; }
  const period = document.getElementById("statsPeriod").value;
  const month = document.getElementById("statsMonth").value || "全部";
  const wageConfig = getWageConfig();

  const totalHours = rows.reduce((s, r) => s + r.hours, 0);
  const totalLevelHours = {初级: 0, 中级: 0, 高级: 0, 特级: 0};
  rows.forEach(r => {
    totalLevelHours.初级 += r.levelHours?.初级 || 0;
    totalLevelHours.中级 += r.levelHours?.中级 || 0;
    totalLevelHours.高级 += r.levelHours?.高级 || 0;
    totalLevelHours.特级 += r.levelHours?.特级 || 0;
  });
  const totalOutsourcedHours = rows.filter(r => r.isOutsourced).reduce((s, r) => s + r.hours, 0);
  const totalOutsourcedWorkers = rows.filter(r => r.isOutsourced).length;
  const totalWorkers = rows.length - totalOutsourcedWorkers;
  const avgHours = totalWorkers > 0 ? Math.round(totalHours / totalWorkers * 10) / 10 : 0;
  const projRecorded = projRows.filter(r => r.hasActual);
  const totalEst = projRecorded.reduce((s, r) => s + r.est, 0);
  const totalAct = projRecorded.reduce((s, r) => s + r.act, 0);
  const totalDiff = totalAct - totalEst;

  const internalRows = rows.filter(r => !r.isOutsourced);
  const lowEfficiencyWorkers = internalRows.filter(r => r.hours > 0 && r.days > 0 && (r.hours / r.days) < 4);
  const highWorkloadWorkers = internalRows.filter(r => r.hours > 40);
  const topWorkerRow = internalRows.length > 0 ? internalRows.reduce((prev, curr) => (prev.hours > curr.hours ? prev : curr), internalRows[0]) : null;
  const topWorker = topWorkerRow ? topWorkerRow.name : "";
  const topHours = topWorkerRow ? topWorkerRow.hours : 0;

  function isInPeriod(dateStr) {
    if (!month) return true;
    const [year, m] = month.split("-").map(Number);
    if (period === "month") {
      return monthKey(dateStr) === month;
    } else if (period === "quarter") {
      const quarter = Math.ceil(m / 3);
      const [logYear, logMonth] = monthKey(dateStr).split("-").map(Number);
      const logQuarter = Math.ceil(logMonth / 3);
      return logYear === year && logQuarter === quarter;
    } else if (period === "year") {
      return dateStr.startsWith(year + "-");
    }
    return true;
  }

  const titleStyle = { font: { bold: true, size: 14, color: { argb: 'FF1F2937' } }, alignment: { horizontal: 'center' } };
  const infoStyle = { font: { size: 11 }, alignment: { vertical: 'middle' } };
  const sectionTitleStyle = { font: { bold: true, size: 12, color: { argb: 'FF4F46E5' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };
  const headerStyle = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } }, alignment: { horizontal: 'center', vertical: 'middle' }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };
  const totalStyle = { font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }, alignment: { horizontal: 'center', vertical: 'middle' }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };
  const dataStyle = { alignment: { vertical: 'middle' }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };
  const numStyle = { alignment: { horizontal: 'right', vertical: 'middle' }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };
  const leaveStyle = { font: { color: { argb: 'FFFF0000' } }, alignment: { vertical: 'middle' }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };
  const highlightStyle = { font: { bold: true, color: { argb: 'FFDC2626' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }, alignment: { horizontal: 'right', vertical: 'middle' }, border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } };

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '广告施工预约系统';
  workbook.lastModifiedBy = '系统';
  workbook.created = new Date();
  workbook.modified = new Date();

  const summaryData = [
    ['统计项', '数值'],
    ['统计周期', month],
    ['统计类型', period === 'month' ? '月度' : period === 'quarter' ? '季度' : '年度'],
    ['', ''],
    ['施工人员总数', rows.length],
    ['内部人员', totalWorkers],
    ['外协人员', totalOutsourcedWorkers],
    ['总工时(小时)', totalHours],
    ['人均工时(小时)', avgHours],
    ['', ''],
    ['初级工时', totalLevelHours.初级],
    ['中级工时', totalLevelHours.中级],
    ['高级工时', totalLevelHours.高级],
    ['特级工时', totalLevelHours.特级],
    ['外协工时', totalOutsourcedHours + 'h'],
    ['', ''],
    ['预计工时(小时)', totalEst],
    ['实际工时(小时)', totalAct],
    ['工时差异', (totalDiff >= 0 ? '+' : '') + totalDiff],
    ['', ''],
    ['高负荷预警', highWorkloadWorkers.length > 0 ? highWorkloadWorkers.map(w => w.name).join("、") : '无'],
    ['效率建议', lowEfficiencyWorkers.length > 0 ? lowEfficiencyWorkers.map(w => w.name).join("、") : '无'],
    ['本月之星', topWorker && topHours > 0 ? topWorker + ' (' + topHours + '小时)' : '无']
  ];
  const summarySheet = workbook.addWorksheet("统计概览");
  summaryData.forEach((row, rowIndex) => {
    const excelRow = summarySheet.addRow(row);
    row.forEach((cell, colIndex) => {
      const excelCell = excelRow.getCell(colIndex + 1);
      if (rowIndex === 0) {
        excelCell.style = { ...headerStyle };
      } else if (rowIndex === summaryData.length - 1 && row[0] === '合计') {
        excelCell.style = { ...totalStyle };
      } else {
        excelCell.style = typeof cell === 'number' ? { ...numStyle } : { ...dataStyle };
      }
    });
  });
  summarySheet.columns = [{ key: 'A', width: 15 }, { key: 'B', width: 25 }];

  const workerData = [['施工人员', '类型', '工时(小时)', 'vs平均', '初级工时', '中级工时', '高级工时', '特级工时', '施工天数', '请假天数', '参与项目数']];
  rows.forEach((r) => {
    const vsAvg = r.isOutsourced ? "" : ((r.hours - avgHours) >= 0 ? "+" : "") + (r.hours - avgHours).toFixed(1);
    workerData.push([
      r.name,
      r.isOutsourced ? '外协' : '内部',
      r.hours,
      vsAvg,
      r.levelHours?.初级 || 0,
      r.levelHours?.中级 || 0,
      r.levelHours?.高级 || 0,
      r.levelHours?.特级 || 0,
      r.days,
      r.leaveDays || 0,
      r.projects
    ]);
  });
  workerData.push(['合计', '', totalHours, '', totalLevelHours.初级, totalLevelHours.中级, totalLevelHours.高级, totalLevelHours.特级, '', '', '']);
  const workerSheet = workbook.addWorksheet("人员安装工时");
  workerData.forEach((row, rowIndex) => {
    const excelRow = workerSheet.addRow(row);
    row.forEach((cell, colIndex) => {
      const excelCell = excelRow.getCell(colIndex + 1);
      if (rowIndex === 0) {
        excelCell.style = { ...headerStyle };
      } else if (rowIndex === workerData.length - 1 && row[0] === '合计') {
        excelCell.style = { ...totalStyle };
      } else {
        excelCell.style = typeof cell === 'number' ? { ...numStyle } : { ...dataStyle };
      }
    });
  });
  workerSheet.columns = [{ key: 'A', width: 12 }, { key: 'B', width: 8 }, { key: 'C', width: 12 }, { key: 'D', width: 10 }, { key: 'E', width: 10 }, { key: 'F', width: 10 }, { key: 'G', width: 10 }, { key: 'H', width: 10 }, { key: 'I', width: 10 }, { key: 'J', width: 10 }, { key: 'K', width: 12 }];

  const dailyData = [['施工人员', '类型', '日期', '工时(小时)', '工时等级', '项目/工作类型', '是否请假']];
  rows.forEach((r) => {
    Object.entries(r.daily).sort(([a], [b]) => a.localeCompare(b)).forEach(([date, logs]) => {
      const isLeave = r.leaveRecords && r.leaveRecords.some((lr) => date >= lr.startDate && date <= lr.endDate);
      logs.forEach((log) => {
        dailyData.push([r.name, r.isOutsourced ? '外协' : '内部', date, log.hours, log.level, log.project || '', isLeave ? '是' : '']);
      });
    });
  });
  const dailySheet = workbook.addWorksheet("每日工时明细");
  dailyData.forEach((row, rowIndex) => {
    const excelRow = dailySheet.addRow(row);
    row.forEach((cell, colIndex) => {
      const excelCell = excelRow.getCell(colIndex + 1);
      if (rowIndex === 0) {
        excelCell.style = { ...headerStyle };
      } else {
        excelCell.style = typeof cell === 'number' ? { ...numStyle } : { ...dataStyle };
      }
    });
  });
  dailySheet.columns = [{ key: 'A', width: 12 }, { key: 'B', width: 8 }, { key: 'C', width: 12 }, { key: 'D', width: 12 }, { key: 'E', width: 10 }, { key: 'F', width: 20 }, { key: 'G', width: 10 }];

  const hasLeaves = rows.some((r) => r.leaveRecords && r.leaveRecords.length > 0);
  if (hasLeaves) {
    const leaveData = [['施工人员', '类型', '请假时段', '请假原因']];
    rows.forEach((r) => {
      if (!r.leaveRecords || r.leaveRecords.length === 0) return;
      r.leaveRecords.forEach((lr) => {
        leaveData.push([r.name, r.isOutsourced ? '外协' : '内部', formatLeaveTime(lr), lr.reason || '']);
      });
    });
    const leaveSheet = workbook.addWorksheet("请假记录");
    leaveData.forEach((row, rowIndex) => {
      const excelRow = leaveSheet.addRow(row);
      row.forEach((cell, colIndex) => {
        const excelCell = excelRow.getCell(colIndex + 1);
        if (rowIndex === 0) {
          excelCell.style = { ...headerStyle };
        } else {
          excelCell.style = { ...dataStyle };
        }
      });
    });
    leaveSheet.columns = [{ key: 'A', width: 12 }, { key: 'B', width: 8 }, { key: 'C', width: 20 }, { key: 'D', width: 25 }];
  }

  const projectData = [['日期', '预约开工时间', '实际开工时间', '店面', '项目', '状态', '预计工时', '实际工时', '差异', '初级', '中级', '高级', '特级', '施工人员工时', '外协人数', '系统自动工时', '工时备注']];
  projRows.forEach((r) => {
    const internalWorkers = r.workerHours.map((w) => w.name + ' ' + w.hours + 'h').join('、');
    const outsourcedWorkers = r.outsourcedWorkerHours.map((w) => w.name + ' ' + w.hours + 'h').join('、');
    const workerText = (internalWorkers || '') + (internalWorkers && outsourcedWorkers ? '、' : '') + (outsourcedWorkers || '');
    const outsourcedCount = r.outsourcedWorkerHours.length;
    const autoWorkerText = (r.autoWorkerHours || []).map((w) => w.name + ' ' + w.hours + 'h').join('、');
    projectData.push([
      r.date ? fmtDate(r.date) : '',
      r.appointmentTime ? fmtTime(r.appointmentTime) : '',
      r.startedAt ? fmtTime(r.startedAt) : '',
      r.store || '',
      r.name,
      r.status,
      r.est,
      r.hasActual ? r.act : '',
      r.hasActual ? (r.diff >= 0 ? '+' : '') + r.diff : '未登记',
      r.levelHours?.初级 || 0,
      r.levelHours?.中级 || 0,
      r.levelHours?.高级 || 0,
      r.levelHours?.特级 || 0,
      workerText,
      outsourcedCount > 0 ? outsourcedCount + '人' : '',
      autoWorkerText,
      r.notes || ''
    ]);
  });
  projectData.push(['', '', '', '', '', '合计', totalEst, totalAct, (totalDiff >= 0 ? '+' : '') + totalDiff,
    projRows.reduce((s, r) => s + (r.levelHours?.初级 || 0), 0),
    projRows.reduce((s, r) => s + (r.levelHours?.中级 || 0), 0),
    projRows.reduce((s, r) => s + (r.levelHours?.高级 || 0), 0),
    projRows.reduce((s, r) => s + (r.levelHours?.特级 || 0), 0),
    '', '', projRows.reduce((s, r) => s + (r.autoHours || 0), 0), '']);
  const projectSheet = workbook.addWorksheet("项目工时差异");
  projectData.forEach((row, rowIndex) => {
    const excelRow = projectSheet.addRow(row);
    row.forEach((cell, colIndex) => {
      const excelCell = excelRow.getCell(colIndex + 1);
      if (rowIndex === 0) {
        excelCell.style = { ...headerStyle };
      } else if (rowIndex === projectData.length - 1 && row[0] === '') {
        excelCell.style = { ...totalStyle };
      } else {
        excelCell.style = typeof cell === 'number' ? { ...numStyle } : { ...dataStyle };
      }
    });
  });
  projectSheet.columns = [{ key: 'A', width: 10 }, { key: 'B', width: 12 }, { key: 'C', width: 12 }, { key: 'D', width: 12 }, { key: 'E', width: 25 }, { key: 'F', width: 10 }, { key: 'G', width: 10 }, { key: 'H', width: 10 }, { key: 'I', width: 10 }, { key: 'J', width: 8 }, { key: 'K', width: 8 }, { key: 'L', width: 8 }, { key: 'M', width: 8 }, { key: 'N', width: 25 }, { key: 'O', width: 10 }, { key: 'P', width: 15 }, { key: 'Q', width: 30 }];

  const usedNames = {};
  rows.forEach((r) => {
    let workerName = r.name.replace(/[\\/\?\*\[\]:]/g, '_');
    if (workerName.length > 20) workerName = workerName.substring(0, 20);
    if (usedNames[workerName]) {
      workerName += '_' + (++usedNames[workerName]);
    } else {
      usedNames[workerName] = 1;
    }
    const sheetName = workerName;
    
    const sheet = workbook.addWorksheet(sheetName);
    let rowNum = 1;
    
    sheet.addRow(['施工人员工时统计与工资核算表']);
    sheet.getRow(rowNum).getCell(1).style = { ...titleStyle };
    sheet.mergeCells(`A${rowNum}:I${rowNum}`);
    rowNum++;
    
    rowNum++;
    
    sheet.addRow(['姓名', r.name, '', '类型', r.isOutsourced ? '外协人员' : '内部人员', '', '统计周期', month]);
    sheet.getRow(rowNum).eachCell(cell => cell.style = { ...infoStyle });
    rowNum++;
    
    sheet.addRow(['总工时', (r.hours || 0), '小时', '施工天数', (r.days || 0), '天', '请假天数', (r.leaveDays || 0), '天']);
    sheet.getRow(rowNum).eachCell((cell, ci) => {
      cell.style = ci === 1 || ci === 4 || ci === 7 ? { ...numStyle } : { ...infoStyle };
    });
    rowNum++;
    
    rowNum++;
    
    sheet.addRow(['工时等级统计']);
    sheet.getRow(rowNum).getCell(1).style = { ...sectionTitleStyle };
    sheet.mergeCells(`A${rowNum}:I${rowNum}`);
    rowNum++;
    
    sheet.addRow(['等级', '工时(小时)', '占比', '单价(元/小时)', '金额(元)']);
    sheet.getRow(rowNum).eachCell(cell => cell.style = { ...headerStyle });
    rowNum++;
    
    const levels = ['初级', '中级', '高级', '特级'];
    const levelRowNums = [];
    levels.forEach((level, idx) => {
      const hours = r.levelHours?.[level] || 0;
      const percentage = r.hours > 0 ? ((hours / r.hours) * 100).toFixed(1) + '%' : '0%';
      const price = wageConfig[level] || 0;
      levelRowNums.push(rowNum);
      sheet.addRow([level, hours, percentage, price, '']);
      const amountCell = sheet.getRow(rowNum).getCell(5);
      amountCell.value = { formula: `=B${rowNum}*D${rowNum}`, result: hours * price };
      amountCell.style = { ...numStyle };
      sheet.getRow(rowNum).eachCell((cell, ci) => {
        if (ci === 4) return;
        cell.style = ci === 1 || ci === 3 || ci === 4 ? { ...numStyle } : { ...dataStyle };
      });
      rowNum++;
    });
    
    const totalAmount = levels.reduce((sum, level) => sum + (r.levelHours?.[level] || 0) * (wageConfig[level] || 0), 0);
    sheet.addRow(['合计', '', '', '', '']);
    const totalCell = sheet.getRow(rowNum).getCell(5);
    totalCell.value = { formula: `=SUM(E${levelRowNums[0]}:E${levelRowNums[levelRowNums.length-1]})`, result: totalAmount };
    totalCell.style = { ...highlightStyle };
    sheet.getRow(rowNum).eachCell((cell, ci) => {
      if (ci === 4) return;
      cell.style = { ...totalStyle };
    });
    rowNum++;
    const totalAmountRowNum = rowNum - 1;
    
    rowNum++;
    
    const calTitleRow = sheet.addRow(['每日工时日历']);
    calTitleRow.getCell(1).style = { ...sectionTitleStyle };
    sheet.mergeCells(`A${rowNum}:I${rowNum}`);
    rowNum++;
    
    sheet.addRow(['日期', '星期', '初级工时', '中级工时', '高级工时', '特级工时', '合计工时', '项目', '请假']);
    sheet.getRow(rowNum).eachCell(cell => cell.style = { ...headerStyle });
    rowNum++;
    
    const dates = [];
    const hoursMap = {};
    const leaveMap = {};
    const projectMap = {};
    const levelHoursMap = {初级: {}, 中级: {}, 高级: {}, 特级: {}};
    
    if (month) {
      const [year, m] = month.split("-").map(Number);
      const daysInMonth = new Date(year, m, 0).getDate();
      for (let i = 1; i <= daysInMonth; i++) {
        const dateStr = `${year}-${String(m).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
        if (isInPeriod(dateStr)) {
          dates.push(dateStr);
          hoursMap[dateStr] = 0;
          projectMap[dateStr] = '';
          levels.forEach(l => levelHoursMap[l][dateStr] = 0);
        }
      }
    } else {
      Object.keys(r.daily).forEach(date => {
        dates.push(date);
        hoursMap[date] = 0;
        projectMap[date] = '';
        levels.forEach(l => levelHoursMap[l][date] = 0);
      });
      dates.sort();
    }
    
    Object.entries(r.daily).forEach(([date, logs]) => {
      if (!hoursMap[date]) hoursMap[date] = 0;
      logs.forEach(log => {
        hoursMap[date] += log.hours;
        levelHoursMap[log.level][date] += log.hours;
        projectMap[date] += (projectMap[date] ? '、' : '') + (log.project || '');
      });
    });
    
    if (r.leaveRecords) {
      r.leaveRecords.forEach(lr => {
        const start = new Date(lr.startDate);
        const end = new Date(lr.endDate);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dateStr = fmtDate(d);
          leaveMap[dateStr] = lr.reason || '请假';
        }
      });
    }
    
    let calTotalHours = 0;
    const calLevelTotals = {初级: 0, 中级: 0, 高级: 0, 特级: 0};
    dates.forEach(date => {
      const d = new Date(date);
      const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
      const weekDay = weekDays[d.getDay()];
      const hours = hoursMap[date] || 0;
      calTotalHours += hours;
      levels.forEach(l => calLevelTotals[l] += levelHoursMap[l][date] || 0);
      const isLeaveDay = !!leaveMap[date];
      sheet.addRow([date, weekDay, levelHoursMap.初级[date] || 0, levelHoursMap.中级[date] || 0, levelHoursMap.高级[date] || 0, levelHoursMap.特级[date] || 0, hours, projectMap[date] || '', isLeaveDay ? leaveMap[date] : '']);
      sheet.getRow(rowNum).eachCell((cell, ci) => {
        if (isLeaveDay && ci === 8) {
          cell.style = { ...leaveStyle };
        } else if (ci >= 2 && ci <= 6) {
          cell.style = { ...numStyle };
        } else {
          cell.style = { ...dataStyle };
        }
      });
      rowNum++;
    });
    
    sheet.addRow(['合计', '', calLevelTotals.初级, calLevelTotals.中级, calLevelTotals.高级, calLevelTotals.特级, calTotalHours, '', '']);
    sheet.getRow(rowNum).eachCell((cell, ci) => {
      cell.style = ci >= 2 && ci <= 6 ? { ...highlightStyle } : { ...totalStyle };
    });
    rowNum++;
    
    rowNum++;
    
    if (r.leaveRecords && r.leaveRecords.length > 0) {
      sheet.addRow(['请假记录']);
      sheet.getRow(rowNum).getCell(1).style = { ...sectionTitleStyle };
      sheet.mergeCells(`A${rowNum}:I${rowNum}`);
      rowNum++;
      
      sheet.addRow(['序号', '开始日期', '结束日期', '请假天数', '请假原因', '', '', '', '']);
      sheet.getRow(rowNum).eachCell(cell => cell.style = { ...headerStyle });
      rowNum++;
      
      r.leaveRecords.forEach((lr, idx) => {
        const start = new Date(lr.startDate);
        const end = new Date(lr.endDate);
        const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
        sheet.addRow([idx + 1, lr.startDate, lr.endDate, days, lr.reason || '', '', '', '', '']);
        sheet.getRow(rowNum).eachCell((cell, ci) => {
          cell.style = ci === 3 ? { ...numStyle } : { ...dataStyle };
        });
        rowNum++;
      });
      
      rowNum++;
    }
    
    sheet.addRow(['工资核算']);
    sheet.getRow(rowNum).getCell(1).style = { ...sectionTitleStyle };
    sheet.mergeCells(`A${rowNum}:I${rowNum}`);
    rowNum++;
    
    sheet.addRow(['项目', '金额(元)', '', '计算公式']);
    sheet.getRow(rowNum).eachCell(cell => cell.style = { ...headerStyle });
    rowNum++;
    
    const wageRowNum = rowNum;
    sheet.addRow(['工时工资合计', '', '', '各等级工时 x 对应单价之和']);
    const wageCell = sheet.getRow(rowNum).getCell(2);
    wageCell.value = { formula: `=E${totalAmountRowNum}`, result: totalAmount };
    wageCell.style = { ...numStyle };
    sheet.getRow(rowNum).eachCell((cell, ci) => {
      if (ci === 1) return;
      cell.style = { ...dataStyle };
    });
    rowNum++;
    
    sheet.addRow(['其他补贴', '', '', '']);
    sheet.getRow(rowNum).eachCell(cell => cell.style = { ...dataStyle });
    rowNum++;
    
    const grossRowNum = rowNum;
    sheet.addRow(['应发工资合计', '', '', '工时工资 + 其他补贴']);
    const grossCell = sheet.getRow(rowNum).getCell(2);
    grossCell.value = { formula: `=B${wageRowNum}+B${rowNum - 1}`, result: totalAmount };
    grossCell.style = { ...highlightStyle };
    sheet.getRow(rowNum).eachCell((cell, ci) => {
      if (ci === 1) return;
      cell.style = { ...totalStyle };
    });
    rowNum++;
    
    sheet.addRow(['扣款/其他', '', '', '']);
    sheet.getRow(rowNum).eachCell(cell => cell.style = { ...dataStyle });
    rowNum++;
    
    sheet.addRow(['实发工资', '', '', '应发工资 - 扣款']);
    const netCell = sheet.getRow(rowNum).getCell(2);
    netCell.value = { formula: `=B${grossRowNum}-B${rowNum - 1}`, result: totalAmount };
    netCell.style = { ...highlightStyle };
    sheet.getRow(rowNum).eachCell((cell, ci) => {
      cell.style = ci === 1 ? { ...highlightStyle } : { ...totalStyle };
    });
    rowNum++;
    
    sheet.columns = [
      { key: 'A', width: 15 }, { key: 'B', width: 12 }, { key: 'C', width: 5 }, { key: 'D', width: 12 },
      { key: 'E', width: 12 }, { key: 'F', width: 8 }, { key: 'G', width: 8 }, { key: 'H', width: 30 }, { key: 'I', width: 15 }
    ];
  });

  workbook.xlsx.writeBuffer().then(buffer => {
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '工时统计_' + month + '.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 Excel');
  }).catch(err => {
    console.error('Export error:', err);
    toast('导出失败，请重试');
  });
}

/* ============================================================
 * 店面预约统计（总经理）
 * ============================================================ */
function collectStoreStats() {
  const month = document.getElementById("storeStatsMonth").value;
  const buckets = {};
  const ensure = (id) => {
    if (!buckets[id]) {
      buckets[id] = {
        id, name: id ? storeName(id) : "未指定门店",
        count: 0, byStatus: {}, recordedEst: 0, act: 0, recordedDiff: 0,
      };
    }
    return buckets[id];
  };
  cache.stores.forEach((s) => ensure(s.id));
  ensure("");
  cache.projects
    .filter((p) => !month || monthKey(p.appointmentTime) === month)
    .forEach((p) => {
      const b = ensure(p.storeId || "");
      b.count++;
      b.byStatus[p.status] = (b.byStatus[p.status] || 0) + 1;
      const { est, act, diff, hasActual } = hoursDiff(p);
      if (hasActual) { b.recordedEst += est; b.act += act; b.recordedDiff += diff; }
    });
  return Object.values(buckets).sort((a, b) => b.count - a.count);
}

function renderStoreStats() {
  const box = document.getElementById("storeStatsTable");
  if (!box) return;
  const rows = collectStoreStats();
  if (rows.length === 0) { box.innerHTML = `<div class="empty">暂无门店数据。</div>`; return; }
  const statuses = Object.values(STATUS);
  const tot = { count: 0, est: 0, act: 0, diff: 0, byStatus: {} };
  rows.forEach((r) => {
    tot.count += r.count; tot.est += r.recordedEst; tot.act += r.act; tot.diff += r.recordedDiff;
    statuses.forEach((s) => { tot.byStatus[s] = (tot.byStatus[s] || 0) + (r.byStatus[s] || 0); });
  });
  box.innerHTML = `
    <div class="detail-block" style="padding:0;overflow:hidden">
      <table class="data">
        <thead>
          <tr><th>门店</th><th>预约数</th>${statuses.map((s) => `<th>${s}</th>`).join("")}<th>预计工时</th><th>实际工时</th><th>差异</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.name)}</td>
              <td><b>${r.count}</b></td>
              ${statuses.map((s) => `<td>${r.byStatus[s] || 0}</td>`).join("")}
              <td>${r.recordedEst}</td>
              <td>${r.act}</td>
              <td style="color:${diffColor(r.recordedDiff)};font-weight:600">${fmtSignedDiff(r.recordedDiff)}</td>
            </tr>`).join("")}
        </tbody>
        <tfoot>
          <tr><td>合计</td><td>${tot.count}</td>${statuses.map((s) => `<td>${tot.byStatus[s] || 0}</td>`).join("")}<td>${tot.est}</td><td>${tot.act}</td><td style="color:${diffColor(tot.diff)};font-weight:600">${fmtSignedDiff(tot.diff)}</td></tr>
        </tfoot>
      </table>
    </div>`;
}

function exportStoreStats() {
  const rows = collectStoreStats();
  if (rows.length === 0) { toast("暂无数据可导出"); return; }
  const month = document.getElementById("storeStatsMonth").value || "全部";
  const statuses = Object.values(STATUS);
  const header = ["门店", "预约数", ...statuses, "合计预计(已登记)", "合计实际(已登记)", "差异(实际-预计)"];
  const lines = [header.join(",")].concat(rows.map((r) => [
    `"${String(r.name).replace(/"/g, '""')}"`,
    r.count,
    ...statuses.map((s) => r.byStatus[s] || 0),
    r.recordedEst,
    r.act,
    fmtSignedDiff(r.recordedDiff),
  ].join(",")));
  const csv = "\ufeff" + lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `店面统计_${month}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出 CSV");
}

/* ============================================================
 * 门店管理（总经理）
 * ============================================================ */
function renderStores() {
  const list = document.getElementById("storeList");
  if (!list) return;
  if (cache.stores.length === 0) {
    list.innerHTML = `<div class="empty">暂无门店，点击右上角「添加门店」创建。</div>`;
    return;
  }
  list.innerHTML = cache.stores.map((s) => {
    const projCount = cache.projects.filter((p) => p.storeId === s.id).length;
    return `
      <div class="card">
        <div class="card-title"><h3>${esc(s.name)}</h3></div>
        <div class="card-row"><span>关联预约</span><b>${projCount} 个</b></div>
        <div class="card-actions">
          <button class="btn small" onclick="editStore('${s.id}')">编辑</button>
          <button class="btn small danger" onclick="removeStore('${s.id}')">删除</button>
        </div>
      </div>`;
  }).join("");
}

function storeForm(s = {}) {
  return `
    <div class="form-row">
      <label>门店名称 *</label>
      <input class="input" id="sName" value="${esc(s.name || "")}" placeholder="如：北京朝阳店" />
    </div>
    <div class="form-row">
      <label>门店电话</label>
      <input class="input" id="sPhone" value="${esc(s.phone || "")}" placeholder="如：13800138000" />
    </div>
    <div class="form-actions">
      <button class="btn" onclick="modal.close()">取消</button>
      <button class="btn primary" onclick="saveStoreForm('${s.id || ""}')">保存</button>
    </div>`;
}

function newStore() { modal.open("添加门店", storeForm()); }
function editStore(id) { modal.open("编辑门店", storeForm(getStore(id))); }

async function saveStoreForm(id) {
  const name = document.getElementById("sName").value.trim();
  const phone = document.getElementById("sPhone").value.trim();
  if (!name) { toast("请填写门店名称"); return; }
  await repo.saveStore({ name, phone }, id);
  await repo.loadAll();
  modal.close();
  renderAll();
  toast("已保存");
}

async function removeStore(id) {
  const used = cache.projects.some((p) => p.storeId === id);
  const msg = used
    ? "该门店下已有预约，删除后这些预约将变为「未指定门店」。确定删除？"
    : "确定删除该门店？";
  if (!(await confirmDialog(msg, "删除门店"))) return;
  await repo.deleteStore(id);
  await repo.loadAll();
  renderAll();
  toast("已删除");
}

/* ============================================================
 * 账号与权限管理（总经理，仅云端）
 * ============================================================ */
async function renderAccounts() {
  const box = document.getElementById("accountList");
  if (!box) return;
  if (!perm.manageAccounts()) { box.innerHTML = ""; return; }
  
  let accounts = [];
  if (MODE === "cloud") {
    accounts = await repo.loadProfiles();
  } else {
    accounts = cache.accounts;
  }
  
  if (accounts.length === 0) { 
    box.innerHTML = `
      <div class="empty">暂无账号。</div>
      ${MODE === "local" ? `<button class="btn" onclick="addLocalAccount()">添加本地账号</button>` : ""}
    `; 
    return; 
  }

  const roleOpts = (cur) => `<option value="">待分配</option>` +
    Object.keys(ROLE_LABEL).map((r) => `<option value="${r}" ${cur === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("");
  const storeOpts = (cur) => `<option value="">—</option>` +
    cache.stores.map((s) => `<option value="${s.id}" ${cur === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("");

  box.innerHTML = `
    <div class="detail-block" style="padding:0;overflow:hidden">
      ${MODE === "local" ? `<button class="btn" style="margin-bottom:12px" onclick="addLocalAccount()">添加本地账号</button>` : ""}
      <table class="data">
        <thead><tr><th>邮箱</th><th>姓名</th><th>角色</th><th>所属门店</th><th>操作</th></tr></thead>
        <tbody>
          ${accounts.map((a) => `
            <tr>
              <td>${esc(a.email || a.id)}</td>
              <td><input type="text" class="input" value="${esc(a.name)}" placeholder="请输入姓名" onchange="changeAccountName('${a.id}', this.value)" /></td>
              <td><select class="input" onchange="changeAccountRole('${a.id}', this.value)">${roleOpts(a.role)}</select></td>
              <td><select class="input" onchange="changeAccountStore('${a.id}', this.value)">${storeOpts(a.storeId)}</select></td>
              <td><button class="btn btn-danger btn-small" onclick="deleteAccount('${a.id}', '${esc(a.email || a.id)}')">删除</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

async function changeAccountName(id, name) {
  if (MODE === "cloud") {
    await repo.setProfile(id, { name });
  } else {
    const account = cache.accounts.find(a => a.id === id);
    if (account) {
      account.name = name;
      saveLocal();
    }
  }
  toast("姓名已更新");
}

async function changeAccountRole(id, role) {
  if (MODE === "cloud") {
    await repo.setProfile(id, { role });
  } else {
    const account = cache.accounts.find(a => a.id === id);
    if (account) {
      account.role = role;
      saveLocal();
    }
  }
  toast("角色已更新");
  renderAccounts();
}

async function changeAccountStore(id, storeId) {
  if (MODE === "cloud") {
    await repo.setProfile(id, { storeId });
  } else {
    const account = cache.accounts.find(a => a.id === id);
    if (account) {
      account.storeId = storeId;
      saveLocal();
    }
  }
  toast("门店已更新");
}

async function deleteAccount(id, email) {
  if (!(await confirmDialog(`确定要删除账号 ${email} 吗？此操作不可撤销。`, "删除账号"))) return;
  await repo.deleteAccount(id);
  toast("账号已删除");
  renderAccounts();
}

async function addLocalAccount() {
  const email = prompt("请输入账号邮箱：");
  if (!email) return;
  const name = prompt("请输入姓名：");
  const account = {
    id: uid(),
    email: email,
    name: name || "",
    role: ROLE.WORKER,
    storeId: null,
    createdAt: new Date().toISOString(),
  };
  cache.accounts.push(account);
  saveLocal();
  toast("账号已添加");
  renderAccounts();
}

/* ============================================================
 * 角色权限配置（总经理勾选每个角色可做的操作）
 * ============================================================ */
const PERM_ROLES = [ROLE.STORE, ROLE.WORKER];  // manager 恒全权限，不在此配置

function renderRolePermissions() {
  const box = document.getElementById("rolePermList");
  if (!box) return;
  if (!perm.manageAccounts()) { box.innerHTML = ""; return; }

  const caps = Object.keys(CAP_LABEL);
  const head = `<tr><th style="text-align:left">权限项</th>${
    PERM_ROLES.map((r) => `<th>${ROLE_LABEL[r]}</th>`).join("")}</tr>`;
  const rows = caps.map((cap) => `
    <tr>
      <td style="text-align:left">${esc(CAP_LABEL[cap])}</td>
      ${PERM_ROLES.map((r) => {
        const on = !!(rolePerms[r] && rolePerms[r][cap]);
        return `<td style="text-align:center">
          <input type="checkbox" ${on ? "checked" : ""}
            onchange="toggleRolePerm('${r}','${cap}', this.checked)" />
        </td>`;
      }).join("")}
    </tr>`).join("");

  box.innerHTML = `
    <div class="detail-block" style="padding:0;overflow:hidden">
      <table class="data perm-table">
        <thead>${head}</thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function toggleRolePerm(role, cap, checked) {
  const base = { ...(DEFAULT_ROLE_PERMS[role] || {}), ...(rolePerms[role] || {}) };
  base[cap] = !!checked;
  await repo.saveRolePermissions(role, base);
  toast("权限已更新");
  // 权限变更可能影响当前界面（尤其总经理本人恒全权，此处主要刷新配置表）
  renderRolePermissions();
}

/* ============================================================
 * 弹窗 & Tab
 * ============================================================ */
let modalOnConfirm = null;
let modalOnClose = null;

function confirmDialog(message, title = "确认操作") {
  return new Promise((resolve) => {
    let resolved = false;
    modal.open(title, `<p>${message}</p>`, {
      confirmText: "确定",
      cancelText: "取消",
      onConfirm: () => {
        if (resolved) return;
        resolved = true;
        resolve(true);
        return true;
      },
      onClose: () => {
        if (resolved) return;
        resolved = true;
        resolve(false);
      }
    });
  });
}

function promptDialog(message, title = "输入", defaultValue = "") {
  return new Promise((resolve) => {
    const inputId = "promptInput_" + Date.now();
    let resolved = false;
    modal.open(title, `
      <p>${message}</p>
      <input type="text" id="${inputId}" class="input" style="width:100%;margin-top:12px;" value="${esc(defaultValue)}">
    `, {
      confirmText: "确定",
      cancelText: "取消",
      onConfirm: () => {
        if (resolved) return;
        resolved = true;
        const input = document.getElementById(inputId);
        const value = input ? input.value.trim() : "";
        resolve(value || null);
        return true;
      },
      onClose: () => {
        if (resolved) return;
        resolved = true;
        resolve(null);
      }
    });
    setTimeout(() => {
      const input = document.getElementById(inputId);
      if (input) {
        input.focus();
        input.select();
      }
    }, 100);
  });
}

const modal = {
  open(title, bodyHtml, options = {}) {
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalBody").innerHTML = bodyHtml;
    
    const confirmBtn = document.getElementById("modalConfirm");
    const cancelBtn = document.getElementById("modalCancel");
    const modalFooter = document.getElementById("modalFooter");
    
    modalOnClose = options.onClose || null;
    
    if (options.hideFooter) {
      modalFooter.classList.add("hidden");
    } else {
      modalFooter.classList.remove("hidden");
      if (options.onConfirm) {
        modalOnConfirm = options.onConfirm;
        confirmBtn.textContent = options.confirmText || "确认";
        confirmBtn.classList.remove("hidden");
        cancelBtn.textContent = options.cancelText || "取消";
        cancelBtn.classList.remove("hidden");
      } else {
        modalOnConfirm = null;
        confirmBtn.classList.add("hidden");
        cancelBtn.classList.add("hidden");
      }
    }
    
    document.getElementById("modal").classList.remove("hidden");
  },
  close() {
    document.getElementById("modal").classList.add("hidden");
    document.getElementById("modalBody").innerHTML = "";
    document.getElementById("modalFooter").classList.remove("hidden");
    if (modalOnClose) {
      modalOnClose();
      modalOnClose = null;
    }
    modalOnConfirm = null;
  },
};

/* 全局搜索功能 */
let globalSearchTimer = null;

function initGlobalSearch() {
  const input = document.getElementById("globalSearch");
  const results = document.getElementById("globalSearchResults");
  
  if (!input || !results) return;
  
  input.addEventListener("input", function() {
    clearTimeout(globalSearchTimer);
    const query = this.value.trim().toLowerCase();
    
    if (!query) {
      results.classList.remove("show");
      return;
    }
    
    globalSearchTimer = setTimeout(() => {
      performSearch(query);
    }, 200);
  });
  
  input.addEventListener("focus", function() {
    if (this.value.trim()) {
      performSearch(this.value.trim().toLowerCase());
    }
  });
  
  document.addEventListener("click", function(e) {
    if (!input.contains(e.target) && !results.contains(e.target)) {
      results.classList.remove("show");
    }
  });
}

function performSearch(query) {
  const results = document.getElementById("globalSearchResults");
  
  const projectResults = cache.projects.filter(p => 
    (p.name && p.name.toLowerCase().includes(query)) ||
    (p.storeId && getStore(p.storeId)?.name?.toLowerCase().includes(query)) ||
    (p.assignedWorkerIds || []).some(wid => getWorker(wid)?.name?.toLowerCase().includes(query))
  ).slice(0, 8);
  
  const workerResults = cache.workers.filter(w => 
    (w.name && w.name.toLowerCase().includes(query)) ||
    (w.phone && w.phone.includes(query))
  ).slice(0, 8);
  
  const storeResults = cache.stores.filter(s => 
    (s.name && s.name.toLowerCase().includes(query)) ||
    (s.phone && s.phone.includes(query))
  ).slice(0, 8);
  
  let html = "";
  
  if (projectResults.length > 0) {
    html += `<div class="search-results-header">📋 项目 (${projectResults.length})</div>`;
    html += projectResults.map(p => `
      <div class="search-result-item" onclick="searchNavigateToProject('${p.id}')">
        <div class="search-result-icon">📋</div>
        <div class="search-result-content">
          <div class="search-result-title">${esc(p.name)}</div>
          <div class="search-result-subtitle">${storeName(p.storeId)} · ${p.status}</div>
        </div>
      </div>
    `).join("");
  }
  
  if (workerResults.length > 0) {
    html += `<div class="search-results-header">👷 员工 (${workerResults.length})</div>`;
    html += workerResults.map(w => `
      <div class="search-result-item" onclick="searchNavigateToWorker('${w.id}')">
        <div class="search-result-icon">👷</div>
        <div class="search-result-content">
          <div class="search-result-title">${esc(w.name)}</div>
          <div class="search-result-subtitle">${esc(w.role || "施工人员")} · ${esc(w.phone || "")}</div>
        </div>
      </div>
    `).join("");
  }
  
  if (storeResults.length > 0) {
    html += `<div class="search-results-header">🏪 门店 (${storeResults.length})</div>`;
    html += storeResults.map(s => `
      <div class="search-result-item" onclick="searchNavigateToStore('${s.id}')">
        <div class="search-result-icon">🏪</div>
        <div class="search-result-content">
          <div class="search-result-title">${esc(s.name)}</div>
          <div class="search-result-subtitle">${esc(s.phone || "")}</div>
        </div>
      </div>
    `).join("");
  }
  
  if (!html) {
    html = `<div class="search-results-empty">未找到匹配结果</div>`;
  }
  
  results.innerHTML = html;
  results.classList.add("show");
}

function searchNavigateToProject(id) {
  switchTab("projects");
  document.getElementById("globalSearch").value = "";
  document.getElementById("globalSearchResults").classList.remove("show");
  setTimeout(() => {
    document.getElementById("projectSearch").value = getProject(id)?.name || "";
    renderProjects();
  }, 100);
}

function searchNavigateToWorker(id) {
  switchTab("workers");
  document.getElementById("globalSearch").value = "";
  document.getElementById("globalSearchResults").classList.remove("show");
}

function searchNavigateToStore(id) {
  switchTab("stores");
  document.getElementById("globalSearch").value = "";
  document.getElementById("globalSearchResults").classList.remove("show");
}

document.addEventListener("DOMContentLoaded", initGlobalSearch);

/* 操作日志功能 */
const OPERATION_TYPES = {
  PROJECT_CREATE: "创建项目",
  PROJECT_EDIT: "编辑项目",
  PROJECT_DELETE: "删除项目",
  PROJECT_ASSIGN: "分配员工",
  PROJECT_UNASSIGN: "移除员工",
  PROJECT_OUTSOURCE_ADD: "添加外协人员",
  PROJECT_OUTSOURCE_REMOVE: "移除外协人员",
  PROJECT_START: "开始施工",
  PROJECT_PAUSE: "暂停施工",
  PROJECT_RESUME: "恢复施工",
  PROJECT_COMPLETE: "完成项目",
  PROJECT_CANCEL: "取消项目",
  PROJECT_DELAY: "项目延期",
  PROJECT_ACCEPT: "验收项目",
  PROJECT_REVIEW: "审核项目",
  LEAVE_CREATE: "提交请假",
  LEAVE_APPROVE: "批准请假",
  LEAVE_REJECT: "拒绝请假",
  LEAVE_WITHDRAW: "撤回请假",
  WORKER_CREATE: "添加员工",
  WORKER_EDIT: "编辑员工",
  WORKER_DELETE: "删除员工",
  STORE_CREATE: "添加门店",
  STORE_EDIT: "编辑门店",
  STORE_DELETE: "删除门店",
  WORK_LOG_ADD: "添加工时",
  WORK_LOG_DELETE: "删除工时",
};

let logSaveTimer = null;
let pendingLogs = [];

async function pruneOldLogs() {
  if (!sb) return;
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    const cutoffTimestamp = cutoffDate.toISOString();
    await sb.from("operation_logs").delete().lt("timestamp", cutoffTimestamp);
  } catch (e) {
    console.warn("清理旧日志失败:", e);
  }
}

function logOperation(type, target, detail = "") {
  const log = {
    id: uid(),
    type,
    type_label: OPERATION_TYPES[type] || type,
    target,
    detail,
    operator: currentProfile?.id || "system",
    operator_name: currentProfile?.email || currentProfile?.name || "系统",
    operator_role: myRole(),
    timestamp: new Date().toISOString(),
  };
  cache.operationLogs.unshift(log);
  if (cache.operationLogs.length > MAX_LOGS) {
    cache.operationLogs = cache.operationLogs.slice(0, MAX_LOGS);
    pruneOldLogs().catch(() => {});
  }
  
  pendingLogs.push(log);
  
  if (logSaveTimer) clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => {
    if (MODE === "local") {
      saveLocal();
    }
    if (sb && pendingLogs.length > 0) {
      const logsToSave = [...pendingLogs];
      pendingLogs = [];
      sb.from("operation_logs").insert(logsToSave).catch(e => {
        console.warn("保存操作日志失败:", e);
        pendingLogs = [...logsToSave, ...pendingLogs];
      });
    } else {
      pendingLogs = [];
    }
  }, 300);
}

function showOperationLogs() {
  const allLogs = cache.operationLogs;
  
  const modalContent = `
    <div style="max-height:600px;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <h3 style="margin:0;">📝 操作日志</h3>
          <div style="font-size:12px;color:var(--muted);margin-top:4px;">共 ${allLogs.length} 条记录</div>
        </div>
        ${allLogs.length > 0 ? `<button class="btn small" onclick="clearOperationLogs()" style="background:#ef4444;color:#fff;border:none">🗑️ 清除日志</button>` : ""}
      </div>
      <div style="margin-bottom:12px;">
        <input type="text" id="logSearchInput" class="input" placeholder="搜索日志（关键词、操作人、目标）" style="width:100%;" />
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button class="btn tiny" onclick="filterLogs('all')">全部</button>
        <button class="btn tiny" onclick="filterLogs('project')">项目操作</button>
        <button class="btn tiny" onclick="filterLogs('worker')">人员操作</button>
        <button class="btn tiny" onclick="filterLogs('worklog')">工时操作</button>
      </div>
      <div id="logList">
        ${allLogs.length > 0 ? allLogs.slice(0, 100).map(log => renderLogItem(log)).join("") : `<div style="text-align:center;color:var(--muted);padding:40px;">暂无操作日志</div>`}
      </div>
    </div>
  `;
  
  modal.open("操作日志", modalContent);
  
  setTimeout(() => {
    const searchInput = document.getElementById("logSearchInput");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const keyword = e.target.value.toLowerCase();
        const filtered = allLogs.filter(log => {
          const target = (log.target || "").toLowerCase();
          const detail = (log.detail || "").toLowerCase();
          const operator = ((log.operatorName || log.operator_name) || "").toLowerCase();
          return target.includes(keyword) || detail.includes(keyword) || operator.includes(keyword);
        });
        document.getElementById("logList").innerHTML = filtered.length > 0 ? 
          filtered.slice(0, 100).map(log => renderLogItem(log)).join("") : 
          `<div style="text-align:center;color:var(--muted);padding:40px;">未找到匹配日志</div>`;
      });
    }
  }, 100);
}

function filterLogs(type) {
  const allLogs = cache.operationLogs;
  let filtered = allLogs;
  
  if (type === "project") {
    filtered = allLogs.filter(log => log.type.startsWith("PROJECT_"));
  } else if (type === "worker") {
    filtered = allLogs.filter(log => log.type.startsWith("WORKER_") || log.type.startsWith("PROJECT_ASSIGN") || log.type.startsWith("PROJECT_UNASSIGN") || log.type.startsWith("PROJECT_OUTSOURCE"));
  } else if (type === "worklog") {
    filtered = allLogs.filter(log => log.type.startsWith("WORK_LOG_"));
  }
  
  document.getElementById("logList").innerHTML = filtered.length > 0 ? 
    filtered.slice(0, 100).map(log => renderLogItem(log)).join("") : 
    `<div style="text-align:center;color:var(--muted);padding:40px;">未找到匹配日志</div>`;
}

function renderLogItem(log) {
  const typeColors = {
    PROJECT_CREATE: "#22c55e",
    PROJECT_EDIT: "#3b82f6",
    PROJECT_DELETE: "#ef4444",
    PROJECT_ASSIGN: "#8b5cf6",
    PROJECT_UNASSIGN: "#f59e0b",
    PROJECT_OUTSOURCE_ADD: "#06b6d4",
    PROJECT_OUTSOURCE_REMOVE: "#f97316",
    PROJECT_START: "#10b981",
    PROJECT_PAUSE: "#f59e0b",
    PROJECT_RESUME: "#22c55e",
    PROJECT_COMPLETE: "#22c55e",
    PROJECT_CANCEL: "#ef4444",
    PROJECT_DELAY: "#f97316",
    PROJECT_ACCEPT: "#3b82f6",
    PROJECT_REVIEW: "#8b5cf6",
    WORK_LOG_ADD: "#10b981",
    WORK_LOG_DELETE: "#ef4444",
  };
  
  const color = typeColors[log.type] || "var(--primary)";
  const timestamp = new Date(log.timestamp);
  const dateStr = `${timestamp.getFullYear()}-${String(timestamp.getMonth()+1).padStart(2,'0')}-${String(timestamp.getDate()).padStart(2,'0')}`;
  const timeStr = `${String(timestamp.getHours()).padStart(2,'0')}:${String(timestamp.getMinutes()).padStart(2,'0')}:${String(timestamp.getSeconds()).padStart(2,'0')}`;
  
  return `
    <div style="border-bottom:1px solid #f3f4f6;padding:12px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:bold;color:${color};">${esc(log.typeLabel || log.type_label)}</span>
        <span style="font-size:12px;color:var(--muted)">${dateStr} ${timeStr}</span>
      </div>
      <div style="margin-top:4px;font-size:13px;"><strong>目标：</strong>${esc(log.target)}</div>
      ${log.detail ? `<div style="margin-top:4px;font-size:12px;color:#4b5563;"><strong>详情：</strong>${esc(log.detail)}</div>` : ""}
      <div style="margin-top:4px;font-size:12px;color:#6b7280;">操作人：${esc(log.operatorName || log.operator_name || "系统")}（${ROLE_LABEL[log.operatorRole || log.operator_role] || log.operatorRole || log.operator_role || "未分配"}）</div>
    </div>
  `;
}

async function clearOperationLogs() {
  if (!(await confirmDialog("确定要清除所有操作日志吗？此操作不可撤销。", "清除日志"))) return;
  
  cache.operationLogs = [];
  saveLocal();
  
  if (sb) {
    try {
      await sb.from("operation_logs").delete().neq("id", "");
    } catch (e) {
      console.warn("清除云端操作日志失败:", e);
    }
  }
  
  toast("已清除所有操作日志");
  showOperationLogs();
}

/* 数据导出功能 */
function showExportMenu() {
  if (currentProfile.role !== ROLE.MANAGER) {
    toast("只有总经理可以执行此操作");
    return;
  }
  const menu = document.getElementById("exportMenu");
  if (menu) {
    menu.classList.toggle("hidden");
  }
}

function downloadCSV(filename, data) {
  const blob = new Blob(["\ufeff" + data], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("导出成功");
}

function exportProjects() {
  const headers = ["项目ID", "项目名称", "门店", "客户名称", "联系电话", "地址", "状态", "预约时间", "结束时间", "预计工时", "外协工时", "实际工时", "施工人数", "施工人员", "外协人员", "开工时间", "完工时间", "备注", "创建时间", "更新时间"];
  const rows = cache.projects.map(p => [
    p.id,
    p.name || "",
    storeName(p.storeId) || "",
    p.customer || "",
    p.phone || "",
    p.address || "",
    p.status || "",
    p.appointmentTime || "",
    p.endTime || "",
    p.estimatedHours || 0,
    p.outsourcedHours || 0,
    p.actualHours || 0,
    p.workerCount || 1,
    (p.assignedWorkerIds || []).map(wid => getWorker(wid)?.name || wid).join(", ") || "",
    p.outsourcedWorkers || "",
    p.startedAt || "",
    p.finishedAt || "",
    p.note || "",
    p.createdAt || "",
    p.updatedAt || ""
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
  downloadCSV(`项目数据_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  document.getElementById("exportMenu").classList.add("hidden");
}

function exportWorkLogs() {
  const headers = ["日志ID", "项目ID", "项目名称", "门店", "员工ID", "员工姓名", "日期", "工时", "工时等级", "开始时间", "结束时间", "备注", "是否外协"];
  const rows = cache.projects.flatMap(p => 
    (p.workLogs || []).map(l => [
      l.id || "",
      p.id,
      p.name || "",
      storeName(p.storeId) || "",
      l.workerId || "",
      l.workerName || (l.workerId ? (getWorker(l.workerId)?.name || "") : ""),
      l.date || "",
      l.hours || 0,
      l.level || "中级",
      l.startTime || "",
      l.endTime || "",
      l.note || "",
      l.isOutsourced ? "是" : "否"
    ])
  );
  const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
  downloadCSV(`工时记录_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  document.getElementById("exportMenu").classList.add("hidden");
}

function exportLeaveRecords() {
  const headers = ["请假ID", "员工", "请假类型", "开始日期", "开始时段", "结束日期", "结束时段", "原因", "状态", "审批人", "审批意见", "创建时间"];
  const rows = cache.leaveRecords.map(l => [
    l.id,
    l.workerName || "",
    LEAVE_TYPE_LABEL[l.leaveType] || l.leaveType || "",
    l.startDate || "",
    formatLeaveTimeType(l.startType) || "",
    l.endDate || "",
    formatLeaveTimeType(l.endType) || "",
    l.reason || "",
    LEAVE_STATUS_LABEL[l.status] || l.status || "",
    l.reviewerName || "",
    l.reviewNote || "",
    l.createdAt || ""
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
  downloadCSV(`请假记录_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  document.getElementById("exportMenu").classList.add("hidden");
}

function exportWorkers() {
  const headers = ["员工ID", "姓名", "联系电话", "角色", "创建时间"];
  const rows = cache.workers.map(w => [
    w.id,
    w.name || "",
    w.phone || "",
    w.role || "",
    w.createdAt || ""
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
  downloadCSV(`施工人员_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  document.getElementById("exportMenu").classList.add("hidden");
}

function exportStores() {
  const headers = ["门店ID", "门店名称", "联系电话", "创建时间"];
  const rows = cache.stores.map(s => [
    s.id,
    s.name || "",
    s.phone || "",
    s.createdAt || ""
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
  downloadCSV(`门店数据_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  document.getElementById("exportMenu").classList.add("hidden");
}

function exportAllData() {
  const timestamp = new Date().toISOString().slice(0, 10);
  exportProjects();
  setTimeout(() => exportWorkLogs(), 500);
  setTimeout(() => exportLeaveRecords(), 1000);
  setTimeout(() => exportWorkers(), 1500);
  setTimeout(() => exportStores(), 2000);
  document.getElementById("exportMenu").classList.add("hidden");
}

document.addEventListener("click", function(e) {
  const exportBtn = document.getElementById("btnExport");
  const exportMenu = document.getElementById("exportMenu");
  if (exportMenu && exportBtn && !exportBtn.contains(e.target) && !exportMenu.contains(e.target)) {
    exportMenu.classList.add("hidden");
  }
});

function parseCSV(csvText) {
  const lines = csvText.split("\n").filter(l => l.trim());
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map(line => {
    const values = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return headers.reduce((obj, h, idx) => {
      obj[h] = values[idx] || "";
      return obj;
    }, {});
  });
  return { headers, rows };
}

function showImportModal() {
  const modal = document.createElement("div");
  modal.id = "importModal";
  modal.className = "modal-mask";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>数据导入</h3>
        <button class="modal-close" onclick="document.getElementById('importModal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div style="margin-bottom:16px">
          <label style="display:block;margin-bottom:8px;font-weight:600">选择要导入的文件类型</label>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            <button class="btn" onclick="triggerImportFile('projects')">项目数据</button>
            <button class="btn" onclick="triggerImportFile('work_logs')">工时记录</button>
            <button class="btn" onclick="triggerImportFile('workers')">施工人员</button>
            <button class="btn" onclick="triggerImportFile('stores')">门店数据</button>
            <button class="btn" onclick="triggerImportFile('leave_records')">请假记录</button>
            <button class="btn" onclick="triggerImportFile('outsourced_workers')">外协人员</button>
          </div>
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;margin-bottom:8px;font-weight:600">或者拖拽文件到此处</label>
          <div id="dropZone" style="border:2px dashed #ccc;border-radius:8px;padding:30px;text-align:center;color:#999" 
               ondragover="event.preventDefault()" ondrop="handleDrop(event)">
            <div style="font-size:24px;margin-bottom:8px">📁</div>
            <div>拖拽CSV文件到此处</div>
          </div>
        </div>
        <div id="importStatus" style="min-height:40px;padding:12px;border-radius:6px;background:#f5f5f5;display:none"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="document.getElementById('importModal').remove()">关闭</button>
      </div>
      <input type="file" id="importFileInput" class="hidden" accept=".csv" onchange="handleFileSelect(this)">
    </div>
  `;
  document.body.appendChild(modal);
}

function triggerImportFile(type) {
  const input = document.getElementById("importFileInput");
  input.dataset.type = type;
  input.click();
}

function handleDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith(".csv")) {
    guessTypeAndImport(file);
  }
}

function handleFileSelect(input) {
  const file = input.files[0];
  if (file) {
    importFile(file, input.dataset.type);
  }
}

function guessTypeAndImport(file) {
  const name = file.name.toLowerCase();
  let type = "projects";
  if (name.includes("工时")) type = "work_logs";
  else if (name.includes("人员")) type = "workers";
  else if (name.includes("门店")) type = "stores";
  else if (name.includes("请假")) type = "leave_records";
  else if (name.includes("外协")) type = "outsourced_workers";
  importFile(file, type);
}

function importFile(file, type) {
  const status = document.getElementById("importStatus");
  status.style.display = "block";
  status.innerHTML = `<div style="color:#666">正在读取文件...</div>`;
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const csv = parseCSV(e.target.result);
      const count = await importData(type, csv.rows);
      status.innerHTML = `<div style="color:#10b981;font-weight:600">✅ 成功导入 ${count} 条记录</div>`;
      setTimeout(() => loadData(), 1000);
    } catch (err) {
      status.innerHTML = `<div style="color:#ef4444">❌ 导入失败: ${err.message}</div>`;
    }
  };
  reader.readAsText(file, "UTF-8");
}

async function importData(type, rows) {
  let count = 0;
  for (const row of rows) {
    try {
      switch (type) {
        case "projects":
          await importProject(row);
          break;
        case "work_logs":
          await importWorkLog(row);
          break;
        case "workers":
          await importWorker(row);
          break;
        case "stores":
          await importStore(row);
          break;
        case "leave_records":
          await importLeaveRecord(row);
          break;
        case "outsourced_workers":
          await importOutsourcedWorker(row);
          break;
      }
      count++;
    } catch (e) {
      console.warn("导入失败:", e);
    }
  }
  return count;
}

async function importProject(row) {
  const p = {
    id: row["项目ID"] || row["id"] || uid(),
    name: row["项目名称"] || row["name"] || "",
    storeId: row["门店ID"] || row["storeId"] || "",
    customer: row["客户"] || row["customer"] || "",
    phone: row["联系电话"] || row["phone"] || "",
    address: row["安装地址"] || row["address"] || "",
    appointmentTime: row["预约时间"] || row["appointmentTime"] || "",
    estimatedHours: parseFloat(row["预计工时"] || row["estimatedHours"] || "0"),
    status: row["状态"] || row["status"] || STATUS.BOOKED,
    assignedWorkerIds: row["分配人员ID"] ? row["分配人员ID"].split(",") : [],
    outsourcedHours: parseFloat(row["外协工时"] || row["outsourcedHours"] || "0"),
    outsourcedWorkers: row["外协人员"] || row["outsourcedWorkers"] || "",
    started_at: row["开始施工时间"] || row["started_at"] || "",
    finished_at: row["完工时间"] || row["finished_at"] || "",
    note: row["备注"] || row["note"] || "",
    createdAt: row["创建时间"] || row["createdAt"] || now(),
    updatedAt: now()
  };
  await repo.saveProject(p);
}

async function importWorkLog(row) {
  const projectId = row["项目ID"] || row["project_id"];
  if (!projectId) return;
  
  const log = {
    id: row["日志ID"] || row["id"] || uid(),
    projectId: projectId,
    workerId: row["员工ID"] || row["workerId"] || "",
    workerName: row["员工姓名"] || row["workerName"] || "",
    date: row["日期"] || row["date"] || "",
    hours: parseFloat(row["工时"] || row["hours"] || "0"),
    level: row["工时等级"] || row["level"] || "中级",
    startTime: row["开始时间"] || row["startTime"] || "",
    endTime: row["结束时间"] || row["endTime"] || "",
    note: row["备注"] || row["note"] || "",
    isOutsourced: (row["是否外协"] || row["isOutsourced"] || "否") === "是"
  };
  
  if (sb) {
    await sb.from("work_logs").upsert(log, { onConflict: "id" });
  } else {
    const p = cache.projects.find(p => p.id === projectId);
    if (p) {
      if (!p.workLogs) p.workLogs = [];
      const existingIdx = p.workLogs.findIndex(l => l.id === log.id);
      if (existingIdx >= 0) {
        p.workLogs[existingIdx] = log;
      } else {
        p.workLogs.push(log);
      }
      await repo.saveProject(p);
    }
  }
}

async function importWorker(row) {
  const w = {
    id: row["员工ID"] || row["id"] || uid(),
    name: row["姓名"] || row["name"] || "",
    phone: row["联系电话"] || row["phone"] || "",
    role: row["角色"] || row["role"] || "worker",
    createdAt: row["创建时间"] || row["createdAt"] || now()
  };
  await repo.saveWorker(w);
}

async function importStore(row) {
  const s = {
    id: row["门店ID"] || row["id"] || uid(),
    name: row["门店名称"] || row["name"] || "",
    phone: row["联系电话"] || row["phone"] || "",
    createdAt: row["创建时间"] || row["createdAt"] || now()
  };
  await repo.saveStore(s);
}

async function importLeaveRecord(row) {
  const lr = {
    id: row["请假ID"] || row["id"] || uid(),
    workerId: row["员工ID"] || row["workerId"] || "",
    workerName: row["员工姓名"] || row["workerName"] || "",
    leaveType: row["请假类型"] || row["leaveType"] || "",
    startDate: row["开始日期"] || row["startDate"] || "",
    startType: row["开始时段"] || row["startType"] || "",
    endDate: row["结束日期"] || row["endDate"] || "",
    endType: row["结束时段"] || row["endType"] || "",
    reason: row["原因"] || row["reason"] || "",
    status: row["状态"] || row["status"] || "pending",
    reviewerName: row["审批人"] || row["reviewerName"] || "",
    reviewNote: row["审批意见"] || row["reviewNote"] || "",
    createdAt: row["创建时间"] || row["createdAt"] || now()
  };
  await repo.saveLeaveRecord(lr);
}

async function importOutsourcedWorker(row) {
  const ow = {
    id: row["ID"] || row["id"] || uid(),
    name: row["姓名"] || row["name"] || "",
    phone: row["电话"] || row["phone"] || "",
    createdAt: row["创建时间"] || row["createdAt"] || now()
  };
  await repo.saveOutsourcedWorker(ow);
}

function switchTab(name) {
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (btn && btn.classList.contains("hidden")) return;
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((s) =>
    s.classList.toggle("active", s.id === name));
  document.querySelectorAll(".bottom-nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelector(".tabs").classList.remove("open");

  if (name !== "calendar" && name !== "workers") {
    document.body.classList.remove("timeline-view");
    document.removeEventListener("click", timelineCloseAllTasks);
    closeTimelineActionMenu();
  } else {
    if (name === "calendar") renderCalendar();
    document.body.classList.add("timeline-view");
  }

  if (name === "stats" || name === "storeStats") {
    document.body.classList.add("stats-view");
  } else {
    document.body.classList.remove("stats-view");
  }

  if (name === "schedules") {
    renderWorkerSchedules();
  }
  if (name === "internalTasks") {
    initInternalTasks();
  }
}

/* 头部角色标签 */
function renderRoleInfo() {
  const el = document.getElementById("roleInfo");
  if (MODE !== "cloud") { el.classList.add("hidden"); return; }
  const role = myRole();
  let text;
  if (!role) {
    text = "待分配权限";
  } else {
    text = ROLE_LABEL[role] || role;
    if (role === ROLE.STORE) text += `·${storeName(myStore())}`;
  }
  el.textContent = text;
  el.classList.remove("hidden");
}

/* 根据当前角色显隐 Tab 与操作按钮 */
function applyPermissions() {
  const role = myRole();
  const tabVisible = {
    projects: role != null,
    calendar: role != null,
    construction: role != null,
    stats: perm.viewStats(),
    storeStats: perm.viewStoreStats(),
    workers: perm.manageWorkers() || myRole() === ROLE.WORKER,
    outsourced: perm.manageWorkers(),
    leaves: role != null,
    schedules: role != null,
    stores: perm.manageStores(),
    accounts: perm.manageAccounts() && MODE === "cloud",
    rolePerms: perm.manageAccounts() && MODE === "cloud",
    internalTasks: role != null && (isManager() || (!myStore() && (isStoreManager() || isWorker())) || (cache.stores.length > 0 && storeName(myStore()).includes("广告工程部"))),
  };
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("hidden", !tabVisible[b.dataset.tab]);
  });

  const setHidden = (id, hidden) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", hidden);
  };
  setHidden("btnNewProject", !perm.createProject());
  setHidden("btnNewWorker", !perm.manageWorkers());
  setHidden("btnNewOutsourced", !perm.manageWorkers());
  setHidden("btnNewStore", !perm.manageStores());
  setHidden("btnWageConfig", !perm.manageWageConfig());
  setHidden("btnExportStats", !perm.viewGlobalStats());
  setHidden("btnInternalWorkLog", !perm.viewGlobalStats());
  setHidden("statsPeriod", !perm.viewGlobalStats() && myStore());
  setHidden("statsWorker", !perm.viewGlobalStats() && myStore());
  setHidden("statsStatus", !perm.viewGlobalStats() && myStore());

  const isAssignedStoreManager = isStoreManager() && myStore();
  
  const bottomNavVisible = {
    projects: role != null,
    calendar: role != null,
    construction: role != null,
    workers: !isAssignedStoreManager && role != null,
    leaves: !isAssignedStoreManager && role != null,
    schedules: !isAssignedStoreManager && role != null,
    stats: perm.viewStats(),
    storeStats: perm.viewStoreStats(),
    internalTasks: role != null && (isManager() || (!myStore() && (isStoreManager() || isWorker())) || (cache.stores.length > 0 && storeName(myStore()).includes("广告工程部"))),
  };
  document.querySelectorAll(".bottom-nav-item").forEach((b) => {
    const tab = b.dataset.tab;
    b.classList.toggle("hidden", !bottomNavVisible[tab]);
  });

  const activeBtn = document.querySelector(".tab-btn.active");
  if (!activeBtn || activeBtn.classList.contains("hidden")) {
    const firstVisible = Array.from(document.querySelectorAll(".tab-btn"))
      .find((b) => !b.classList.contains("hidden"));
    if (firstVisible) switchTab(firstVisible.dataset.tab);
  }
}

function renderAll() {
  renderWorkers();
  renderProjects();
  refreshProjectSelector();
  refreshProjectStoreFilter();
  refreshWorkerSelectors();
  refreshStoreSelectors();
  renderConstruction();
  renderCalendar();
  renderTimelineInDetail();
  renderStats();
  renderStoreStats();
  renderStores();
  renderOutsourcedWorkers();
  renderAccounts();
  renderRolePermissions();
  renderLeaves();
  initScheduleFilters();
  renderWorkerSchedules();
  initInternalTasks();
}

/* ============================================================
 * 请假管理
 * ============================================================ */
function renderLeaves() {
  refreshLeaveWorkerFilter();
  
  const statsEl = document.getElementById("leaveStats");
  const pendingList = document.getElementById("leavePendingList");
  const recordList = document.getElementById("leaveRecordList");
  const statusFilter = document.getElementById("leaveStatusFilter");
  const typeFilter = document.getElementById("leaveTypeFilter");
  const workerFilter = document.getElementById("leaveWorkerFilter");
  
  if (!pendingList || !recordList) return;
  
  const status = statusFilter.value;
  const type = typeFilter.value;
  const workerId = workerFilter.value;
  
  let records = cache.leaveRecords;
  if (status) records = records.filter(r => r.status === status);
  if (type) records = records.filter(r => r.leaveType === type);
  if (workerId) records = records.filter(r => r.workerId === workerId);
  
  records.sort((a, b) => new Date(b.createdAt || b.startDate) - new Date(a.createdAt || a.startDate));
  
  const pendingRecords = records.filter(r => r.status === "pending");
  const historyRecords = records.filter(r => r.status !== "pending");
  
  renderLeaveStats(statsEl);
  
  if (pendingRecords.length > 0) {
    pendingList.innerHTML = `
      <h3 style="margin-bottom:12px;color:#f59e0b;">⏳ 待审批申请（${pendingRecords.length}）</h3>
      ${pendingRecords.map(r => renderLeaveCard(r, true)).join("")}
    `;
  } else {
    pendingList.innerHTML = "";
  }
  
  recordList.innerHTML = `
    ${historyRecords.length > 0 ? historyRecords.map(r => renderLeaveCard(r, perm.manageLeaves())).join("") : 
      '<div style="text-align:center;color:var(--muted);padding:40px;">暂无请假记录</div>'}
  `;
  
  const holidayEl = document.getElementById("holidayManage");
  if (holidayEl) renderHolidayManage(holidayEl);
}

function renderLeaveStats(container) {
  if (!container) return;
  
  const year = new Date().getFullYear();
  const approvedRecords = cache.leaveRecords.filter(r => r.status === "approved");
  
  const typeStats = {};
  let totalDays = 0;
  Object.keys(LEAVE_TYPE_LABEL).forEach(type => {
    typeStats[type] = { days: 0, count: 0 };
  });
  
  approvedRecords.forEach(r => {
    const days = calculateLeaveDays(r.startDate, r.endDate);
    totalDays += days;
    if (typeStats[r.leaveType]) {
      typeStats[r.leaveType].days += days;
      typeStats[r.leaveType].count++;
    }
  });
  
  const pendingCount = cache.leaveRecords.filter(r => r.status === "pending").length;
  const rejectedCount = cache.leaveRecords.filter(r => r.status === "rejected").length;
  
  const workerStats = cache.workers.map(w => {
    const workerLeaves = approvedRecords.filter(r => r.workerId === w.id);
    const workerDays = workerLeaves.reduce((sum, r) => sum + calculateLeaveDays(r.startDate, r.endDate), 0);
    return { name: w.name, days: workerDays, count: workerLeaves.length };
  }).sort((a, b) => b.days - a.days);
  
  container.innerHTML = `
    <div class="card" style="grid-column:1/-1;">
      <h3 style="margin-bottom:12px;">📊 ${year}年 请假统计概览</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;">
        <div style="text-align:center;padding:12px;background:#f0fdf4;border-radius:8px;">
          <div style="font-size:24px;font-weight:bold;color:#10b981;">${totalDays.toFixed(1)}</div>
          <div style="font-size:12px;color:var(--muted);">总请假天数</div>
        </div>
        <div style="text-align:center;padding:12px;background:#fef3c7;border-radius:8px;">
          <div style="font-size:24px;font-weight:bold;color:#f59e0b;">${pendingCount}</div>
          <div style="font-size:12px;color:var(--muted);">待审批</div>
        </div>
        <div style="text-align:center;padding:12px;background:#fee2e2;border-radius:8px;">
          <div style="font-size:24px;font-weight:bold;color:#dc2626;">${rejectedCount}</div>
          <div style="font-size:12px;color:var(--muted);">已拒绝</div>
        </div>
        <div style="text-align:center;padding:12px;background:#e0e7ff;border-radius:8px;">
          <div style="font-size:24px;font-weight:bold;color:#4338ca;">${approvedRecords.length}</div>
          <div style="font-size:12px;color:var(--muted);">已批准</div>
        </div>
      </div>
      
      <div style="margin-top:16px;">
        <h4 style="font-size:13px;margin-bottom:8px;color:var(--muted);">类型分布</h4>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${Object.entries(typeStats).map(([type, stats]) => `
            <div style="display:flex;align-items:center;gap:4px;padding:6px 12px;background:#f9fafb;border-radius:6px;">
              <span style="color:#4338ca;font-weight:bold;">${LEAVE_TYPE_LABEL[type]}</span>
              <span style="color:var(--muted);font-size:12px;">${stats.count}次 / ${stats.days.toFixed(1)}天</span>
            </div>
          `).join("")}
        </div>
      </div>
      
      <div style="margin-top:16px;">
        <h4 style="font-size:13px;margin-bottom:8px;color:var(--muted);">人员排行</h4>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="border-bottom:1px solid #e5e7eb;">
                <th style="text-align:left;padding:6px 8px;font-size:12px;color:var(--muted);">姓名</th>
                <th style="text-align:right;padding:6px 8px;font-size:12px;color:var(--muted);">请假天数</th>
                <th style="text-align:right;padding:6px 8px;font-size:12px;color:var(--muted);">请假次数</th>
              </tr>
            </thead>
            <tbody>
              ${workerStats.map(w => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:6px 8px;font-size:13px;">${esc(w.name)}</td>
                  <td style="text-align:right;padding:6px 8px;font-size:13px;">${w.days.toFixed(1)}</td>
                  <td style="text-align:right;padding:6px 8px;font-size:13px;color:var(--muted);">${w.count}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderHolidayManage(container) {
  if (!container) return;
  
  if (!perm.manageLeaves()) {
    container.innerHTML = "";
    return;
  }
  
  const holidays = cache.holidays.sort((a, b) => a.date.localeCompare(b.date));
  
  container.innerHTML = `
    <div class="card" style="grid-column:1/-1;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3>🎊 节假日管理</h3>
        <button class="btn small primary" onclick="openHolidayForm()">+ 添加节假日</button>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <th style="text-align:left;padding:8px;font-size:12px;color:var(--muted);">日期</th>
              <th style="text-align:left;padding:8px;font-size:12px;color:var(--muted);">名称</th>
              <th style="text-align:center;padding:8px;font-size:12px;color:var(--muted);">类型</th>
              <th style="text-align:right;padding:8px;font-size:12px;color:var(--muted);">操作</th>
            </tr>
          </thead>
          <tbody>
            ${holidays.map(h => `
              <tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:8px;font-size:13px;">${esc(h.date)}</td>
                <td style="padding:8px;font-size:13px;">${esc(h.name)}</td>
                <td style="text-align:center;padding:8px;">
                  <span style="padding:2px 8px;border-radius:4px;font-size:12px;${h.isWorkday ? 'background:#fef3c7;color:#92400e;' : 'background:#e0e7ff;color:#4338ca;'}">
                    ${h.isWorkday ? '调休上班' : '节假日'}
                  </span>
                </td>
                <td style="text-align:right;padding:8px;">
                  <button class="btn small" onclick="deleteHoliday('${h.id}')">删除</button>
                </td>
              </tr>
            `).join("")}
            ${holidays.length === 0 ? `
              <tr>
                <td colspan="4" style="text-align:center;padding:20px;color:var(--muted);">暂无节假日设置</td>
              </tr>
            ` : ""}
          </tbody>
        </table>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-top:12px;">
        💡 提示：节假日会在计算请假天数时自动排除；调休上班日视为工作日。
      </p>
    </div>
  `;
}

function openHolidayForm() {
  const today = new Date().toISOString().slice(0, 10);
  const form = `
    <div class="repair-form">
      <div class="form-row">
        <label>日期 *</label>
        <input class="input" type="date" id="holidayDate" value="${today}" />
      </div>
      <div class="form-row">
        <label>名称 *</label>
        <input class="input" type="text" id="holidayName" placeholder="如：春节、元旦等" />
      </div>
      <div class="form-row">
        <label>类型</label>
        <select class="input" id="holidayIsWorkday">
          <option value="false">节假日（休息）</option>
          <option value="true">调休上班</option>
        </select>
      </div>
      <div class="form-actions">
        <button class="btn" onclick="modal.close()">取消</button>
        <button class="btn primary" onclick="submitHolidayForm()">保存</button>
      </div>
    </div>
  `;
  modal.open("添加节假日", form);
}

async function submitHolidayForm() {
  const date = document.getElementById("holidayDate").value;
  const name = document.getElementById("holidayName").value.trim();
  const isWorkday = document.getElementById("holidayIsWorkday").value === "true";
  
  if (!date) { toast("请选择日期"); return; }
  if (!name) { toast("请输入名称"); return; }
  
  const existing = cache.holidays.find(h => h.date === date);
  if (existing) {
    if (!(await confirmDialog("该日期已存在节假日设置，确定覆盖吗？", "覆盖节假日"))) return;
  }
  
  await repo.saveHoliday({ date, name, isWorkday });
  await repo.loadAll();
  renderLeaves();
  modal.close();
  toast("节假日已保存");
}

async function deleteHoliday(id) {
  if (!(await confirmDialog("确定删除该节假日设置？", "删除节假日"))) return;
  
  await repo.deleteHoliday(id);
  await repo.loadAll();
  renderLeaves();
  toast("节假日已删除");
}

function refreshLeaveWorkerFilter() {
  const filter = document.getElementById("leaveWorkerFilter");
  if (!filter) return;
  
  const currentValue = filter.value;
  filter.innerHTML = '<option value="">全部人员</option>' +
    cache.workers.map(w => 
      `<option value="${esc(w.id)}" ${w.id === currentValue ? "selected" : ""}>${esc(w.name)}</option>`
    ).join("");
}

function renderLeaveCard(record, showActions) {
  const typeLabel = LEAVE_TYPE_LABEL[record.leaveType] || record.leaveType;
  const statusLabel = LEAVE_STATUS_LABEL[record.status] || record.status;
  
  let statusClass = "";
  if (record.status === "pending") statusClass = "background:#fef3c7;color:#92400e;border-color:#f59e0b";
  else if (record.status === "approved") statusClass = "background:#d1fae5;color:#065f46;border-color:#10b981";
  else if (record.status === "rejected") statusClass = "background:#fee2e2;color:#991b1b;border-color:#dc2626";
  
  const conflicts = checkLeaveProjectConflict(record.workerId, record.startDate, record.endDate, record.startTime, record.endTime);
  
  let conflictInfo = "";
  if (conflicts.length > 0) {
    const conflictList = conflicts.map(p => {
      const store = getStore(p.storeId);
      const storeName = store ? store.name : "未知门店";
      return `<li style="margin-bottom:3px;">📋 ${esc(p.name)}（${esc(storeName)}）</li>`;
    }).join("");
    conflictInfo = `
      <div class="card-row" style="background:#fef2f2;padding:8px 10px;border-radius:4px;margin-top:4px;">
        <div style="font-weight:bold;color:#dc2626;font-size:12px;margin-bottom:4px;">⚠️ 项目排期冲突（${conflicts.length}个）</div>
        <ul style="margin:0;padding-left:16px;font-size:12px;color:#991b1b;">${conflictList}</ul>
      </div>
    `;
  }
  
  return `
    <div class="card" style="position:relative;">
      <div class="card-row">
        <span style="font-weight:bold;font-size:15px;">${esc(record.workerName)}</span>
        <span style="${statusClass};padding:3px 8px;border-radius:4px;font-size:12px;font-weight:bold;">${statusLabel}</span>
        <span style="background:#e0e7ff;color:#4338ca;padding:3px 8px;border-radius:4px;font-size:12px;">${typeLabel}</span>
        ${conflicts.length > 0 ? `<span style="background:#fef2f2;color:#dc2626;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:8px;">⚠ ${conflicts.length}冲突</span>` : ""}
      </div>
      <div class="card-row">
        <span>📅 ${esc(record.startDate)} ${record.startTime ? `${record.startTime} ` : ''}→ ${esc(record.endDate)} ${record.endTime ? `${record.endTime}` : ''}</span>
      </div>
      ${record.reason ? `<div class="card-row" style="color:var(--muted);font-size:13px;">📝 ${esc(record.reason)}</div>` : ""}
      ${conflictInfo}
      ${record.reviewNote ? `<div class="card-row" style="color:#f59e0b;font-size:13px;">💬 ${esc(record.reviewNote)}</div>` : ""}
      ${record.reviewerName ? `<div class="card-row" style="color:var(--muted);font-size:12px;">审批人：${esc(record.reviewerName)}</div>` : ""}
      <div class="card-actions">
        ${showActions && perm.manageLeaves() ? `
          ${record.status === "pending" ? `
            <button class="btn small" onclick="approveLeave('${record.id}')">批准</button>
            <button class="btn small danger" onclick="rejectLeave('${record.id}')">拒绝</button>
          ` : ""}
          ${record.status === "approved" ? `
            <button class="btn small warning" onclick="withdrawLeave('${record.id}')">撤回批准</button>
          ` : ""}
          ${record.status === "rejected" ? `
            <button class="btn small danger" onclick="deleteLeaveRecord('${record.id}')">删除</button>
          ` : ""}
        ` : ""}
        ${record.status === "pending" && record.workerId === currentProfile.id ? `
          <button class="btn small warning" onclick="withdrawLeave('${record.id}')">撤回</button>
        ` : ""}
        <button class="btn small" onclick="showLeaveDetail('${record.id}')">详情</button>
      </div>
    </div>
  `;
}

function formatLeaveTimeType(type) {
  if (type === "all") return "全天";
  if (type === "morning") return "上午";
  if (type === "afternoon") return "下午";
  return "自定义";
}

async function approveLeave(id) {
  const record = getLeaveRecord(id);
  if (!record) return;
  
  if (!perm.manageLeaves()) {
    toast("权限不足，无法审批请假");
    return;
  }
  
  const conflicts = checkLeaveProjectConflict(record.workerId, record.startDate, record.endDate, record.startTime, record.endTime);
  if (conflicts.length > 0) {
    const conflictMsg = conflicts.map(p => {
      const store = getStore(p.storeId);
      const storeName = store ? store.name : "未知门店";
      return `• ${p.name}（${storeName}）`;
    }).join("\n");
    
    if (!(await confirmDialog(`⚠️ 警告：<br><br>该员工在此时间段有 ${conflicts.length} 个项目排期冲突！<br><br>冲突项目：<br>${conflictMsg.replace(/\n/g, "<br>")}<br><br>批准后可能导致项目延期或人员调配困难，确认批准吗？`, "排期冲突"))) {
      return;
    }
  }
  
  await repo.saveLeaveRecord({
    ...record,
    status: "approved",
    reviewerId: currentUser?.id || null,
    reviewerName: currentUser?.email || "系统",
    reviewedAt: new Date().toISOString(),
  }, id);
  await repo.loadAll();
  logOperation("LEAVE_APPROVE", `${record.workerName}的${LEAVE_TYPE_LABEL[record.leaveType]}`, `时间段：${record.startDate}~${record.endDate}`);
  renderLeaves();
  toast(`已批准 ${record.workerName} 的请假申请`);
  
  notify("请假审批结果", `${record.workerName} 的 ${LEAVE_TYPE_LABEL[record.leaveType]} 已被批准`);
}

async function rejectLeave(id) {
  const record = getLeaveRecord(id);
  if (!record) return;
  
  if (!perm.manageLeaves()) {
    toast("权限不足，无法审批请假");
    return;
  }
  
  const note = await promptDialog("请输入拒绝原因：", "拒绝申请");
  if (!note) return;
  
  await repo.saveLeaveRecord({
    ...record,
    status: "rejected",
    reviewNote: note,
    reviewerId: currentUser?.id || null,
    reviewerName: currentUser?.email || "系统",
    reviewedAt: new Date().toISOString(),
  }, id);
  await repo.loadAll();
  logOperation("LEAVE_REJECT", `${record.workerName}的${LEAVE_TYPE_LABEL[record.leaveType]}`, `时间段：${record.startDate}~${record.endDate}，原因：${note}`);
  renderLeaves();
  toast(`已拒绝 ${record.workerName} 的请假申请`);
  
  notify("请假审批结果", `${record.workerName} 的 ${LEAVE_TYPE_LABEL[record.leaveType]} 已被拒绝`);
}

async function withdrawLeave(id) {
  const record = getLeaveRecord(id);
  if (!record) return;
  
  if (record.status === "approved") {
    if (!(await confirmDialog(`确定要撤回 ${record.workerName} 的 ${LEAVE_TYPE_LABEL[record.leaveType]} 批准吗？`, "撤回批准"))) return;
    record.status = "pending";
    record.reviewNote = "";
    record.reviewerId = "";
    record.reviewerName = "";
    record.reviewedAt = null;
    await repo.saveLeaveRecord(record, id);
    logOperation("LEAVE_WITHDRAW", `${record.workerName}的${LEAVE_TYPE_LABEL[record.leaveType]}`, `管理员撤回批准，时间段：${record.startDate}~${record.endDate}`);
    renderAll();
    toast("请假批准已撤回，状态已改为待审批");
  } else {
    if (!(await confirmDialog(`确定要撤回您的 ${LEAVE_TYPE_LABEL[record.leaveType]} 申请吗？`, "撤回申请"))) return;
    await repo.deleteLeaveRecord(id);
    logOperation("LEAVE_WITHDRAW", `${record.workerName}的${LEAVE_TYPE_LABEL[record.leaveType]}`, `时间段：${record.startDate}~${record.endDate}`);
    renderAll();
    toast("请假申请已撤回");
  }
}

function showLeaveDetail(id) {
  const record = getLeaveRecord(id);
  if (!record) return;
  
  const typeLabel = LEAVE_TYPE_LABEL[record.leaveType] || record.leaveType;
  const statusLabel = LEAVE_STATUS_LABEL[record.status] || record.status;
  
  const conflicts = checkLeaveProjectConflict(record.workerId, record.startDate, record.endDate);
  
  const modalContent = `
    <div class="repair-form">
      <div class="form-row">
        <label>施工人员</label>
        <div class="input" style="background:#f3f4f6;">${esc(record.workerName)}</div>
      </div>
      <div class="form-row">
        <label>请假类型</label>
        <div class="input" style="background:#f3f4f6;">${typeLabel}</div>
      </div>
      <div class="form-row">
        <label>状态</label>
        <div class="input" style="background:#f3f4f6;">${statusLabel}</div>
      </div>
      <div class="form-row">
        <label>请假时间</label>
        <div class="input" style="background:#f3f4f6;">${esc(record.startDate)} ${formatLeaveTimeType(record.startType)} → ${esc(record.endDate)} ${formatLeaveTimeType(record.endType)}</div>
      </div>
      ${record.startTime ? `
      <div class="form-row">
        <label>具体开始时间</label>
        <div class="input" style="background:#f3f4f6;">${esc(record.startTime)}</div>
      </div>` : ""}
      ${record.endTime ? `
      <div class="form-row">
        <label>具体结束时间</label>
        <div class="input" style="background:#f3f4f6;">${esc(record.endTime)}</div>
      </div>` : ""}
      <div class="form-row">
        <label>请假原因</label>
        <div class="input" style="background:#f3f4f6;min-height:60px;">${record.reason || "未填写"}</div>
      </div>
      ${conflicts.length > 0 ? `
      <div class="form-row" style="background:#fef2f2;border-left:3px solid #dc2626;padding:10px;border-radius:4px;">
        <span style="font-weight:bold;color:#dc2626;">⚠️ 项目排期冲突：</span>
        <div>${conflicts.map(p => `• ${esc(p.name)}`).join("<br/>")}</div>
      </div>` : ""}
      ${record.reviewNote ? `
      <div class="form-row">
        <label>审批意见</label>
        <div class="input" style="background:#fef3c7;">${esc(record.reviewNote)}</div>
      </div>` : ""}
      ${record.reviewerName ? `
      <div class="form-row">
        <label>审批人</label>
        <div class="input" style="background:#f3f4f6;">${esc(record.reviewerName)}</div>
      </div>` : ""}
      <div class="form-actions">
        <button class="btn" onclick="modal.close()">关闭</button>
      </div>
    </div>
  `;
  
  modal.open(`📅 ${record.workerName} 的请假详情`, modalContent);
}

document.addEventListener("DOMContentLoaded", function() {
  const statusFilter = document.getElementById("leaveStatusFilter");
  const typeFilter = document.getElementById("leaveTypeFilter");
  const workerFilter = document.getElementById("leaveWorkerFilter");
  
  if (statusFilter) statusFilter.addEventListener("change", renderLeaves);
  if (typeFilter) typeFilter.addEventListener("change", renderLeaves);
  if (workerFilter) workerFilter.addEventListener("change", renderLeaves);
});

/* ============================================================
 * 日历统计视图
 * ============================================================ */
let calMonth = new Date(); calMonth.setDate(1); calMonth.setHours(0, 0, 0, 0);
let calSelectedDate = dateKey(new Date());
let calViewMode = "timeline"; /* "calendar" | "timeline" */

function dateKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  const date = new Date(d);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/* 某天的预约（按开始时间排序） */
function projectsOnDate(ds) {
  return cache.projects
    .filter((p) => { 
      const s = projectStart(p); 
      return s && dateKey(s) === ds;
    })
    .sort((a, b) => projectStart(a) - projectStart(b));
}

const STATUS_DOT = {
  [STATUS.BOOKED]: "booked",
  [STATUS.WORKING]: "working",
  [STATUS.PAUSED]: "paused",
  [STATUS.DELAYED]: "delayed",
  [STATUS.DONE]: "done",
  [STATUS.ACCEPTED]: "accepted",
  [STATUS.REVIEWED]: "reviewed",
  [STATUS.CANCELLED]: "cancelled",
};

function renderCalendar() {
  const grid = document.getElementById("calGrid");
  const weekdaysEl = document.getElementById("calWeekdays");
  if (!grid || !weekdaysEl) return;
  
  grid.style.display = "";
  grid.style.gridTemplateColumns = "";
  grid.style.gap = "";

  const label = document.getElementById("calLabel");

  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  if (label) label.textContent = `${year} 年 ${month + 1} 月`;

  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(new Date());

  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  weekdaysEl.innerHTML = weekdays.map((w) => `<div class="cal-wd">${w}</div>`).join("");

  let cells = "";

  const daysInPrevMonth = new Date(year, month, 0).getDate();
  for (let i = startWeekday - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i;
    cells += `<div class="cal-cell other-month">${day}</div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = dateKey(new Date(year, month, day));
    const items = projectsOnDate(ds);
    const isToday = ds === todayKey;
    const isSelected = ds === calSelectedDate;
    const isHolidayDate = isHoliday(ds);
    const holidayIcon = isHolidayDate ? "🎊" : "";
    const evHtml = items.slice(0, 3).map((p) => {
      const isRepair = p.repairOrder && p.repairOrder.status === "待维修";
      const dotClass = isRepair ? "repair" : (STATUS_DOT[p.status] || "");
      const prefix = isRepair ? "🔧" : "";
      return `<div class="cal-ev"><span class="dot ${dotClass}"></span>${prefix}${esc(p.name)}</div>`;
    }).join("");
    const more = items.length > 3 ? `<div class="cal-more">+${items.length - 3} 更多</div>` : "";
    const countBadge = items.length ? `<span class="cal-count">${items.length}</span>` : "";
    const totalHours = items.reduce((sum, p) => sum + (p.estimatedHours || 0), 0);
    /* 工时阈值着色：>40 严重超载(红)，>32 工时排满(橙)，其余默认蓝 */
    let hoursClass = "cal-hours";
    if (totalHours > 40) hoursClass += " danger";
    else if (totalHours > 32) hoursClass += " warn";
    const hoursHtml = totalHours > 0 ? `<div class="${hoursClass}" title="当天预约工时 ${totalHours}h">${totalHours}h</div>` : "";
    cells += `
      <div class="cal-cell ${items.length ? "has" : ""} ${isToday ? "today" : ""} ${isSelected ? "selected" : ""} ${isHolidayDate ? "holiday" : ""}" onclick="selectCalDay('${ds}');">
        <div class="cal-daynum">${day}${countBadge}${holidayIcon}</div>
        ${evHtml}${more}${hoursHtml}
      </div>`;
  }

  const totalCells = cells.split("</div>").filter(Boolean).length;
  const remainingCells = (Math.ceil(totalCells / 7) * 7) - totalCells;
  for (let i = 1; i <= remainingCells; i++) {
    cells += `<div class="cal-cell other-month">${i}</div>`;
  }

  grid.innerHTML = cells;
  renderCalDay();
}

function selectCalDay(ds) {
  calSelectedDate = ds;
  renderCalendar();
}

function renderCalDay() {
  const box = document.getElementById("calDayDetail");
  if (!box) return;

  if (calViewMode === "timeline") {
    renderTimelineInDetail();
    return;
  }

  document.body.classList.remove("timeline-view");
  document.body.classList.remove("stats-view");
  document.removeEventListener("click", timelineCloseAllTasks);
  closeTimelineActionMenu();

  if (!calSelectedDate) {
    box.innerHTML = `<p class="hint">点击上方某一天，查看当天各时间段的预约、项目进度与安装人员安排。</p>`;
    return;
  }
  const items = projectsOnDate(calSelectedDate);
  if (!items.length) {
    box.innerHTML = `<div class="detail-block"><h3>📅 ${esc(calSelectedDate)}</h3><p class="hint" style="margin:0">当天暂无预约。</p></div>`;
    return;
  }
  const totalEst = items.reduce((sum, p) => sum + (p.estimatedHours || 0), 0);
  const totalAct = items.reduce((sum, p) => sum + (p.actualHours || 0), 0);
  const workerHours = {};
  items.forEach((p) => {
    (p.workLogs || []).forEach((log) => {
      const name = log.workerName || "未知";
      workerHours[name] = (workerHours[name] || 0) + (log.hours || 0);
    });
  });

  /* 时段重复预约检测：计算每个项目同时段重叠数（含自身），并找出最大并发数。
   * 仅对具备有效开始/结束时间的项目计算；无结束时间的项目视为"瞬时点"。
   * 外协任务和已完成项目不参与并发计算。 */
  const overlapCount = new Array(items.length).fill(0);
  let maxConcurrency = 0;
  for (let i = 0; i < items.length; i++) {
    if (isOutsourced(items[i])) continue;
    if (isCompleted(items[i])) continue;
    const si = projectStart(items[i]), ei = projectEnd(items[i]);
    if (!si) continue;
    const eiEff = ei || si;
    let cnt = 1;
    for (let j = 0; j < items.length; j++) {
      if (j === i) continue;
      if (isOutsourced(items[j])) continue;
      if (isCompleted(items[j])) continue;
      const sj = projectStart(items[j]), ej = projectEnd(items[j]);
      if (!sj) continue;
      const ejEff = ej || sj;
      if (intervalsOverlap(si, eiEff, sj, ejEff)) cnt++;
    }
    overlapCount[i] = cnt;
    if (cnt > maxConcurrency) maxConcurrency = cnt;
  }

  const rows = items.map((p, idx) => {
    const isDoneOrReviewed = (p.status === STATUS.DONE || p.status === STATUS.REVIEWED || p.status === STATUS.ACCEPTED);
    let workersHtml;
    if (isDoneOrReviewed) {
      const actualWorkers = new Set();
      (p.workLogs || []).forEach((l) => {
        if (l.workerName) actualWorkers.add(l.workerName);
      });
      workersHtml = actualWorkers.size
        ? Array.from(actualWorkers).map((nm) => `<span class="assign-chip">${esc(nm)}</span>`).join("")
        : `<span class="hint" style="margin:0">暂无施工记录</span>`;
    } else {
      workersHtml = (p.assignedWorkerIds || []).map((wid) => {
        const w = getWorker(wid);
        const nm = w ? w.name : "(已删除)";
        const conf = assignConflicts(p, wid).length;
        return `<span class="assign-chip ${conf ? "conflict" : ""}">${conf ? "⚠ " : ""}${esc(nm)}</span>`;
      }).join("") || `<span class="hint" style="margin:0">未分配</span>`;
    }
    const workerLabel = isDoneOrReviewed ? "施工人员" : "安装人员";
    const { est, act, hasActual } = hoursDiff(p);
    const concur = overlapCount[idx];
    const concurTag = concur >= 3
      ? `<span class="concur-tag danger" title="该时段有 ${concur} 个项目同时预约">⏰ ${concur} 并发</span>`
      : (concur >= 2 ? `<span class="concur-tag warn" title="该时段有 ${concur} 个项目同时预约">${concur} 并发</span>` : "");
    return `
      <div class="cal-detail-item ${concur >= 3 ? "item-conflict" : ""}">
        <div class="cal-detail-time">${esc(fmtTimeRange(p))}${concurTag}</div>
        <div class="cal-detail-main">
          <div class="cal-detail-title"><b>${esc(p.name)}</b> <span class="badge ${p.status}">${p.status}</span></div>
          <div class="cal-detail-sub">${esc(storeName(p.storeId))} · 客户 ${esc(p.customer || "—")} · 预计 ${est} / 实际 ${hasActual ? act : "—"} 小时</div>
          <div class="cal-detail-workers">${workerLabel}：${workersHtml}</div>
        </div>
        <button class="btn small primary" onclick="gotoConstruction('${p.id}')">施工管理</button>
      </div>`;
  }).join("");

  /* 工时超载提示：>40 严重超载需外协；>32 工时排满需全员加班 */
  const alerts = [];
  if (totalEst > 40) {
    alerts.push(`<div class="cal-alert danger">⚠ <b>工时严重超载（${totalEst}h）</b>：施工人员加班可能都完不成，建议安排外协或拆分到其他日期。</div>`);
  } else if (totalEst > 32) {
    alerts.push(`<div class="cal-alert warn">⚠ <b>工时排满（${totalEst}h）</b>：可能需要全员加班才能完成，请提前协调人员。</div>`);
  }
  if (maxConcurrency >= 3) {
    alerts.push(`<div class="cal-alert warn">⏰ <b>时段冲突</b>：当天有 <b>${maxConcurrency}</b> 个项目在同一时间段重复预约，可能需要外协或增加人员，建议错峰安排。</div>`);
  }
  const alertsHtml = alerts.length ? `<div class="cal-alerts">${alerts.join("")}</div>` : "";

  const workerStatsText = Object.keys(workerHours).length > 0 ? ` · 👷 ${Object.entries(workerHours).map(([name, hours]) => `${esc(name)}${hours}h`).join("、")}` : "";
  /* 汇总栏工时数值也按阈值着色 */
  let estColorStyle = "";
  if (totalEst > 40) estColorStyle = "color:var(--danger)";
  else if (totalEst > 32) estColorStyle = "color:var(--warn)";
  box.innerHTML = `
    <div class="detail-block">
      <h3>📅 ${esc(calSelectedDate)}（当天 ${items.length} 个预约）</h3>
      <div class="cal-summary-bar">总预计工时 <b style="${estColorStyle}">${totalEst}h</b> / 总实际工时 ${totalAct > 0 ? totalAct + 'h' : '—'}${workerStatsText}</div>
      ${alertsHtml}
      <div class="cal-detail-list">${rows}</div>
    </div>`;
}

function calPrevMonth() { 
  calViewMode = "calendar";
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); 
  renderCalendar(); 
}
function calNextMonth() { 
  calViewMode = "calendar";
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); 
  renderCalendar(); 
}
function calGotoToday() {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
  calMonth = d;
  calSelectedDate = dateKey(new Date());
  calViewMode = "timeline";
  renderCalendar();
}

function toggleCalView() {
  calViewMode = calViewMode === "calendar" ? "timeline" : "calendar";
  renderCalendar();
}

/* 时间线视图 - 水平时间轴，工作时段 8:00-18:00，超范围代表加班 */
const TL_VIEW_START_HOUR = 6;   /* 时间轴显示起点 */
const TL_VIEW_END_HOUR = 22;    /* 时间轴显示终点 */
const TL_WORK_START_HOUR = 8;   /* 工作时段起点 */
const TL_WORK_END_HOUR = 18;    /* 工作时段终点 */
let TL_ACTUAL_HOUR_WIDTH = 90;  /* 实际渲染使用的每小时像素宽度 */
const TL_LANE_HEIGHT = 85;      /* 每行任务高度 */

function renderTimelineInDetail() {
  const grid = document.getElementById("calGrid");
  const weekdaysEl = document.getElementById("calWeekdays");
  const detailBox = document.getElementById("calDayDetail");
  const label = document.getElementById("calLabel");

  if (!grid || !weekdaysEl || !detailBox) return;

  document.body.classList.add("timeline-view");

  if (label) label.textContent = `${calSelectedDate} 时间线视图`;

  const items = projectsOnDate(calSelectedDate);
  const totalHours = TL_VIEW_END_HOUR - TL_VIEW_START_HOUR;
  const containerWidth = window.innerWidth - 60;
  const minHourWidth = window.innerWidth < 768 ? 40 : 50;
  
  let requiredHourWidth = Math.max(minHourWidth, Math.floor(containerWidth / totalHours));
  
  items.forEach((p) => {
    const start = projectStart(p);
    const end = projectEnd(p) || new Date((start || new Date()).getTime() + (p.estimatedHours || 2) * 3600000);
    if (!start) return;
    const duration = (end - start) / 3600000;
    const effectiveDuration = Math.max(1, duration);
    const minDisplayWidth = 100;
    const neededHourWidth = effectiveDuration > 0 ? Math.ceil(minDisplayWidth / effectiveDuration) : minHourWidth;
    if (neededHourWidth > requiredHourWidth) {
      requiredHourWidth = neededHourWidth;
    }
  });
  
  const hourWidth = requiredHourWidth;
  TL_ACTUAL_HOUR_WIDTH = hourWidth;
  const totalWidth = totalHours * hourWidth;

  const hasInternalWorker = (p) => (p.assignedWorkerIds || []).length > 0;
  const hasOutsourced = (p) => (p.outsourcedWorkers || "").trim().length > 0;
  
  const statEstHours = items.reduce((sum, p) => sum + (p.estimatedHours || 0), 0);
  const statActHours = items.reduce((sum, p) => sum + (p.actualHours || 0), 0);
  const statInternalHours = items.filter(hasInternalWorker).reduce((sum, p) => sum + (p.estimatedHours || 0), 0);
  const statOutsourcedHours = items.reduce((sum, p) => sum + Math.max(p.outsourcedHours, p.outsourcedHoursFromLogs) || 0, 0);
  const statOutsourcedWorkers = items.reduce((total, p) => {
    if (!hasOutsourced(p)) return total;
    const workers = p.outsourcedWorkers.split(',').map(w => w.trim()).filter(w => w.length > 0);
    return total + workers.length;
  }, 0);
  
  const statOvertime = items.filter((p) => {
    const start = projectStart(p);
    const end = projectEnd(p) || new Date((start || new Date()).getTime() + (p.estimatedHours || 2) * 3600000);
    if (!start) return false;
    const startH = start.getHours() + start.getMinutes() / 60;
    const endH = end.getHours() + end.getMinutes() / 60;
    return (startH < TL_WORK_START_HOUR - 10/60) || (endH > TL_WORK_END_HOUR + 10/60) ||
           startH >= TL_WORK_END_HOUR || endH <= TL_WORK_START_HOUR;
  }).length;
  
  const conflictInfo = {};
  let statConflict = 0;
  items.forEach((p) => {
    if (!hasInternalWorker(p)) return;
    if (isCompleted(p)) return;
    const conflicts = (p.assignedWorkerIds || []).reduce((total, wid) => {
      return total + assignConflicts(p, wid).length;
    }, 0);
    if (conflicts > 0) {
      statConflict++;
      const conflictWorkers = (p.assignedWorkerIds || []).filter((wid) => {
        return assignConflicts(p, wid).length > 0;
      }).map((wid) => {
        const w = getWorker(wid);
        return w ? w.name : wid;
      });
      conflictInfo[p.id] = conflictWorkers;
    }
  });

  let timelineHtml = "";
  if (!items.length) {
    timelineHtml = `
      <div class="timeline-container">
        <div class="timeline-empty">
          <div class="timeline-empty-icon">📅</div>
          <div class="timeline-empty-text">${esc(calSelectedDate)} 暂无预约任务</div>
        </div>
      </div>`;
  } else {
    const hourMarks = [];
    for (let h = TL_VIEW_START_HOUR; h <= TL_VIEW_END_HOUR; h++) {
      const isWorkHour = h >= TL_WORK_START_HOUR && h <= TL_WORK_END_HOUR;
      hourMarks.push(`<div class="tl-hour-mark ${isWorkHour ? "work" : "overtime"}" style="left:${(h - TL_VIEW_START_HOUR) * hourWidth}px">${String(h).padStart(2, "0")}:00</div>`);
    }

    const lanes = [];
    const itemLane = {};
    items.forEach((p) => {
      const s = projectStart(p);
      const e = projectEnd(p) || new Date(s.getTime() + (p.estimatedHours || 2) * 3600000);
      const startMs = s.getTime(), endMs = e.getTime();
      let laneIdx = lanes.findIndex((lastEnd) => lastEnd <= startMs);
      if (laneIdx === -1) { laneIdx = lanes.length; lanes.push(endMs); }
      else lanes[laneIdx] = endMs;
      itemLane[p.id] = laneIdx;
    });
    const laneCount = Math.max(1, lanes.length);

    const workBgLeft = (TL_WORK_START_HOUR - TL_VIEW_START_HOUR) * hourWidth;
    const workBgWidth = (TL_WORK_END_HOUR - TL_WORK_START_HOUR) * hourWidth;
    const otRightLeft = workBgLeft + workBgWidth;
    const otRightWidth = totalWidth - otRightLeft;

    const tasksHtml = items.map((p) => {
      const start = projectStart(p);
      const end = projectEnd(p) || new Date(start.getTime() + (p.estimatedHours || 2) * 3600000);
      if (!start) return "";

      const startHourOffset = (start.getHours() + start.getMinutes() / 60) - TL_VIEW_START_HOUR;
      const duration = (end - start) / 3600000;
      const left = startHourOffset * hourWidth;
      const width = Math.max(80, duration * hourWidth);
      const top = itemLane[p.id] * TL_LANE_HEIGHT;

      const startH = start.getHours() + start.getMinutes() / 60;
      const endH = end.getHours() + end.getMinutes() / 60;
      const isOvertime = (startH < TL_WORK_START_HOUR - 10/60) || (endH > TL_WORK_END_HOUR + 10/60) ||
                         startH >= TL_WORK_END_HOUR || endH <= TL_WORK_START_HOUR;

      const hasInternal = (p.assignedWorkerIds || []).length > 0;
      const isOutsourcedTask = isOutsourced(p);
      const statusClass = isOutsourcedTask ? "timeline-task-outsourced" :
                         p.status === STATUS.WORKING ? "timeline-task-working" :
                         p.status === STATUS.DONE ? "timeline-task-done" :
                         p.status === STATUS.ACCEPTED ? "timeline-task-accepted" :
                         p.status === STATUS.CANCELLED ? "timeline-task-cancelled" :
                         "timeline-task-default";

      const conflicts = hasInternal && !isCompleted(p) ? (p.assignedWorkerIds || []).reduce((total, wid) => {
        return total + assignConflicts(p, wid).length;
      }, 0) : 0;
      const conflictClass = conflicts >= 1 ? "timeline-task-conflict" : "";
      const overtimeClass = isOvertime ? "timeline-task-overtime" : "";
      const canDrag = p.status === STATUS.BOOKED;
      const dragAttr = canDrag
        ? `draggable="true" ondragstart="timelineDragStart(event)" ondragend="timelineDragEnd(event)" onmousedown="timelineDragMouseDown(event)"`
        : `draggable="false"`;
      const lockClass = canDrag ? "" : "timeline-task-locked";
      
      const isOverdue = p.status === STATUS.BOOKED && !p.startedAt && new Date() > end;
      const overdueClass = isOverdue ? "timeline-task-overdue" : "";

      const pad = (n) => String(n).padStart(2, "0");
      const timeStr = `${pad(start.getHours())}:${pad(start.getMinutes())} ~ ${pad(end.getHours())}:${pad(end.getMinutes())}`;
      let workers = (p.assignedWorkerIds || []).map((wid) => { const w = getWorker(wid); return w ? w.name : "未分配"; }).join("、");
      if (p.outsourcedWorkers) {
        workers = workers ? `${workers} / ${p.outsourcedWorkers}` : p.outsourcedWorkers;
      }
      workers = workers || "未分配";

      return `
        <div class="timeline-task ${statusClass} ${conflictClass} ${overtimeClass} ${lockClass} ${overdueClass}"
             ${dragAttr}
             data-project-id="${p.id}"
             data-start="${start.toISOString()}"
             data-end="${end.toISOString()}"
             data-original-left="${left}"
             style="left: ${left}px; width: ${width}px; top: ${top}px; height: ${TL_LANE_HEIGHT - 8}px;"
             onmousedown="timelineTaskMouseDown(event)"
             ontouchstart="timelineTouchStart(event)"
             ontouchmove="timelineTouchMove(event)"
             ontouchend="timelineTouchEnd(event)"
             onclick="timelineTaskClick(event, '${p.id}')">
          <div class="timeline-task-header">
            <span class="timeline-task-name">${esc(p.name)}</span>
            <div class="timeline-task-badges">
              <span class="timeline-task-status">${p.status}</span>
              ${p.repairOrder && p.repairOrder.status === "待维修" ? `<span class="timeline-task-repair-badge">🔧 维修</span>` : ""}
              ${isOverdue ? `<span class="timeline-task-overdue-badge">🔴 超期</span>` : ""}
              ${hasOutsourced(p) ? `<span class="timeline-task-outsourced-badge">🤝 外协</span>` : ""}
              ${p.timeModified ? `<span class="timeline-task-modified-badge">✏️ 已改点</span>` : ""}
              ${isOvertime ? `<span class="timeline-task-overtime-badge">🌙 加班</span>` : ""}
              ${conflicts >= 1 ? `<span class="timeline-task-conflict-badge">⚠ ${conflicts} 冲突</span>` : ""}
            </div>
          </div>
          <div class="timeline-task-info">
            <span>${timeStr}</span>
            <span>${p.estimatedHours}人·小时/${(p.assignedWorkerIds && p.assignedWorkerIds.length) || p.workerCount || 1}人</span>
            <span>${p.estimatedHours > 0 ? (p.estimatedHours / ((p.assignedWorkerIds && p.assignedWorkerIds.length) || p.workerCount || 1)).toFixed(1) : "—"}h</span>
          </div>
          <div class="timeline-task-workers">👤 ${esc(workers)}</div>
        </div>`;
    }).join("");

    timelineHtml = `
      <div class="timeline-container timeline-horizontal">
        <div class="tl-stats">
          <span class="tl-stat-item"><span class="tl-stat-label">总预计工时</span><span class="tl-stat-value ${statEstHours > 40 ? 'danger' : statEstHours > 32 ? 'warn' : ''}">${statEstHours}h</span></span>
          <span class="tl-stat-item"><span class="tl-stat-label">施工人员工时</span><span class="tl-stat-value ${statInternalHours > 40 ? 'danger' : statInternalHours > 32 ? 'warn' : ''}">${statInternalHours}h</span></span>
          <span class="tl-stat-item"><span class="tl-stat-label">外协工时</span><span class="tl-stat-value outsourced">${statOutsourcedHours}h</span></span>
          <span class="tl-stat-item"><span class="tl-stat-label">外协人员</span><span class="tl-stat-value outsourced">${statOutsourcedWorkers}人</span></span>
          <span class="tl-stat-item"><span class="tl-stat-label">实际工时</span><span class="tl-stat-value">${statActHours}h</span></span>
          <span class="tl-stat-item"><span class="tl-stat-label">加班项目</span><span class="tl-stat-value ${statOvertime > 0 ? 'warn' : ''}">${statOvertime}个</span></span>
          <span class="tl-stat-item"><span class="tl-stat-label">人员冲突</span><span class="tl-stat-value ${statConflict > 0 ? 'danger' : ''}">${statConflict > 0 ? statConflict + '个 (' + [...new Set(Object.values(conflictInfo).flat())].join('、') + ')' : statConflict + '个'}</span></span>
        </div>
        <div class="tl-legend">
          <span class="tl-legend-item"><span class="tl-legend-box work"></span>工作时间 8:00-18:00</span>
          <span class="tl-legend-item"><span class="tl-legend-box overtime"></span>加班区（需协调）</span>
          <span class="tl-legend-item">💡 仅"预约中"状态可拖动调整时间</span>
          <span class="tl-legend-item">🖱️ 点击任务查看详情和操作</span>
        </div>
        <div class="tl-scroll">
          <div class="tl-axis" style="width:${totalWidth}px;">
            ${hourMarks.join("")}
          </div>
          <div class="tl-body" id="timelineMain" style="width:${totalWidth}px; height:${laneCount * TL_LANE_HEIGHT}px;"
             ondragover="timelineDragOver(event)" ondragenter="timelineDragEnter(event)" ondragleave="timelineDragLeave(event)">
            <div class="tl-bg-work" style="left:${workBgLeft}px; width:${workBgWidth}px; height:100%;"></div>
            <div class="tl-bg-overtime tl-bg-ot-left" style="width:${workBgLeft}px; height:100%;"></div>
            <div class="tl-bg-overtime tl-bg-ot-right" style="left:${otRightLeft}px; width:${otRightWidth}px; height:100%;"></div>
            <div class="tl-grid-lines">
              ${(() => {
                let lines = "";
                for (let h = TL_VIEW_START_HOUR; h <= TL_VIEW_END_HOUR; h++) {
                  lines += `<div class="tl-grid-line" style="left:${(h - TL_VIEW_START_HOUR) * hourWidth}px"></div>`;
                }
                return lines;
              })()}
            </div>
            <div class="tl-tasks">${tasksHtml}</div>
            <div class="tl-drag-hint" id="tlDragHint" style="display:none;"></div>
          </div>
        </div>
        ${(() => {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const leaveInfo = [];
          for (let i = 0; i < 3; i++) {
            const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            const leaves = cache.leaveRecords.filter((lr) => {
              if (lr.status === "rejected") return false;
              const sd = new Date(lr.startDate);
              sd.setHours(0, 0, 0, 0);
              const ed = new Date(lr.endDate);
              ed.setHours(0, 0, 0, 0);
              return d >= sd && d <= ed;
            });
            if (leaves.length > 0) {
              leaveInfo.push(`<div class="tl-leave-item"><span class="tl-leave-date">${dateStr}</span><span class="tl-leave-workers">${leaves.map(l => `${l.workerName} ${formatLeaveTime(l)}`).join("、")}</span></div>`);
            }
          }
          if (leaveInfo.length === 0) return "";
          return `<div class="tl-leave-section"><div class="tl-leave-header">🌴 近期请假人员</div><div class="tl-leave-list">${leaveInfo.join("")}</div></div>`;
        })()}
      </div>`;
  }

  if (detailBox) detailBox.innerHTML = timelineHtml;

  setTimeout(() => {
    document.addEventListener("click", timelineCloseAllTasks);
  }, 0);
}

let draggedTask = null;
let timelineMouseDown = null;
let mouseDragEnded = false;

/* 记录鼠标按下位置，用于区分点击和拖拽 */
function timelineTaskMouseDown(e) {
  timelineMouseDown = { x: e.clientX, y: e.clientY, time: Date.now() };
}

/* 点击任务卡片：弹出浮动操作菜单 */
function timelineTaskClick(e, projectId) {
  if (mouseDragEnded) {
    mouseDragEnded = false;
    return;
  }
  
  if (!timelineMouseDown) {
    openTimelineActionMenu(e.currentTarget, projectId);
    timelineMouseDown = null;
    return;
  }
  
  const deltaX = Math.abs(e.clientX - timelineMouseDown.x);
  const deltaY = Math.abs(e.clientY - timelineMouseDown.y);
  const timeDiff = Date.now() - timelineMouseDown.time;
  
  timelineMouseDown = null;
  
  if (deltaX > 10 || deltaY > 10) return;
  
  if (timeDiff > 300 && (deltaX > 5 || deltaY > 5)) return;

  if (e.target.closest(".tl-action-menu")) return;

  openTimelineActionMenu(e.currentTarget, projectId);
}

/* 打开时间线任务浮动菜单（可被程序化调用） */
function openTimelineActionMenu(taskEl, projectId) {
  const p = getProject(projectId);
  if (!p) return;

  /* 关闭已有菜单 */
  closeTimelineActionMenu();

  /* 高亮当前任务 */
  document.querySelectorAll(".timeline-task-active").forEach((t) => t.classList.remove("timeline-task-active"));
  taskEl.classList.add("timeline-task-active");

  /* 构建浮动菜单 */
  const menu = document.createElement("div");
  menu.className = "tl-action-menu";
  menu.id = "tlActionMenu";

  const start = projectStart(p);
  const end = projectEnd(p);
  const pad = (n) => String(n).padStart(2, "0");
  const timeStr = start
    ? `${pad(start.getHours())}:${pad(start.getMinutes())} ~ ${end ? `${pad(end.getHours())}:${pad(end.getMinutes())}` : "?"}`
    : "—";
  const workers = (p.assignedWorkerIds || []).map((wid) => { const w = getWorker(wid); return w ? w.name : "未分配"; }).join("、") || "未分配";

  const canAssign = perm.assignWorker(p);
  const assigned = p.assignedWorkerIds || [];
  const assignedChips = assigned.length
    ? assigned.map((wid) => {
        const w = getWorker(wid);
        const conflicts = assignConflicts(p, wid);
        return `<span class="tl-menu-assign-chip ${conflicts.length ? 'conflict' : ''}" title="${conflicts.length ? '时间冲突' : ''}">${w ? esc(w.name) : '(已删除)'}` +
               `${canAssign ? `<span class="tl-menu-assign-remove" onclick="timelineUnassignWorker('${p.id}', '${wid}')">✕</span>` : ''}</span>`;
      }).join("")
    : `<span class="tl-menu-assign-empty">未分配人员</span>`;
  
  const availableWorkers = cache.workers.filter((w) => !assigned.includes(w.id));
  const dateStr = start ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}` : null;
  const projStartTime = start ? `${pad(start.getHours())}:${pad(start.getMinutes())}` : null;
  const projEndTime = end ? `${pad(end.getHours())}:${pad(end.getMinutes())}` : null;
  const assignOpts = availableWorkers.map((w) => {
    const conflicts = assignConflicts(p, w.id);
    const leaveRecord = dateStr && isWorkerOnLeave(w.id, dateStr);
    const hasLeaveConflict = leaveRecord ? isLeaveConflict(leaveRecord, projStartTime, projEndTime) : false;
    const disabledAttr = hasLeaveConflict ? ' disabled' : '';
    let label = esc(w.name);
    if (hasLeaveConflict) label += ' 🌴请假';
    else if (conflicts.length) label += ' ⚠冲突';
    return `<option value="${w.id}"${disabledAttr}>${label}</option>`;
  }).join("");

  menu.innerHTML = `
    <div class="tl-menu-header">
      <span class="tl-menu-title">${esc(p.name)}</span>
      <span class="tl-menu-close" onclick="closeTimelineActionMenu()">✕</span>
    </div>
    <div class="tl-menu-info">
      <div><span>状态</span><b><span class="badge ${p.status}">${p.status}</span></b></div>
      <div><span>客户</span><b>${esc(p.customer || "—")}</b></div>
      <div><span>时间</span><b>${timeStr}</b></div>
      <div><span>工时</span><b>${p.estimatedHours || 0}h</b></div>
      <div><span>地址</span><b>${esc(p.address || "—")}</b></div>
    </div>
    ${canAssign ? `
    <div class="tl-menu-assign">
      <div class="tl-menu-assign-label">👤 安装人员</div>
      <div class="tl-menu-assign-list">${assignedChips}</div>
      ${availableWorkers.length ? `
      <div class="tl-menu-assign-form">
        <select class="input" id="tlMenuAssignSel" onchange="timelineQuickAssignWorker('${p.id}', this.value)">
          <option value="">选择人员分配</option>
          ${assignOpts}
        </select>
      </div>` : `<div class="tl-menu-assign-empty">暂无可选人员</div>`}
      <div class="tl-menu-outsourced">
        <div class="tl-menu-assign-label">🤝 外协人员</div>
        <div class="tl-menu-assign-list">${(p.outsourcedWorkers || "").split(/[,，]/).filter(n => n.trim()).map(n => `<span class="assign-chip outsourced"><span style="color:#8b5cf6">🤝</span> ${esc(n.trim())}<button class="chip-x" onclick="timelineRemoveOutsourcedWorker('${p.id}', '${(n.trim() || "").replace(/'/g, "\\'")}')" title="移除">✕</button></span>`).join("") || `<span class="hint" style="margin:0;font-size:11px">尚未添加外协人员</span>`}</div>
        ${cache.outsourcedWorkers.length > 0 ? `
        <div class="tl-menu-assign-form" style="margin-bottom:6px;">
          <select class="input" id="tlMenuOutsourcedSelect" onchange="timelineAddOutsourcedWorker('${p.id}', this.value)">
            <option value="">从常用外协人员列表添加</option>
            ${cache.outsourcedWorkers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}${w.phone ? ` (${esc(w.phone)})` : ''}</option>`).join("")}
          </select>
        </div>` : ""}
        <div class="tl-menu-assign-form">
          <input type="text" class="input" id="tlMenuOutsourcedInput" placeholder="输入外协姓名，回车添加" onkeydown="if(event.key==='Enter'){timelineAddOutsourcedWorkerByName('${p.id}', this.value);this.value=''}">
          <button class="btn small" onclick="timelineAddOutsourcedWorkerByName('${p.id}', document.getElementById('tlMenuOutsourcedInput').value)">添加</button>
        </div>
        ${p.outsourcedWorkers ? `<div class="tl-menu-outsourced-hint">已设置外协，不占用内部人员</div>` : ""}
      </div>
    </div>` : `<div class="tl-menu-info"><div><span>人员</span><b>${esc(workers)}</b></div></div>`}
    <div class="tl-menu-actions">
      <button class="btn small primary" onclick="closeTimelineActionMenu(); gotoConstruction('${p.id}')">施工管理</button>
      ${p.repairOrder && p.repairOrder.status === "待维修" && perm.completeRepair() ? `<button class="btn small" onclick="closeTimelineActionMenu(); completeRepair('${p.id}')">✅ 完成维修</button>` : ""}
      ${perm.editProject(p) ? `<button class="btn small" onclick="closeTimelineActionMenu(); editProject('${p.id}')">编辑</button>` : ""}
      ${perm.reviewProject(p) && !isReviewed(p) ? `<button class="btn small" onclick="closeTimelineActionMenu(); reviewProject('${p.id}')">审核</button>` : ""}
      ${perm.deleteProject(p) ? `<button class="btn small danger" onclick="closeTimelineActionMenu(); deleteProject('${p.id}')">删除</button>` : ""}
    </div>`;

  document.body.appendChild(menu);

  /* 定位菜单：显示在任务卡片下方 */
  const taskRect = taskEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = taskRect.left;
  let top = taskRect.bottom + 6;

  /* 防止超出右侧 */
  if (left + menuRect.width > window.innerWidth - 10) {
    left = window.innerWidth - menuRect.width - 10;
  }
  /* 防止超出底部：改为显示在上方 */
  if (top + menuRect.height > window.innerHeight - 10) {
    top = taskRect.top - menuRect.height - 6;
  }
  /* 确保不超出左侧 */
  if (left < 10) left = 10;

  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

/* 时间线快速分配安装人员 */
async function timelineQuickAssignWorker(pid, wid) {
  if (!wid) return;
  const p = getProject(pid);
  if (!p) return;
  const cur = p.assignedWorkerIds || [];
  if (cur.includes(wid)) {
    document.getElementById("tlMenuAssignSel").value = "";
    return;
  }
  
  const s = projectStart(p);
  const e = projectEnd(p);
  
  const pad = (n) => String(n).padStart(2, "0");
  const projStartTime = s ? `${pad(s.getHours())}:${pad(s.getMinutes())}` : "08:00";
  const projEndTime = e ? `${pad(e.getHours())}:${pad(e.getMinutes())}` : "18:00";
  
  const startDateStr = s ? `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}` : null;
  const endDateStr = e ? `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}` : startDateStr;
  
  const leaveRecord = startDateStr ? getProjectLeaveConflict(wid, startDateStr, endDateStr || startDateStr) : null;
  const hasLeaveConflict = leaveRecord ? isLeaveConflict(leaveRecord, projStartTime, projEndTime) : false;
  
  if (hasLeaveConflict) {
    const w = getWorker(wid);
    toast(`${w ? w.name : "该人员"} 在此时间段正在请假，无法分配！\n请假时段：${formatLeaveTime(leaveRecord)}`);
    document.getElementById("tlMenuAssignSel").value = "";
    return;
  }
  
  const conflicts = assignConflicts(p, wid);
  if (conflicts.length) {
    const w = getWorker(wid);
    const msg = `${w ? w.name : "该人员"} 在此时间段已被分配到：<br>` +
      conflicts.map((c) => `· ${c.name}（${fmtTimeRange(c)}）`).join("<br>") +
      `<br><br>存在时间冲突，仍要分配吗？`;
    if (!(await confirmDialog(msg, "时间冲突"))) {
      document.getElementById("tlMenuAssignSel").value = "";
      return;
    }
  }
  await repo.setAssignedWorkers(pid, cur.concat(wid));
  await repo.loadAll();
  renderTimelineInDetail();
  setTimeout(() => {
    const taskEl = document.querySelector(`.timeline-task[data-project-id="${pid}"]`);
    if (taskEl) {
      openTimelineActionMenu(taskEl, pid);
    }
  }, 100);
  toast(conflicts.length ? "已分配（存在时间冲突）" : "已分配安装人员");
}

/* 时间线快速移除安装人员 */
async function timelineUnassignWorker(pid, wid) {
  const p = getProject(pid);
  if (!p) return;
  await repo.setAssignedWorkers(pid, (p.assignedWorkerIds || []).filter((x) => x !== wid));
  await repo.loadAll();
  renderTimelineInDetail();
  setTimeout(() => {
    const taskEl = document.querySelector(`.timeline-task[data-project-id="${pid}"]`);
    if (taskEl) {
      openTimelineActionMenu(taskEl, pid);
    }
  }, 100);
  toast("已移除人员");
}

async function timelineAddOutsourcedWorker(pid, name) {
  await addOutsourcedWorker(pid, name);
  const sel = document.getElementById("tlMenuOutsourcedSelect");
  if (sel) sel.value = "";
  renderTimelineInDetail();
  setTimeout(() => {
    const taskEl = document.querySelector(`.timeline-task[data-project-id="${pid}"]`);
    if (taskEl) {
      openTimelineActionMenu(taskEl, pid);
    }
  }, 100);
}

async function timelineAddOutsourcedWorkerByName(pid, name) {
  await addOutsourcedWorkerByName(pid, name);
  renderTimelineInDetail();
  setTimeout(() => {
    const taskEl = document.querySelector(`.timeline-task[data-project-id="${pid}"]`);
    if (taskEl) {
      openTimelineActionMenu(taskEl, pid);
    }
  }, 100);
}

/* 时间线移除外协人员 */
async function timelineRemoveOutsourcedWorker(pid, name) {
  await removeOutsourcedWorker(pid, name);
  renderTimelineInDetail();
  setTimeout(() => {
    const taskEl = document.querySelector(`.timeline-task[data-project-id="${pid}"]`);
    if (taskEl) {
      openTimelineActionMenu(taskEl, pid);
    }
  }, 100);
}

/* 时间线保存外协人员 */
async function timelineSaveOutsourced(pid, names) {
  await saveOutsourcedWorkers(pid, names);
}

/* 关闭浮动操作菜单 */
function closeTimelineActionMenu() {
  const menu = document.getElementById("tlActionMenu");
  if (menu) menu.remove();
  document.querySelectorAll(".timeline-task-active").forEach((t) => t.classList.remove("timeline-task-active"));
}

/* 点击空白区域关闭浮动菜单 */
function timelineCloseAllTasks(e) {
  if (!e.target.closest(".timeline-task") && !e.target.closest(".tl-action-menu")) {
    closeTimelineActionMenu();
  }
}

function timelineDragStart(e) {
  const task = e.target.closest(".timeline-task");
  if (!task) return;

  const left = parseFloat(task.style.left) || 0;
  draggedTask = {
    el: task,
    id: task.dataset.projectId,
    start: new Date(task.dataset.start),
    end: new Date(task.dataset.end),
    originalLeft: left,
    startClientX: e.clientX,
  };

  task.classList.add("timeline-task-dragging");

  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", task.dataset.projectId);
}

function timelineDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  if (!draggedTask) return;

  const timelineMain = document.getElementById("timelineMain");
  const dragHint = document.getElementById("tlDragHint");
  if (!timelineMain || !dragHint) return;

  const rect = timelineMain.getBoundingClientRect();
  const clientX = e.clientX;
  const relativeX = clientX - rect.left;
  
  const deltaX = clientX - draggedTask.startClientX;
  let newLeft = draggedTask.originalLeft + deltaX;
  newLeft = Math.max(0, Math.min(newLeft, timelineMain.clientWidth - 60));

  draggedTask.el.style.left = newLeft + "px";

  const hourOffset = newLeft / TL_ACTUAL_HOUR_WIDTH;
  let totalMinutes = Math.round(hourOffset * 60);
  totalMinutes = Math.round(totalMinutes / 5) * 5;
  const hours = TL_VIEW_START_HOUR + Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const timelineStart = new Date(draggedTask.start);
  timelineStart.setHours(hours, minutes, 0, 0);

  const duration = draggedTask.end.getTime() - draggedTask.start.getTime();
  const newEnd = new Date(timelineStart.getTime() + duration);

  const pad = (n) => String(n).padStart(2, "0");
  const timeStr = `${pad(timelineStart.getHours())}:${pad(timelineStart.getMinutes())} ~ ${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}`;

  const startH = timelineStart.getHours() + timelineStart.getMinutes() / 60;
  const endH = newEnd.getHours() + newEnd.getMinutes() / 60;
  const isOvertime = (startH < TL_WORK_START_HOUR - 10/60) || (endH > TL_WORK_END_HOUR + 10/60) ||
                     startH >= TL_WORK_END_HOUR || endH <= TL_WORK_START_HOUR;

  dragHint.innerHTML = `${timeStr}${isOvertime ? " 🌙 加班" : ""}`;
  dragHint.style.left = newLeft + "px";
  dragHint.style.top = "-28px";
  dragHint.style.display = "block";
}

function timelineDragEnter(e) {
  e.preventDefault();
}

function timelineDragLeave(e) {
  const dragHint = document.getElementById("tlDragHint");
  if (dragHint) {
    dragHint.style.display = "none";
  }
}

let touchDragTask = null;
let touchDragStartX = 0;
let touchDragStartY = 0;
let touchDragOriginalLeft = 0;
let touchDragStarted = false;
const DRAG_THRESHOLD = 10;

let mouseDragTask = null;
let mouseDragStartX = 0;
let mouseDragStartY = 0;
let mouseDragOriginalLeft = 0;
let mouseDragStarted = false;

function timelineTouchStart(e) {
  const task = e.target.closest(".timeline-task");
  if (!task || !task.draggable) return;

  const left = parseFloat(task.style.left) || 0;
  const touch = e.touches[0];
  
  touchDragTask = {
    el: task,
    id: task.dataset.projectId,
    start: new Date(task.dataset.start),
    end: new Date(task.dataset.end),
    originalLeft: left,
  };
  touchDragStartX = touch.clientX;
  touchDragStartY = touch.clientY;
  touchDragOriginalLeft = left;
  touchDragStarted = false;

  task.classList.add("timeline-task-dragging");
}

function timelineTouchMove(e) {
  if (!touchDragTask) return;

  const touch = e.touches[0];
  const deltaX = touch.clientX - touchDragStartX;
  const deltaY = touch.clientY - touchDragStartY;

  if (!touchDragStarted) {
    if (Math.abs(deltaX) > DRAG_THRESHOLD) {
      touchDragStarted = true;
      timelineMouseDown = null;
    } else if (Math.abs(deltaY) > DRAG_THRESHOLD) {
      touchDragTask = null;
      timelineMouseDown = null;
      return;
    }
    return;
  }

  e.preventDefault();

  const timelineMain = document.getElementById("timelineMain");
  const dragHint = document.getElementById("tlDragHint");
  if (!timelineMain) return;

  let newLeft = touchDragOriginalLeft + deltaX;
  newLeft = Math.max(0, Math.min(newLeft, timelineMain.clientWidth - 60));
  touchDragTask.el.style.left = newLeft + "px";

  if (dragHint) {
    const hourOffset = newLeft / TL_ACTUAL_HOUR_WIDTH;
    let totalMinutes = Math.round(hourOffset * 60);
    totalMinutes = Math.round(totalMinutes / 5) * 5;
    const hours = TL_VIEW_START_HOUR + Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const timelineStart = new Date(touchDragTask.start);
    timelineStart.setHours(hours, minutes, 0, 0);

    const duration = touchDragTask.end.getTime() - touchDragTask.start.getTime();
    const newEnd = new Date(timelineStart.getTime() + duration);

    const pad = (n) => String(n).padStart(2, "0");
    const timeStr = `${pad(timelineStart.getHours())}:${pad(timelineStart.getMinutes())} ~ ${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}`;

    const startH = timelineStart.getHours() + timelineStart.getMinutes() / 60;
    const endH = newEnd.getHours() + newEnd.getMinutes() / 60;
    const isOvertime = (startH < TL_WORK_START_HOUR - 10/60) || (endH > TL_WORK_END_HOUR + 10/60) ||
                       startH >= TL_WORK_END_HOUR || endH <= TL_WORK_START_HOUR;

    dragHint.innerHTML = `${timeStr}${isOvertime ? " 🌙 加班" : ""}`;
    dragHint.style.left = newLeft + "px";
    dragHint.style.top = "-28px";
    
    const taskInfo = touchDragTask.el.querySelector(".timeline-task-info");
    if (taskInfo) {
      const timeSpan = taskInfo.querySelector("span:first-child");
      if (timeSpan) {
        timeSpan.textContent = `⏰ ${timeStr}`;
      }
    }
    dragHint.style.display = "block";
  }
}

function timelineTouchEnd(e) {
  if (!touchDragTask) return;

  const task = touchDragTask.el;
  const originalLeft = touchDragTask.originalLeft;
  const originalStart = touchDragTask.start;
  const originalEnd = touchDragTask.end;
  
  task.classList.remove("timeline-task-dragging");

  const dragHint = document.getElementById("tlDragHint");
  if (dragHint) {
    dragHint.style.display = "none";
  }

  if (!touchDragStarted) {
    touchDragTask = null;
    timelineMouseDown = null;
    return;
  }
  
  mouseDragEnded = true;

  const timelineMain = document.getElementById("timelineMain");
  if (!timelineMain) { touchDragTask = null; timelineMouseDown = null; return; }

  const newLeft = parseFloat(task.style.left) || originalLeft;

  const hourOffset = newLeft / TL_ACTUAL_HOUR_WIDTH;
  let totalMinutes = Math.round(hourOffset * 60);
  totalMinutes = Math.round(totalMinutes / 5) * 5;
  const hours = TL_VIEW_START_HOUR + Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const timelineStart = new Date(originalStart);
  timelineStart.setHours(hours, minutes, 0, 0);

  const duration = originalEnd.getTime() - originalStart.getTime();
  const newEnd = new Date(timelineStart.getTime() + duration);

  const startH = timelineStart.getHours() + timelineStart.getMinutes() / 60;
  const endH = newEnd.getHours() + newEnd.getMinutes() / 60;
  const isOvertime = (startH < TL_WORK_START_HOUR - 10/60) || (endH > TL_WORK_END_HOUR + 10/60) ||
                     startH >= TL_WORK_END_HOUR || endH <= TL_WORK_START_HOUR;

  touchDragTask = null;

  const p = getProject(task.dataset.projectId);
  if (!p) return;

  const store = getStore(p.storeId);
  const customerPhone = p.phone || "未填写";
  const storePhone = (store && store.phone) || "未填写";

  const oldStartStr = fmtDateTime(originalStart);
  const newStartStr = fmtDateTime(timelineStart);
  const overtimeWarn = isOvertime
    ? `<div class="tl-drag-overtime">🌙 注意：新时间处于加班时段（工作时间 8:00-18:00 外），代表需要加班！</div>`
    : "";

  const modalContent = `
    <div class="tl-drag-modal">
      <h3>⚠ 确认修改预约时间</h3>
      <div class="tl-drag-info">
        <div class="tl-drag-row"><span>项目名称</span><span>${esc(p.name)}</span></div>
        <div class="tl-drag-row"><span>原时间</span><span>${oldStartStr}</span></div>
        <div class="tl-drag-row"><span>新时间</span><span>${newStartStr}</span></div>
        <div class="tl-drag-row"><span>客户电话</span><span><a href="tel:${customerPhone}" class="tl-drag-phone">📞 ${customerPhone}</a></span></div>
        <div class="tl-drag-row"><span>门店电话</span><span><a href="tel:${storePhone}" class="tl-drag-phone">📞 ${storePhone}</a></span></div>
      </div>
      ${overtimeWarn}
      <div class="tl-drag-hint">请确认已与客户沟通好新的预约时间！</div>
      <div class="tl-drag-actions">
        <button class="btn" onclick="modal.close(); cancelTimelineDrag('${task.dataset.projectId}', '${originalLeft}px');">取消</button>
        <button class="btn primary" onclick="modal.close(); saveTimelineTaskTime('${task.dataset.projectId}', new Date('${timelineStart.toISOString()}'), new Date('${newEnd.toISOString()}'));">确认调整时间</button>
      </div>
    </div>`;

  modal.open("修改预约时间", modalContent, { 
    hideFooter: true,
    onClose: () => cancelTimelineDrag(task.dataset.projectId, originalLeft)
  });
}

function timelineDragEnd(e) {
  if (!draggedTask) return;

  const task = draggedTask.el;
  const originalLeft = draggedTask.originalLeft;
  const originalStart = draggedTask.start;
  const originalEnd = draggedTask.end;
  task.classList.remove("timeline-task-dragging");

  const dragHint = document.getElementById("tlDragHint");
  if (dragHint) {
    dragHint.style.display = "none";
  }

  const timelineMain = document.getElementById("timelineMain");
  if (!timelineMain) { draggedTask = null; return; }

  /* 用鼠标水平移动量计算新位置 */
  const deltaX = e.clientX - draggedTask.startClientX;
  let newLeft = originalLeft + deltaX;
  newLeft = Math.max(0, Math.min(newLeft, timelineMain.clientWidth - 60));

  /* 把像素位置转换为时间，按5分钟粒度吸附 */
  const hourOffset = newLeft / TL_ACTUAL_HOUR_WIDTH;
  let totalMinutes = Math.round(hourOffset * 60);
  totalMinutes = Math.round(totalMinutes / 5) * 5;
  const hours = TL_VIEW_START_HOUR + Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const timelineStart = new Date(originalStart);
  timelineStart.setHours(hours, minutes, 0, 0);

  const duration = originalEnd.getTime() - originalStart.getTime();
  const newEnd = new Date(timelineStart.getTime() + duration);

  /* 判断是否加班 */
  const startH = timelineStart.getHours() + timelineStart.getMinutes() / 60;
  const endH = newEnd.getHours() + newEnd.getMinutes() / 60;
  const isOvertime = (startH < TL_WORK_START_HOUR - 10/60) || (endH > TL_WORK_END_HOUR + 10/60) ||
                     startH >= TL_WORK_END_HOUR || endH <= TL_WORK_START_HOUR;

  draggedTask = null;

  const p = getProject(task.dataset.projectId);
  if (!p) return;

  const store = getStore(p.storeId);
  const customerPhone = p.phone || "未填写";
  const storePhone = (store && store.phone) || "未填写";

  const oldStartStr = fmtDateTime(originalStart);
  const newStartStr = fmtDateTime(timelineStart);
  const overtimeWarn = isOvertime
    ? `<div class="tl-drag-overtime">🌙 注意：新时间处于加班时段（工作时间 8:00-18:00 外），代表需要加班！</div>`
    : "";

  const modalContent = `
    <div class="tl-drag-modal">
      <h3>⚠ 确认修改预约时间</h3>
      <div class="tl-drag-info">
        <div class="tl-drag-row"><span>项目名称</span><span>${esc(p.name)}</span></div>
        <div class="tl-drag-row"><span>原时间</span><span>${oldStartStr}</span></div>
        <div class="tl-drag-row"><span>新时间</span><span>${newStartStr}</span></div>
        <div class="tl-drag-row"><span>客户电话</span><span><a href="tel:${customerPhone}" class="tl-drag-phone">📞 ${customerPhone}</a></span></div>
        <div class="tl-drag-row"><span>门店电话</span><span><a href="tel:${storePhone}" class="tl-drag-phone">📞 ${storePhone}</a></span></div>
      </div>
      ${overtimeWarn}
      <div class="tl-drag-hint">请确认已与客户沟通好新的预约时间！</div>
      <div class="tl-drag-actions">
        <button class="btn" onclick="modal.close(); cancelTimelineDrag('${task.dataset.projectId}', '${originalLeft}px');">取消</button>
        <button class="btn primary" onclick="modal.close(); saveTimelineTaskTime('${task.dataset.projectId}', new Date('${timelineStart.toISOString()}'), new Date('${newEnd.toISOString()}'));">确认调整时间</button>
      </div>
    </div>`;

  modal.open("修改预约时间", modalContent, { 
    hideFooter: true,
    onClose: () => cancelTimelineDrag(task.dataset.projectId, originalLeft)
  });
}

function timelineDragMouseDown(e) {
  if (e.button !== 0) return;
  
  const task = e.target.closest(".timeline-task");
  if (!task || !task.draggable) return;

  const left = parseFloat(task.style.left) || 0;
  mouseDragTask = {
    el: task,
    id: task.dataset.projectId,
    start: new Date(task.dataset.start),
    end: new Date(task.dataset.end),
    originalLeft: left,
  };
  mouseDragStartX = e.clientX;
  mouseDragStartY = e.clientY;
  mouseDragOriginalLeft = left;
  mouseDragStarted = false;

  task.classList.add("timeline-task-dragging");

  e.preventDefault();
}

function timelineMouseMove(e) {
  if (!mouseDragTask) return;

  const deltaX = e.clientX - mouseDragStartX;
  const deltaY = e.clientY - mouseDragStartY;

  if (!mouseDragStarted) {
    if (Math.abs(deltaX) > DRAG_THRESHOLD) {
      mouseDragStarted = true;
      timelineMouseDown = null;
    } else if (Math.abs(deltaY) > DRAG_THRESHOLD) {
      mouseDragTask = null;
      timelineMouseDown = null;
      return;
    }
    return;
  }

  e.preventDefault();

  const timelineMain = document.getElementById("timelineMain");
  const dragHint = document.getElementById("tlDragHint");
  if (!timelineMain) return;

  let newLeft = mouseDragOriginalLeft + deltaX;
  newLeft = Math.max(0, Math.min(newLeft, timelineMain.clientWidth - 60));
  mouseDragTask.el.style.left = newLeft + "px";

  if (dragHint) {
    const hourOffset = newLeft / TL_ACTUAL_HOUR_WIDTH;
    let totalMinutes = Math.round(hourOffset * 60);
    totalMinutes = Math.round(totalMinutes / 5) * 5;
    const hours = TL_VIEW_START_HOUR + Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const timelineStart = new Date(mouseDragTask.start);
    timelineStart.setHours(hours, minutes, 0, 0);

    const duration = mouseDragTask.end.getTime() - mouseDragTask.start.getTime();
    const newEnd = new Date(timelineStart.getTime() + duration);

    const pad = (n) => String(n).padStart(2, "0");
    const timeStr = `${pad(timelineStart.getHours())}:${pad(timelineStart.getMinutes())} ~ ${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}`;

    const startH = timelineStart.getHours() + timelineStart.getMinutes() / 60;
    const endH = newEnd.getHours() + newEnd.getMinutes() / 60;
    const isOvertime = (startH < TL_WORK_START_HOUR - 10/60) || (endH > TL_WORK_END_HOUR + 10/60) ||
                       startH >= TL_WORK_END_HOUR || endH <= TL_WORK_START_HOUR;

    dragHint.innerHTML = `${timeStr}${isOvertime ? " 🌙 加班" : ""}`;
    dragHint.style.left = newLeft + "px";
    dragHint.style.top = "-28px";
    
    const taskInfo = mouseDragTask.el.querySelector(".timeline-task-info");
    if (taskInfo) {
      const timeSpan = taskInfo.querySelector("span:first-child");
      if (timeSpan) {
        timeSpan.textContent = `⏰ ${timeStr}`;
      }
    }
    dragHint.style.display = "block";
  }
}

function timelineMouseUp(e) {
  if (!mouseDragTask) return;

  const task = mouseDragTask.el;
  const originalLeft = mouseDragTask.originalLeft;
  const originalStart = mouseDragTask.start;
  const originalEnd = mouseDragTask.end;
  
  task.classList.remove("timeline-task-dragging");

  const dragHint = document.getElementById("tlDragHint");
  if (dragHint) {
    dragHint.style.display = "none";
  }

  if (!mouseDragStarted) {
    mouseDragTask = null;
    timelineMouseDown = null;
    return;
  }
  
  mouseDragEnded = true;

  const timelineMain = document.getElementById("timelineMain");
  if (!timelineMain) { mouseDragTask = null; timelineMouseDown = null; return; }

  const newLeft = parseFloat(task.style.left) || originalLeft;

  const hourOffset = newLeft / TL_ACTUAL_HOUR_WIDTH;
  let totalMinutes = Math.round(hourOffset * 60);
  totalMinutes = Math.round(totalMinutes / 5) * 5;
  const hours = TL_VIEW_START_HOUR + Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const timelineStart = new Date(originalStart);
  timelineStart.setHours(hours, minutes, 0, 0);

  const duration = originalEnd.getTime() - originalStart.getTime();
  const newEnd = new Date(timelineStart.getTime() + duration);

  const startH = timelineStart.getHours() + timelineStart.getMinutes() / 60;
  const endH = newEnd.getHours() + newEnd.getMinutes() / 60;
  const isOvertime = (startH < TL_WORK_START_HOUR - 10/60) || (endH > TL_WORK_END_HOUR + 10/60) ||
                     startH >= TL_WORK_END_HOUR || endH <= TL_WORK_START_HOUR;

  mouseDragTask = null;

  const p = getProject(task.dataset.projectId);
  if (!p) return;

  const store = getStore(p.storeId);
  const customerPhone = p.phone || "未填写";
  const storePhone = (store && store.phone) || "未填写";

  const oldStartStr = fmtDateTime(originalStart);
  const newStartStr = fmtDateTime(timelineStart);
  const overtimeWarn = isOvertime
    ? `<div class="tl-drag-overtime">🌙 注意：新时间处于加班时段（工作时间 8:00-18:00 外），代表需要加班！</div>`
    : "";

  const modalContent = `
    <div class="tl-drag-modal">
      <h3>⚠ 确认修改预约时间</h3>
      <div class="tl-drag-info">
        <div class="tl-drag-row"><span>项目名称</span><span>${esc(p.name)}</span></div>
        <div class="tl-drag-row"><span>原时间</span><span>${oldStartStr}</span></div>
        <div class="tl-drag-row"><span>新时间</span><span>${newStartStr}</span></div>
        <div class="tl-drag-row"><span>客户电话</span><span><a href="tel:${customerPhone}" class="tl-drag-phone">📞 ${customerPhone}</a></span></div>
        <div class="tl-drag-row"><span>门店电话</span><span><a href="tel:${storePhone}" class="tl-drag-phone">📞 ${storePhone}</a></span></div>
      </div>
      ${overtimeWarn}
      <div class="tl-drag-hint">请确认已与客户沟通好新的预约时间！</div>
      <div class="tl-drag-actions">
        <button class="btn" onclick="modal.close(); cancelTimelineDrag('${task.dataset.projectId}', '${originalLeft}px');">取消</button>
        <button class="btn primary" onclick="modal.close(); saveTimelineTaskTime('${task.dataset.projectId}', new Date('${timelineStart.toISOString()}'), new Date('${newEnd.toISOString()}'));">确认调整时间</button>
      </div>
    </div>`;

  modal.open("修改预约时间", modalContent, { 
    hideFooter: true,
    onClose: () => cancelTimelineDrag(task.dataset.projectId, originalLeft)
  });
}

async function saveTimelineTaskTime(projectId, newStart, newEnd) {
  const p = getProject(projectId);
  if (!p) return;
  
  const patch = {
    appointment_time: newStart.toISOString(),
    end_time: newEnd.toISOString(),
  };
  
  await repo.patchProject(projectId, patch);
  
  modifiedProjectIds.add(projectId);
  
  await repo.loadAll();
  
  renderAll();
  toast("预约时间已更新");
}

function cancelTimelineDrag(projectId, originalLeft) {
  const taskEl = document.getElementById("timelineMain").querySelector(`.timeline-task[data-project-id="${projectId}"]`);
  if (taskEl) {
    taskEl.style.left = originalLeft;
  }
}

/* ============================================================
 * 登录 / 注册 / 登出
 * ============================================================ */
function showAuthError(msg) {
  const el = document.getElementById("authError");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

async function doLogin() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const remember = document.getElementById("authRemember").checked;
  if (!email || !password) { showAuthError("请输入邮箱和密码"); return; }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { showAuthError("登录失败：" + error.message); return; }
  showAuthError("");
  if (remember) {
    localStorage.setItem("auth_email", email);
    localStorage.setItem("auth_remember", "true");
  } else {
    localStorage.removeItem("auth_email");
    localStorage.removeItem("auth_remember");
  }
  await startCloudSession();
}

async function doSignup() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  if (!email || !password) { showAuthError("请输入邮箱和密码"); return; }
  const { error } = await sb.auth.signUp({ email, password });
  if (error) { showAuthError("注册失败：" + error.message); return; }
  showAuthError("");
  toast("注册成功，若开启了邮箱验证请先到邮箱确认，然后登录");
}

async function doLogout() {
  await sb.auth.signOut();
  location.reload();
}

async function startCloudSession() {
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    const remember = localStorage.getItem("auth_remember");
    const savedEmail = localStorage.getItem("auth_email");
    document.getElementById("authScreen").classList.remove("hidden");
    if (savedEmail) {
      document.getElementById("authEmail").value = savedEmail;
      document.getElementById("authRemember").checked = remember === "true";
    }
    return;
  }
  currentUser = data.session.user;
  document.getElementById("authScreen").classList.add("hidden");

  document.getElementById("btnLogout").classList.remove("hidden");
  document.getElementById("userMenu").classList.remove("hidden");
  setSyncStatus("online", "● 连接中…");

  // 载入当前用户的角色 / 门店
  const { data: prof } = await sb.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
  currentProfile = { role: (prof && prof.role) || null, storeId: (prof && prof.store_id) || null, name: (prof && prof.name) || null };

  const userInfo = document.getElementById("userInfo");
  userInfo.textContent = currentProfile.name || currentUser.email;
  userInfo.classList.remove("hidden");
  
  document.getElementById("dropdownEmail").textContent = currentProfile.name || currentUser.email;
  document.getElementById("dropdownRole").textContent = ROLE_LABEL[currentProfile.role] || currentProfile.role || "未分配";
  
  if (currentProfile.role !== ROLE.MANAGER) {
    document.getElementById("btnMigrateMenu").classList.add("hidden");
    document.getElementById("btnExportLocalMenu").classList.add("hidden");
    document.getElementById("btnExport").classList.add("hidden");
  }

  document.getElementById("btnMigrateMenu").addEventListener("click", () => {
    document.getElementById("userDropdown").classList.add("hidden");
    migrateLocalToCloud();
  });
  document.getElementById("btnExportLocalMenu").addEventListener("click", () => {
    document.getElementById("userDropdown").classList.add("hidden");
    exportCloudToLocal();
  });
  document.getElementById("btnLogoutMenu").addEventListener("click", () => {
    document.getElementById("userDropdown").classList.add("hidden");
    doLogout();
  });

  

  // 未分配角色：显示提示并停止后续加载
  if (!currentProfile.role) {
    showNoAccess(currentUser.email);
    return;
  }

  await repo.loadAll();
  renderRoleInfo();
  applyPermissions();
  updateInternalTaskBadge();
  renderAll();
  subscribeRealtime();
}

/* 账号未授权时的提示遮罩 */
function showNoAccess(email) {
  setSyncStatus("offline", "● 待授权");
  const screen = document.getElementById("noAccessScreen");
  document.getElementById("noAccessEmail").textContent = email || "";
  screen.classList.remove("hidden");
}

/* ============================================================
 * 本地数据迁移到云端
 * ============================================================ */
async function migrateLocalToCloud() {
  if (currentProfile.role !== ROLE.MANAGER) {
    toast("只有总经理可以执行此操作");
    return;
  }
  let local;
  try {
    local = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch (e) { local = null; }
  if (!local || ((local.workers || []).length === 0 && (local.projects || []).length === 0)) {
    toast("本地没有可导入的数据");
    return;
  }
  if (!(await confirmDialog("⚠️ 危险操作：将把本机浏览器保存的历史数据上传到云端（不会删除本地数据）。确定继续？", "上传到云端"))) return;

  try {
    if ((local.workers || []).length) {
      const rows = local.workers.map((w) => ({ id: w.id, name: w.name, phone: w.phone || null, role: w.role || null }));
      const { error } = await sb.from("workers").upsert(rows);
      if (error) throw error;
    }
    if ((local.projects || []).length) {
      const pRows = local.projects.map((p) => projectToRow(p));
      const { error } = await sb.from("projects").upsert(pRows);
      if (error) throw error;
      const logRows = [];
      local.projects.forEach((p) => (p.workLogs || []).forEach((l) => {
        logRows.push({
          id: l.id, project_id: p.id, worker_id: l.workerId,
          worker_name: l.workerName, hours: l.hours, date: l.date, note: l.note || null,
        });
      }));
      if (logRows.length) {
        const { error: e2 } = await sb.from("work_logs").upsert(logRows);
        if (e2) throw e2;
      }
    }
    await repo.loadAll();
    renderAll();
    toast("已导入本地数据到云端");
  } catch (e) {
    console.error(e);
    toast("导入失败：" + (e.message || "未知错误"));
  }
}

/* ============================================================
 * 导出云端数据到本地
 * ============================================================ */
async function exportCloudToLocal() {
  if (currentProfile.role !== ROLE.MANAGER) {
    toast("只有总经理可以执行此操作");
    return;
  }
  if (!(await confirmDialog("⚠️ 危险操作：将把云端数据导出到本地浏览器存储，会覆盖本地已有数据。确定继续？", "导出到本地"))) return;
  
  try {
    await repo.loadAll();
    
    const localData = {
      workers: cache.workers,
      projects: cache.projects,
      stores: cache.stores,
      leaveRecords: cache.leaveRecords,
      leaveQuota: cache.leaveQuota,
      holidays: cache.holidays
    };
    
    localStorage.setItem(STORE_KEY, JSON.stringify(localData));
    
    const dataSize = (JSON.stringify(localData).length / 1024).toFixed(2);
    toast(`已导出云端数据到本地，数据大小：${dataSize} KB`);
    logOperation("DATA_EXPORT", "云端数据导出", `数据大小：${dataSize} KB`);
  } catch (e) {
    console.error(e);
    toast("导出失败：" + (e.message || "未知错误"));
  }
}

/* ============================================================
 * 初始化
 * ============================================================ */
function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)));

  document.querySelectorAll(".bottom-nav-item").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)));

  const menuToggle = document.getElementById("menuToggle");
  const tabs = document.querySelector(".tabs");
  menuToggle.addEventListener("click", () => {
    tabs.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!tabs.contains(e.target) && !menuToggle.contains(e.target)) {
      tabs.classList.remove("open");
    }
  });

  document.getElementById("modalClose").addEventListener("click", () => modal.close());
  document.getElementById("modalCancel").addEventListener("click", () => modal.close());
  document.getElementById("modalConfirm").addEventListener("click", async () => {
    if (modalOnConfirm) {
      const result = modalOnConfirm();
      let shouldClose = true;
      if (result instanceof Promise) {
        const resolvedResult = await result;
        if (resolvedResult === false) {
          shouldClose = false;
        }
      } else if (result === false) {
        shouldClose = false;
      }
      if (shouldClose) {
        modal.close();
      }
    }
  });
  const modalMask = document.getElementById("modal");
  let maskMouseDown = false;
  modalMask.addEventListener("mousedown", (e) => {
    maskMouseDown = e.target.id === "modal";
  });
  modalMask.addEventListener("mouseup", (e) => {
    if (maskMouseDown && e.target.id === "modal") modal.close();
    maskMouseDown = false;
  });

  document.getElementById("btnNewWorker").addEventListener("click", newWorker);
  document.getElementById("btnNewOutsourced").addEventListener("click", newOutsourcedWorker);
  document.getElementById("btnNewProject").addEventListener("click", newProject);
  document.getElementById("btnNewStore").addEventListener("click", newStore);
  document.getElementById("projectSearch").addEventListener("input", renderProjects);
  document.getElementById("projectStatusFilter").addEventListener("change", (e) => {
    onProjectStatusChange(e.target.value);
    renderProjects();
  });
  document.getElementById("projectStoreFilter").addEventListener("change", renderProjects);

  // 施工管理项目选择已改为自定义弹窗（按钮 onclick=openProjectPicker），无需 change 监听

  document.getElementById("calPrev").addEventListener("click", calPrevMonth);
  document.getElementById("calNext").addEventListener("click", calNextMonth);
  document.getElementById("calToday").addEventListener("click", calGotoToday);
  document.getElementById("calToggleView").addEventListener("click", toggleCalView);

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("statsMonth").value = thisMonth;
  
  const calendarDateEl = document.getElementById("calendarDate");
  if (calendarDateEl) {
    calendarDateEl.textContent = now.getDate();
  }
  document.getElementById("statsPeriod").addEventListener("change", renderStats);
  document.getElementById("statsMonth").addEventListener("change", renderStats);
  document.getElementById("statsStore").addEventListener("change", renderStats);
  document.getElementById("statsWorker").addEventListener("change", renderStats);
  document.getElementById("statsStatus").addEventListener("change", renderStats);
  document.getElementById("btnExportStats").addEventListener("click", exportStats);
  document.getElementById("btnWageConfig").addEventListener("click", showWageConfig);
  document.getElementById("btnInternalWorkLog").addEventListener("click", showInternalWorkLogModal);

  document.getElementById("storeStatsMonth").value = thisMonth;
  document.getElementById("storeStatsMonth").addEventListener("change", renderStoreStats);
  document.getElementById("btnExportStoreStats").addEventListener("click", exportStoreStats);

  document.getElementById("btnLogin").addEventListener("click", doLogin);
  document.getElementById("btnSignup").addEventListener("click", doSignup);
  document.getElementById("btnLogout").addEventListener("click", doLogout);
  document.getElementById("btnLogout2").addEventListener("click", doLogout);

  document.getElementById("userMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("userDropdown");
    if (menu) {
      menu.classList.toggle("hidden");
    }
  });

  document.addEventListener("click", () => {
    const menu = document.getElementById("userDropdown");
    if (menu && !menu.classList.contains("hidden")) {
      menu.classList.add("hidden");
    }
  });
  document.getElementById("authPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });

  document.addEventListener("mousemove", timelineMouseMove);
  document.addEventListener("mouseup", timelineMouseUp);
}

async function init() {
  bindEvents();

  if (cloudConfigured()) {
    MODE = "cloud";
    sb = window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY);
    if (window.APP_CONFIG.SUPABASE_SERVICE_KEY) {
      sbAdmin = window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_SERVICE_KEY);
      // 安全检查：非本地部署时 service_key 会暴露在客户端代码中
      if (window.APP_CONFIG.ENFORCE_KEY_SECURITY && 
          !["localhost", "127.0.0.1", ""].includes(window.location.hostname)) {
        console.warn("[安全警告] service_role 密钥在客户端代码中暴露！"
          + "如果您部署在公开托管服务（如 GitHub Pages），请将 SUPABASE_SERVICE_KEY 设为空字符串。"
          + "否则攻击者可以使用此密钥完全控制您的 Supabase 数据库。");
      }
    }
    await startCloudSession();
  } else {
    MODE = "local";
    setSyncStatus("", "● 本地模式");
    currentProfile = { role: ROLE.MANAGER, storeId: null }; // 本地单机为全权限
    await repo.loadAll();
    renderRoleInfo();
    applyPermissions();
    updateInternalTaskBadge();
    renderAll();
  }

  workingProjectsTimer = setInterval(() => {
    const hasWorkingProjects = cache.projects.some(p => p.status === STATUS.WORKING);
    if (hasWorkingProjects) {
      renderAll();
    }
  }, 60000);

  window.addEventListener('beforeunload', () => {
    if (workingProjectsTimer) {
      clearInterval(workingProjectsTimer);
      workingProjectsTimer = null;
    }
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
  });
}

document.addEventListener("DOMContentLoaded", init);

/* ---------- PWA：注册 Service Worker（离线可用 / 可安装到主屏 / 自动更新） ---------- */
if ("serviceWorker" in navigator && window.location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((registration) => {
      registration.update();
      
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.location.reload();
      });
      
      navigator.serviceWorker.addEventListener("message", async (e) => {
        if (e.data && e.data.type === "VERSION_UPDATED") {
          if (await confirmDialog(`应用已更新至新版本 ${e.data.version}！是否立即刷新？`, "应用更新")) {
            window.location.reload();
          }
        }
      });
    }).catch((err) => console.warn("Service Worker 注册失败", err));
  });
  
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      const activeTab = document.querySelector(".tab-panel.active");
      if (!activeTab) return;
      if (document.body.classList.contains("timeline-view")) {
        if (activeTab.id === "calendar") {
          renderCalendar();
        } else if (activeTab.id === "workers") {
          renderWorkers();
        }
      }
    }, 200);
  });
}

function showHelp() {
  window.open("help.html", "_blank");
}
