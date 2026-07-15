/* ============================================================
 * 广告安装施工预约管理系统
 * 支持两种运行模式：
 *   - 云端模式(cloud)：配置 config.js 后，数据存 Supabase，多人实时同步
 *   - 本地模式(local)：未配置时，数据存浏览器 localStorage，单机使用
 * ============================================================ */

const STORE_KEY = "ad_install_system_v1";

const STATUS = {
  BOOKED: "预约中",
  WORKING: "施工中",
  DONE: "已完工",
  ACCEPTED: "已验收",
  REVIEWED: "已审核",
};

/* 内存缓存：所有渲染函数都读它；shape 与本地模式一致 */
const cache = { workers: [], projects: [], stores: [], leaveRecords: [], leaveQuota: [], holidays: [], operationLogs: [], outsourcedWorkers: [] };

/* 角色 */
const ROLE = { MANAGER: "manager", STORE: "store_manager", WORKER: "worker" };
const ROLE_LABEL = { manager: "总经理", store_manager: "店长", worker: "施工人员" };

/* 运行时状态 */
let MODE = "cloud";        // 'cloud' | 'local'
let sb = null;             // supabase client
let sbAdmin = null;        // supabase admin client (for deleteUser)
let currentUser = null;    // 云端登录用户
let currentProfile = { role: null, storeId: null }; // 当前用户角色与门店
let reloadTimer = null;    // 实时刷新去抖

const getWorker = (id) => cache.workers.find((w) => w.id === id);
const getProject = (id) => cache.projects.find((p) => p.id === id);
const getStore = (id) => cache.stores.find((s) => s.id === id);
const getLeaveRecord = (id) => cache.leaveRecords.find((l) => l.id === id);
const getOutsourcedWorker = (id) => cache.outsourcedWorkers.find((w) => w.id === id);
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
  PROJECT_EDIT: "project_edit",
  PROJECT_DELETE: "project_delete",
  CONSTRUCTION: "construction",
  ASSIGN_WORKER: "assign_worker",
  VIEW_STATS: "view_stats",
  VIEW_STORE_STATS: "view_store_stats",
  MANAGE_STORES: "manage_stores",
  MANAGE_WORKERS: "manage_workers",
  MANAGE_LEAVES: "manage_leaves",
  REVIEW_PROJECT: "review_project",
};

/* 权限项的中文说明（角色权限配置页逐行展示，顺序即展示顺序） */
const CAP_LABEL = {
  project_create: "新建预约",
  project_edit: "编辑预约（店长限本门店）",
  project_delete: "删除预约（店长限本门店）",
  construction: "填写施工工时 / 实际工时 / 验收",
  assign_worker: "分配安装人员",
  view_stats: "查看工时统计",
  view_store_stats: "查看店面统计",
  manage_workers: "管理施工人员名册",
  manage_leaves: "管理请假记录",
  manage_stores: "管理门店",
  review_project: "审核项目（审核后不可编辑）",
};

/* 默认权限模板（与 SQL seed 一致）；云端会用 role_permissions 表覆盖 */
const DEFAULT_ROLE_PERMS = {
  store_manager: {
    project_create: true, project_edit: true, project_delete: true,
    assign_worker: false, construction: false, view_stats: false,
    view_store_stats: false, manage_stores: false, manage_workers: false,
    manage_leaves: true, review_project: true,
  },
  worker: {
    project_create: false, project_edit: false, project_delete: false,
    assign_worker: true, construction: true, view_stats: false,
    view_store_stats: false, manage_stores: false, manage_workers: false,
    manage_leaves: true, review_project: false,
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
  editProject: (p) => !isReviewed(p) && can(CAP.PROJECT_EDIT) && (isManager() || (p && p.storeId === myStore())),
  deleteProject: (p) => !isReviewed(p) && can(CAP.PROJECT_DELETE) && (isManager() || (p && p.storeId === myStore())),
  doConstruction: (p) => !isReviewed(p) && can(CAP.CONSTRUCTION),
  assignWorker: (p) => !isReviewed(p) && can(CAP.ASSIGN_WORKER),
  viewStats: () => can(CAP.VIEW_STATS),
  viewStoreStats: () => can(CAP.VIEW_STORE_STATS),
  manageStores: () => can(CAP.MANAGE_STORES),
  manageWorkers: () => can(CAP.MANAGE_WORKERS),
  manageLeaves: () => can(CAP.MANAGE_LEAVES),
  manageAccounts: () => isManager(),
  reviewProject: (p) => can(CAP.REVIEW_PROJECT) && (isManager() || (p && p.storeId === myStore())),
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
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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

function monthKey(v) {
  const d = new Date(v);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

function diffColor(diff) {
  if (diff > 0) return "var(--danger)";
  if (diff < 0) return "var(--success)";
  return "var(--muted)";
}

/* 带符号的差异文本：+1 / -2 / 0 */
function fmtSignedDiff(diff) {
  return diff > 0 ? `+${diff}` : `${diff}`;
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

/* 项目工时差异的展示标签（含颜色），未登记实际工时时给出提示 */
function diffLabel(project) {
  const { diff, hasActual } = hoursDiff(project);
  if (!hasActual) return `<span style="color:var(--muted)">未登记实际工时</span>`;
  if (diff > 0) return `<span style="color:var(--danger)">超 ${diff} 小时</span>`;
  if (diff < 0) return `<span style="color:var(--success)">省 ${-diff} 小时</span>`;
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
  }
}

/* ============================================================
 * 字段映射（云端 snake_case <-> 前端 camelCase）
 * ============================================================ */
let modifiedProjectIds = new Set();
let projectTimeFilterDays = 7;

const mapProject = (r) => ({
  id: r.id,
  name: r.name,
  customer: r.customer,
  phone: r.phone,
  address: r.address,
  appointmentTime: r.appointment_time,
  endTime: r.end_time || "",
  estimatedHours: Number(r.estimated_hours) || 0,
  outsourcedHours: Number(r.outsourced_hours) || 0,
  workerCount: Number(r.worker_count) || 1,
  actualHours: Number(r.actual_hours) || 0,
  outsourcedHoursFromLogs: 0,
  status: r.status,
  note: r.note,
  acceptance: r.acceptance || null,
  storeId: r.store_id || "",
  createdBy: r.created_by || null,
  assignedWorkerIds: Array.isArray(r.assigned_workers) ? r.assigned_workers : [],
  outsourcedWorkers: r.outsourced_workers || "",
  started_at: r.started_at || "",
  finished_at: r.finished_at || "",
  createdAt: r.created_at,
  workLogs: [],
  timeModified: modifiedProjectIds.has(r.id),
  repairOrder: r.repair_order ? (typeof r.repair_order === "string" ? JSON.parse(r.repair_order) : r.repair_order) : null,
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
  started_at: p.started_at || null,
  finished_at: p.finished_at || null,
  updated_at: new Date().toISOString(),
  repair_order: p.repairOrder ? JSON.stringify(p.repairOrder) : null,
});

const mapLog = (r) => ({
  id: r.id,
  workerId: r.worker_id,
  workerName: r.worker_name,
  hours: Number(r.hours) || 0,
  date: r.date,
  note: r.note,
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
      const [wRes, pRes, lRes, sRes, rpRes, lrRes, lqRes, hRes, oRes, opRes] = await Promise.all([
        sb.from("workers").select("*"),
        sb.from("projects").select("*"),
        sb.from("work_logs").select("*"),
        sb.from("stores").select("*"),
        sb.from("role_permissions").select("*"),
        sb.from("leave_records").select("*"),
        sb.from("leave_quota").select("*"),
        sb.from("holidays").select("*"),
        sb.from("outsourced_workers").select("*"),
        sb.from("operation_logs").select("*").order("timestamp", { ascending: false }).limit(200),
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
    if (MODE !== "cloud") return;
    const { error } = await sb.from("profiles").delete().eq("id", userId);
    if (error) return fail(error);
    if (sbAdmin) {
      await sbAdmin.auth.admin.deleteUser(userId);
    } else {
      fail("未配置服务端密钥，无法删除认证账号");
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
      const { error } = await sb.from("projects").update(row).eq("id", id);
      if (error) return fail(error);
    } else {
      const p = getProject(id);
      for (const [key, value] of Object.entries(patch)) {
        if (key.includes("_")) {
          const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
          if (camelKey in p) p[camelKey] = value;
          else p[key] = value;
        } else {
          p[key] = value;
        }
      }
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
      getProject(pid).assignedWorkerIds = ids;
      saveLocal();
    }
  },

  /* ---- 施工工时 ---- */
  async addWorkLog(pid, log) {
    if (MODE === "cloud") {
      const row = {
        id: uid(), project_id: pid, worker_id: log.workerId,
        worker_name: log.workerName, hours: log.hours, date: log.date, note: log.note || null,
        level: log.level || "中级",
        is_outsourced: log.isOutsourced || false,
      };
      let { error } = await sb.from("work_logs").insert(row);
      if (error && error.message && error.message.includes('level')) {
        const { level, ...rowWithoutLevel } = row;
        ({ error } = await sb.from("work_logs").insert(rowWithoutLevel));
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
  throw error;
}

/* ---------- 本地存储实现 ---------- */
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      cache.workers = data.workers || [];
      cache.projects = (data.projects || []).map((p) => {
        p.outsourcedHoursFromLogs = (p.workLogs || []).reduce((sum, l) => {
          const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
          return sum + (isOutsourced ? (Number(l.hours) || 0) : 0);
        }, 0);
        return p;
      });
      cache.stores = data.stores || [];
      cache.leaveRecords = data.leaveRecords || [];
      cache.leaveQuota = data.leaveQuota || [];
      cache.holidays = data.holidays || [];
      cache.outsourcedWorkers = data.outsourcedWorkers || [];
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
  localStorage.setItem(STORE_KEY, JSON.stringify({ 
    workers: cache.workers, 
    projects: cache.projects, 
    stores: cache.stores, 
    leaveRecords: cache.leaveRecords,
    leaveQuota: cache.leaveQuota,
    holidays: cache.holidays,
    outsourcedWorkers: cache.outsourcedWorkers
  }));
}

/* ============================================================
 * 实时同步：任意客户端改动 -> 去抖后重载并重绘
 * ============================================================ */
function subscribeRealtime() {
  if (MODE !== "cloud") return;
  sb.channel("realtime-all")
    .on("postgres_changes", { event: "*", schema: "public", table: "workers" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "work_logs" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "stores" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "role_permissions" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "leave_records" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "outsourced_workers" }, scheduleReload)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setSyncStatus("online", "● 实时同步中");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSyncStatus("offline", "● 同步连接异常");
    });
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    await repo.loadAll();
    applyPermissions();  // 角色权限可能变更，需重新计算 Tab 与按钮可见性
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
            ${isManager() ? `<button class="btn small" onclick="editWorker('${w.id}')">编辑</button><button class="btn small danger" onclick="deleteWorker('${w.id}')">删除</button>` : ""}
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
  
  if (items.length === 0) {
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
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const workerLeaves = cache.leaveRecords.filter((lr) => {
      if (lr.workerId !== w.id) return false;
      if (lr.status === "rejected") return false;
      const sd = new Date(lr.startDate);
      sd.setHours(0, 0, 0, 0);
      const ed = new Date(lr.endDate);
      ed.setHours(0, 0, 0, 0);
      return today >= sd && today <= ed;
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
    
    let tasksHtml = "";
    workerProjects.forEach(p => {
      const start = projectStart(p);
      const end = projectEnd(p) || new Date((start || new Date()).getTime() + (p.estimatedHours || 2) * 3600000);
      
      if (!start) return;
      
      const startMinutes = (start.getHours() - 6) * 60 + start.getMinutes();
      const endMinutes = (end.getHours() - 6) * 60 + end.getMinutes();
      const left = (startMinutes / 60) * hourWidth;
      const width = ((endMinutes - startMinutes) / 60) * hourWidth;
      
      const statusClass = `timeline-task-${p.status === "预约中" ? "booked" : p.status === "施工中" ? "working" : p.status === "已完工" ? "done" : ""}`;
      const pad = (n) => String(n).padStart(2, "0");
      const timeStr = `${pad(start.getHours())}:${pad(start.getMinutes())} ~ ${pad(end.getHours())}:${pad(end.getMinutes())}`;
      
      tasksHtml += `
        <div class="timeline-task ${statusClass}" style="left:${left}px; width:${width}px; height:48px;">
          <div class="timeline-task-header">
            <span class="timeline-task-name" style="font-size:11px;">${esc(p.name)}</span>
          </div>
          <div class="timeline-task-body" style="font-size:9px;">
            ${esc(storeName(p.storeId))} · ${timeStr} · 需${p.workerCount || 1}人
          </div>
        </div>`;
    });
    
    const leaveBadge = workerLeaves.length > 0 ? `<span class="tl-lane-leave-badge">🏥</span>` : "";
    
    lanesHtml += `
      <div class="tl-lane" style="height:58px; border-bottom:1px solid #eee; display:flex;">
        <div class="tl-lane-label" style="width:60px; flex-shrink:0; padding:5px; font-size:12px; font-weight:bold;">${esc(w.name)}${leaveBadge}</div>
        <div class="tl-lane-body" style="flex:1; position:relative; height:58px;">
          <div class="tl-bg-work" style="left:${workBgLeft}px; width:${workBgWidth}px; height:100%;"></div>
          <div class="tl-bg-overtime" style="width:${workBgLeft}px; height:100%;"></div>
          <div class="tl-bg-overtime" style="left:${workBgLeft + workBgWidth}px; width:${totalWidth - workBgLeft - workBgWidth}px; height:100%;"></div>
          ${leaveBg}
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
        <div style="font-weight:600; color:#dc2626; margin-bottom:8px;">🏥 ${dateStr} 请假人员</div>
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
          ${workerId ? `<button class="btn small" onclick="openLeaveForm('${workerId}')" style="background:#ef4444;color:#fff">🏥 请假</button>` : ""}
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
  if (!isManager()) { toast("权限不足"); return; }
  modal.open("添加施工人员", workerForm()); 
}
function editWorker(id) { 
  if (!isManager()) { toast("权限不足"); return; }
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
  if (!isManager()) { toast("权限不足"); return; }
  const used = cache.projects.some((p) => (p.workLogs || []).some((l) => l.workerId === id));
  if (used && !confirm("该人员已有施工工时记录，删除不会移除历史记录。确定删除该人员？")) return;
  if (!used && !confirm("确定删除该人员？")) return;
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
        ${isManager() ? `<button class="btn small" onclick="editOutsourcedWorker('${w.id}')">编辑</button><button class="btn small danger" onclick="deleteOutsourcedWorker('${w.id}')">删除</button>` : ""}
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
  if (!isManager()) { toast("权限不足"); return; }
  modal.open("添加外协人员", outsourcedWorkerForm()); 
}
function editOutsourcedWorker(id) { 
  if (!isManager()) { toast("权限不足"); return; }
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
  if (!isManager()) { toast("权限不足"); return; }
  if (!confirm("确定删除该外协人员？")) return;
  await repo.deleteOutsourcedWorker(id);
  await repo.loadAll();
  renderAll();
  toast("已删除");
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
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
      date: current.toISOString().slice(0, 10),
      day: current.getDate(),
      weekday: ["日", "一", "二", "三", "四", "五", "六"][current.getDay()],
      isStart,
      isEnd,
      isWeekend: current.getDay() === 0 || current.getDay() === 6,
      isHoliday: isHoliday(current.toISOString().slice(0, 10)),
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
    comp_days: 0
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
    const dateStr = current.toISOString().slice(0, 10);
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
    if (!confirm(`检测到 ${conflicts.length} 个项目排期冲突，确认继续提交请假申请吗？`)) {
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
  if (!confirm("确定删除该请假记录？")) return;
  await repo.deleteLeaveRecord(id);
  renderAll();
  toast("请假记录已删除");
}

/* 项目预约时间选择辅助函数 */
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
  
  const hoursNeeded = Math.ceil(estHours / workerCount * 2) / 2;
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
    const canUnreview = reviewed && isManager();
    
    const end = new Date(p.endTime || p.startTime);
    const isOverdue = p.status === "预约中" && !p.started_at && new Date() > end;
    
    const pStart = new Date(p.appointmentTime || p.startTime);
    const pEnd = new Date(p.endTime || p.appointmentTime);
    const leaveConflicts = cache.leaveRecords.filter(r => {
      if (r.status !== "approved") return false;
      if (!p.assignedWorkers || !p.assignedWorkers.includes(r.workerId)) return false;
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
        <div class="card-row"><span>预计 / 实际工时</span><b>${est} / ${hasActual ? act : "—"} 小时</b></div>
        <div class="card-row"><span>工时差异</span><b>${diffLabel(p)}</b></div>
        <div class="card-row"><span>已填施工工时</span><b>${done} 小时</b></div>
        <div class="card-row"><span>开始施工</span><b>${p.started_at ? esc(fmtDateTime(p.started_at)) : "—"}</b></div>
        <div class="card-row"><span>完工时间</span><b>${p.finished_at ? esc(fmtDateTime(p.finished_at)) : "—"}</b></div>
        <div class="card-row"><span>施工时长</span><b>${p.started_at && p.finished_at ? esc(calcDuration(p.started_at, p.finished_at)) : "—"}</b></div>
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

function setProjectTimeFilter(days) {
  projectTimeFilterDays = days;
  
  document.getElementById("timeFilterAll").classList.toggle("primary", days === 0);
  document.getElementById("timeFilter3").classList.toggle("primary", days === 3);
  document.getElementById("timeFilter7").classList.toggle("primary", days === 7);
  document.getElementById("timeFilter15").classList.toggle("primary", days === 15);
  document.getElementById("timeFilter30").classList.toggle("primary", days === 30);
  
  renderProjects();
}

function projectForm(p = {}) {
  const storeLocked = isStoreManager();
  const selectedStore = p.storeId || (storeLocked ? myStore() : "");
  const storeOpts = `<option value="">未指定门店</option>` +
    cache.stores.map((s) =>
      `<option value="${s.id}" ${s.id === selectedStore ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  const startDate = p.appointmentTime ? new Date(p.appointmentTime) : new Date();
  return `
    <div style="display:flex;align-items:flex-start;gap:10px;width:100%;">
      <div style="flex-shrink:0;">
        <label style="display:block;margin-bottom:4px;"><span style="color:var(--primary)">🏪</span> 所属门店</label>
        <select class="input" id="pStore" ${storeLocked ? "disabled" : ""} style="width:auto;max-width:160px;">
          ${storeOpts}
        </select>
        ${storeLocked ? `<small class="hint" style="color:#6b7280;display:block;margin-top:2px;">店长只能创建本门店（${esc(storeName(myStore()))}）的预约</small>` : ""}
      </div>
      <div style="flex:1;min-width:0;">
        <label style="display:block;margin-bottom:4px;"><span style="color:var(--primary)">📋</span> 项目名称 *</label>
        <input class="input" id="pName" value="${esc(p.name || "")}" placeholder="如：某某商场门头广告安装" style="width:100%;" />
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label><span style="color:#0891b2">👤</span> 客户名称</label>
        <input class="input" id="pCustomer" value="${esc(p.customer || "")}" placeholder="客户 / 单位" />
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
        <input class="input" type="date" id="pDate" value="${startDate.toISOString().slice(0, 10)}" onchange="updateSpanHint()" style="width:100%;" />
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
        <button class="btn small" onclick="setPTimeRange('morning')" style="background:#e0f2fe;color:#0891b2;border-color:#7dd3fc;border-radius:4px;padding:3px 8px;font-size:12px;">🌅 上午</button>
        <button class="btn small" onclick="setPTimeRange('afternoon')" style="background:#fef3c7;color:#d97706;border-color:#fcd34d;border-radius:4px;padding:3px 8px;font-size:12px;">☀️ 下午</button>
        <button class="btn small" onclick="setPTimeRange('full')" style="background:#dcfce7;color:#16a34a;border-color:#86efac;border-radius:4px;padding:3px 8px;font-size:12px;">📅 全天</button>
        <button class="btn small" onclick="setPTimeRange('twohour')" style="background:#fce7f3;color:#db2777;border-color:#fbcfe8;border-radius:4px;padding:3px 8px;font-size:12px;">⏱️ 2小时</button>
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
  if (isStoreManager()) storeId = myStore();          // 店长强制本门店
  const workerCount = Number(document.getElementById("pWorkers").value) || 1;
  const payload = {
    name,
    customer: document.getElementById("pCustomer").value.trim(),
    phone: document.getElementById("pPhone").value.trim(),
    address: document.getElementById("pAddress").value.trim(),
    appointmentTime: fullTime,
    endTime: fullEnd,
    estimatedHours: Number(document.getElementById("pEst").value) || 0,
    workerCount,
    status: document.getElementById("pStatus").value,
    note: document.getElementById("pNote").value.trim(),
    storeId,
  };
  await repo.saveProject(payload, id);
  await repo.loadAll();
  modal.close();
  renderAll();
  toast("已保存");
  
  if (id) {
    logOperation("PROJECT_EDIT", name, `ID: ${id}`);
  } else {
    logOperation("PROJECT_CREATE", name);
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
}

function openRepairOrderForm(projectId) {
  const p = getProject(projectId);
  if (!p) return;
  
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrow.toISOString().slice(0, 16);
  
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
      <div class="form-row">
        <label>预约维修时间</label>
        <input class="input" type="datetime-local" id="repairTime" value="${tomorrowStr}" min="${now.toISOString().slice(0, 16)}" />
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
  const time = document.getElementById("repairTime").value;
  
  if (!items) {
    toast("请填写维修项目");
    return;
  }
  if (!time) {
    toast("请选择预约维修时间");
    return;
  }
  
  const repairOrder = {
    items,
    reason,
    appointmentTime: new Date(time).toISOString(),
    status: "待维修",
    createdAt: new Date().toISOString(),
  };
  
  await repo.patchProject(projectId, { 
    repairOrder,
    appointmentTime: new Date(time).toISOString()
  });
  await repo.loadAll();
  modal.close();
  openProjectDetail(projectId);
  toast("维修单已提交");
  
  const p = getProject(projectId);
  if (p) {
    showNotificationAlert(`🔧 维修单已发起：${p.name}`);
  }
}

async function completeRepair(projectId) {
  if (!confirm("确认维修已完成？")) return;
  
  await repo.patchProject(projectId, { 
    repairOrder: { 
      ...getProject(projectId).repairOrder, 
      status: "已完成",
      completedAt: new Date().toISOString()
    } 
  });
  await repo.loadAll();
  openProjectDetail(projectId);
  toast("维修已完成");
}

async function deleteProject(id) {
  if (!confirm("确定删除该项目及其施工记录？")) return;
  const p = getProject(id);
  await repo.deleteProject(id);
  if (currentProjectId === id) currentProjectId = "";
  await repo.loadAll();
  renderAll();
  toast("已删除");
  if (p) {
    logOperation("PROJECT_DELETE", p.name || "项目", `ID: ${id}`);
  }
}

/* ============================================================
 * 施工管理模块
 * ============================================================ */
let currentProjectId = "";

/* 日历视图状态（移至下方统一定义） */

function refreshProjectSelector() {
  const sel = document.getElementById("constructionProjectSelect");
  const prev = currentProjectId;
  const items = cache.projects.slice()
    .filter(p => p.status !== "已审核" && p.status !== "已验收")
    .sort((a, b) =>
    new Date(b.appointmentTime || 0) - new Date(a.appointmentTime || 0));
  sel.innerHTML = `<option value="">— 请选择项目 —</option>` +
    items.map((p) => `<option value="${p.id}">${esc(p.name)}（${p.status}）</option>`).join("");
  if (prev && getProject(prev) && items.some(i => i.id === prev)) sel.value = prev;
}

function gotoConstruction(id) {
  currentProjectId = id;
  switchTab("construction");
  document.getElementById("constructionProjectSelect").value = id;
  renderConstruction();
}

let viewScheduleDate = null;

function setViewScheduleDate(dateStr) {
  viewScheduleDate = dateStr;
  renderConstruction();
}

function prevDaySchedule() {
  const d = viewScheduleDate ? new Date(viewScheduleDate) : new Date();
  d.setDate(d.getDate() - 1);
  viewScheduleDate = d.toISOString().slice(0, 10);
  renderConstruction();
}

function nextDaySchedule() {
  const d = viewScheduleDate ? new Date(viewScheduleDate) : new Date();
  d.setDate(d.getDate() + 1);
  viewScheduleDate = d.toISOString().slice(0, 10);
  renderConstruction();
}

function todaySchedule() {
  viewScheduleDate = null;
  renderConstruction();
}

function renderConstruction() {
  const scheduleBox = document.getElementById("workerScheduleDescription");
  const dateStr = viewScheduleDate || new Date().toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
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
      return `<option value="${w.id}"${disabledAttr}>${esc(w.name)}${hasLeaveConflict ? " 🏥 请假中" : ""}</option>`;
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
        <p class="hint" style="margin:0 0 8px;font-size:12px">当任务由外协人员完成时，填写外协人员姓名（多个用逗号分隔）。设置外协后，该任务不占用内部施工人员工时，时间冲突将被解除。</p>
        <div style="margin-bottom:8px;">
          <select class="input" id="outsourcedWorkersSelect" onchange="addOutsourcedWorkerToInput('${p.id}', this.value)">
            <option value="">从常用外协人员列表添加</option>
            ${cache.outsourcedWorkers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}${w.phone ? ` (${esc(w.phone)})` : ''}</option>`).join("")}
          </select>
        </div>
        <div class="assign-form" style="margin-bottom:0">
          <input type="text" class="input" id="outsourcedWorkersInput" placeholder="输入外协人员姓名，多个用逗号分隔" value="${esc(p.outsourcedWorkers || "")}" style="flex:1">
          <button class="btn" onclick="saveOutsourcedWorkers('${p.id}', document.getElementById('outsourcedWorkersInput').value)">保存</button>
        </div>
        ${p.outsourcedWorkers ? `<div class="outsourced-hint">当前任务已设置为外协</div>` : ""}
      </div>` : ""}
    </div>`;

  const end = new Date(p.endTime || p.startTime);
  const isOverdue = p.status === "预约中" && !p.started_at && new Date() > end;
  
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
        <div class="info-item"><div class="k">工程实际用工时</div><div class="v">${p.actualHours || 0} 小时</div></div>
        <div class="info-item"><div class="k">工时差异（实际−预计）</div><div class="v">${diffLabel(p)}</div></div>
        ${p.started_at ? `<div class="info-item"><div class="k">⏰ 开始施工时间</div><div class="v">${esc(fmtDateTime(p.started_at))}</div></div>` : ""}
        ${p.finished_at ? `<div class="info-item"><div class="k">✅ 完工时间</div><div class="v">${esc(fmtDateTime(p.finished_at))}</div></div>` : ""}
        ${p.started_at && p.finished_at ? `<div class="info-item"><div class="k">⏱️ 实际施工时长</div><div class="v"><b>${esc(calcDuration(p.started_at, p.finished_at))}</b></div></div>` : ""}
      </div>
      ${canEdit ? `
      <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:16px;align-items:center">
        <div style="display:flex;align-items:center;gap:8px">
          <label style="font-size:13px;color:var(--muted)">状态</label>
          <select class="input" id="cStatus" onchange="updateProjectStatus('${p.id}', this.value)" style="width:auto;min-width:100px;">
            ${Object.values(STATUS).map((s) =>
              `<option value="${s}" ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <label style="font-size:13px;color:var(--muted)">实际工时</label>
          <input class="input" type="number" min="0" step="0.5" id="cActual" value="${p.actualHours || 0}" style="width:80px;" />
          <button class="btn small primary" onclick="saveActualHours('${p.id}')">保存</button>
        </div>
      </div>` : ""}
      ${canReview && !reviewed ? `
      <div class="card-actions" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn primary" onclick="reviewProject('${p.id}')">✅ 审核项目</button>
      </div>` : ""}
      ${reviewed && isManager() ? `
      <div class="card-actions" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn" onclick="unreviewProject('${p.id}')" style="color:var(--warn)">↩ 反审核</button>
      </div>` : ""}
      ${(reviewed || p.status === "已验收") && (isManager() || isStoreManager()) ? `
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
      ${((isManager() || isWorker()) && p.repairOrder.status === "待维修") ? `
      <div class="card-actions" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn primary" onclick="completeRepair('${p.id}')">✅ 完成维修</button>
      </div>` : ""}
    </div>` : ""}

    ${assignBlock}

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
        <div class="field" id="logOutsourcedField" style="display:none">
          <label>外协人员</label>
          <div style="display:flex;gap:6px;align-items:center;">
            <select class="input" id="logOutsourcedSelect" onchange="updateLogOutsourcedInput()">
              <option value="">从常用列表选择</option>
              ${cache.outsourcedWorkers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}${w.phone ? ` (${esc(w.phone)})` : ''}</option>`).join("")}
            </select>
            <input class="input" id="logOutsourcedName" placeholder="或手动输入" style="flex:1;min-width:150px;" />
          </div>
          <small class="hint" style="font-size:11px;color:#8b5cf6;">可从常用外协人员列表选择，或手动输入新的外协人员</small>
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
  return ["已完工", "已审核", "已验收"].includes(p.status);
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
  
  const conflicts = assignConflicts(p, wid);
  if (conflicts.length) {
    const w = getWorker(wid);
    const msg = `${w ? w.name : "该人员"} 在此时间段已被分配到：\n` +
      conflicts.map((c) => `· ${c.name}（${fmtTimeRange(c)}）`).join("\n") +
      `\n\n存在时间冲突，仍要分配吗？`;
    if (!confirm(msg)) return;
  }
  await repo.setAssignedWorkers(pid, cur.concat(wid));
  await repo.loadAll();
  renderAll();
  toast(conflicts.length ? "已分配（存在时间冲突）" : "已分配安装人员");
}

/* 保存外协人员信息 */
async function saveOutsourcedWorkers(pid, names) {
  const p = getProject(pid);
  if (!p) return;
  await repo.saveProject({ outsourcedWorkers: names.trim() }, pid);
  await repo.loadAll();
  renderAll();
  toast(names.trim() ? "外协人员已保存，该任务不再占用内部施工人员" : "外协人员已清除");
}

async function unassignWorker(pid, wid) {
  const p = getProject(pid);
  const next = (p.assignedWorkerIds || []).filter((x) => x !== wid);
  await repo.setAssignedWorkers(pid, next);
  await repo.loadAll();
  renderAll();
  toast("已移除");
}

async function updateProjectStatus(id, status) {
  const patch = { status };
  const now = new Date().toISOString();
  if (status === STATUS.WORKING) {
    patch.started_at = now;
  } else if (status === STATUS.DONE) {
    patch.finished_at = now;
  }
  await repo.patchProject(id, patch);
  await repo.loadAll();
  renderAll();
  toast("状态已更新");
  
  const p = getProject(id);
  if (p) {
    if (status === STATUS.WORKING) {
      sendNotificationForProjectChange("start", p);
    } else if (status === STATUS.DONE) {
      sendNotificationForProjectChange("done", p);
    } else if (status === STATUS.ACCEPTED) {
      sendNotificationForProjectChange("accepted", p);
    }
  }
}

async function reviewProject(id) {
  if (!confirm("确定审核该项目？审核后项目信息将无法更改。")) return;
  await repo.patchProject(id, { status: STATUS.REVIEWED });
  await repo.loadAll();
  renderAll();
  toast("已审核");
}

async function unreviewProject(id) {
  if (!confirm("确定取消审核？取消后项目将恢复为「已完工」状态，可继续编辑。")) return;
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

function addOutsourcedWorkerToInput(pid, name) {
  if (!name) return;
  const input = document.getElementById("outsourcedWorkersInput");
  const sel = document.getElementById("outsourcedWorkersSelect");
  if (!input) return;
  const current = input.value.trim();
  const names = current ? current.split(",").map(n => n.trim()).filter(n => n) : [];
  if (!names.includes(name)) {
    names.push(name);
    input.value = names.join(", ");
  }
  if (sel) sel.value = "";
}

async function addWorkLog(id) {
  const p = getProject(id);
  const type = document.getElementById("logType").value;
  const hours = Number(document.getElementById("logHours").value);
  const date = document.getElementById("logDate").value;
  const note = document.getElementById("logNote").value.trim();
  const level = document.getElementById("logLevel").value;
  
  if (!hours || hours <= 0) { toast("请填写有效工时"); return; }
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
  
  await repo.addWorkLog(id, { workerId, workerName, hours, date, note, level, isOutsourced: type === "outsourced" });
  if (p.status === STATUS.BOOKED) await repo.patchProject(id, { status: STATUS.WORKING, started_at: new Date().toISOString() });
  await repo.loadAll();
  const updatedProject = getProject(id);
  const totalHours = (updatedProject.workLogs || []).reduce((sum, log) => sum + (Number(log.hours) || 0), 0);
  await repo.patchProject(id, { actualHours: totalHours });
  updatedProject.actualHours = totalHours;
  await logOperation("WORK_LOG_ADD", `${p.name} - ${workerName}`, `工时：${hours}小时，日期：${date}`);
  renderAll();
  toast("已添加施工工时");
}

async function deleteWorkLog(pid, lid) {
  if (!confirm("确定删除该工时记录？此操作不可撤销。")) return;
  const p = getProject(pid);
  const log = (p.workLogs || []).find(l => l.id === lid);
  await repo.deleteWorkLog(pid, lid);
  await repo.loadAll();
  const updatedProject = getProject(pid);
  const totalHours = (updatedProject.workLogs || []).reduce((sum, log) => sum + (Number(log.hours) || 0), 0);
  await repo.patchProject(pid, { actualHours: totalHours });
  updatedProject.actualHours = totalHours;
  await logOperation("WORK_LOG_DELETE", `${p.name} - ${log?.workerName || ""}`, `工时：${log?.hours || 0}小时`);
  renderAll();
  toast("已删除");
}

function generateWorkerScheduleDescription(dateStr = null) {
  const targetDate = dateStr ? new Date(dateStr) : new Date();
  const dateStrFormatted = targetDate.toISOString().slice(0, 10);
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][targetDate.getDay()];
  
  const allTodayProjects = cache.projects.filter(p => {
    const pStart = projectStart(p);
    if (!pStart) return false;
    return pStart.toISOString().slice(0, 10) === dateStrFormatted;
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
  description += `<h3>📅 ${dateStrFormatted} 周三（周${weekday}）施工人员安排</h3>`;
  
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
      } else if (idx === 1) {
        taskDesc = `忙完回来后，${startTime}再去，`;
      } else {
        taskDesc = `接着，${startTime}再去，`;
      }
      
      taskDesc += `前往 <strong>${esc(storeName)}</strong>，`;
      
      if (p.customer) {
        taskDesc += `客户名称是：<strong>${esc(p.customer)}</strong>，`;
      }
      
      if (p.phone) {
        taskDesc += `联系电话：<strong>${esc(p.phone)}</strong>，`;
      }
      
      if (p.address) {
        taskDesc += `地址是 <strong>${esc(p.address)}</strong>，`;
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
        taskDesc += `。备注：<strong>${esc(p.note)}</strong>`;
      }
      
      const isEvening = pStart && pStart.getHours() >= 18;
      if (isEvening) {
        taskDesc += `（⚠️ 可能需要加班，辛苦啦！）`;
      }
      
      description += `<div class="schedule-task">${taskDesc}</div>`;
    });
    
    description += `</div>`;
  });
  
  if (availableWorkers.length > 0) {
    description += `<div class="schedule-item standby">`;
    description += `<div class="schedule-worker">👥 待命人员</div>`;
    description += `<div class="schedule-task">${availableWorkers.map(w => w.name).join("、")} 今天没有安排任务，随时待命，有突发情况可以随时调配。</div>`;
    description += `</div>`;
  }
  
  if (onLeaveWorkers.length > 0) {
    description += `<div class="schedule-item leave">`;
    description += `<div class="schedule-worker">🏥 请假人员</div>`;
    description += `<div class="schedule-task">${onLeaveWorkers.map(w => w.name).join("、")} 今天请假，不在岗，请大家注意人手安排。</div>`;
    description += `</div>`;
  }
  
  const allWorkerIds = new Set();
  todayProjects.forEach(p => {
    (p.assignedWorkerIds || []).forEach(wid => allWorkerIds.add(wid));
  });
  const totalProjects = allTodayProjects.length;
  const statusCounts = {
    "预约中": allTodayProjects.filter(p => p.status === "预约中").length,
    "施工中": allTodayProjects.filter(p => p.status === "施工中").length,
    "已完工": allTodayProjects.filter(p => p.status === "已完工").length,
    "已验收": allTodayProjects.filter(p => p.status === "已验收").length,
    "已审核": allTodayProjects.filter(p => p.status === "已审核").length,
    "已取消": allTodayProjects.filter(p => p.status === "已取消").length,
  };
  const completedProjects = statusCounts["已完工"] + statusCounts["已验收"] + statusCounts["已审核"];
  const inProgressProjects = statusCounts["预约中"] + statusCounts["施工中"];
  const totalWorkers = allWorkerIds.size;
  const onJobWorkers = workersWithProjects.length;
  const totalAvailable = cache.workers.length;
  
  if (totalProjects > 0) {
    description += `<div class="schedule-summary">`;
    description += `<div class="schedule-summary-item">📋 今日项目：${totalProjects} 个（进行中 ${inProgressProjects} 个，已完工 ${statusCounts["已完工"]} 个，已验收 ${statusCounts["已验收"]} 个，已审核 ${statusCounts["已审核"]} 个${statusCounts["已取消"] > 0 ? `，已取消 ${statusCounts["已取消"]} 个` : ``}）</div>`;
    description += `<div class="schedule-summary-item">👷 出勤人员：${onJobWorkers} 人</div>`;
    description += `<div class="schedule-summary-item">🏥 请假人员：${onLeaveWorkers.length} 人</div>`;
    description += `<div class="schedule-summary-item">👤 总人数：${totalAvailable} 人</div>`;
    
    if (totalProjects > 0 && onJobWorkers > 0) {
      const avgProjects = (totalProjects / onJobWorkers).toFixed(1);
      if (avgProjects > 2) {
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
      
      const isOverdue = p.status === "预约中" && !p.started_at && pStart && now > pStart;
      
      switch (p.status) {
        case "预约中":
          if (isOverdue) {
            statusColor = "#ef4444";
            statusText = "预约中（已超期）";
            progress = 0;
          } else {
            statusColor = "#3b82f6";
            progress = now >= pStart ? Math.min(30, autoProgress) : 0;
          }
          break;
        case "施工中":
          statusColor = "#f59e0b";
          progress = Math.max(30, Math.min(90, autoProgress));
          break;
        case "已完工":
        case "已完成":
          statusColor = "#10b981";
          progress = 95;
          break;
        case "已验收":
        case "已审核":
          statusColor = "#06b6d4";
          progress = 100;
          break;
        case "已取消":
          statusColor = "#ef4444";
          progress = 0;
          break;
        default:
          statusColor = "#6b7280";
          progress = 0;
      }
      
      const statusActions = [];
      if ((isManager() || isWorker() || isStoreManager()) && p.status === "预约中") {
        statusActions.push('<button class="btn tiny ' + (isOverdue ? 'danger' : '') + '" onclick="updateProjectStatus(\'' + p.id + '\', \'施工中\')">开始施工</button>');
      }
      if ((isManager() || isWorker() || isStoreManager()) && p.status === "施工中") {
        statusActions.push('<button class="btn tiny" onclick="updateProjectStatus(\'' + p.id + '\', \'已完工\')">完成安装</button>');
      }
      if ((isManager() || isWorker() || isStoreManager()) && (p.status === "已完工" || p.status === "已完成")) {
        statusActions.push('<button class="btn tiny" onclick="updateProjectStatus(\'' + p.id + '\', \'已验收\')">确认验收</button>');
      }
      
      const workers = (p.assignedWorkerIds || []).map(wid => {
        const w = getWorker(wid);
        return w ? w.name : "未知";
      });
      const outsourcedWorkers = (p.outsourcedWorkers || "").split(",").map(n => n.trim()).filter(n => n);
      const allWorkers = [...workers, ...outsourcedWorkers.map(n => `${n}（外协）`)];
      
      description += `
        <div class="schedule-progress-item ${isOverdue ? 'overdue' : ''}">
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

function updateProjectStatus(id, newStatus) {
  const p = getProject(id);
  if (!p) return;
  
  if (newStatus === "已完工") {
    openCompleteProjectForm(id);
    return;
  }
  
  if (newStatus === "已验收") {
    openAcceptance(id);
    return;
  }
  
  p.status = newStatus;
  
  const now = new Date().toISOString();
  
  if (newStatus === "施工中") {
    p.started_at = now;
  }
  
  if (MODE === "cloud" && cloudConfigured()) {
    const updateData = { status: newStatus, updated_at: now };
    if (newStatus === "施工中") {
      updateData.started_at = now;
    }
    sb.from("projects").update(updateData).eq("id", id).then(() => {
      toast(`项目状态已更新为：${newStatus}`);
      renderConstruction();
    }).catch(() => {
      toast("更新失败");
    });
  } else {
    saveLocal();
    toast(`项目状态已更新为：${newStatus}`);
    renderConstruction();
  }
}

function openCompleteProjectForm(id) {
  const p = getProject(id);
  if (!p) return;
  
  const workers = (p.assignedWorkerIds || []).map(wid => {
    const w = getWorker(wid);
    return w ? w : { id: wid, name: "未知", phone: "" };
  });
  
  const outsourcedWorkers = (p.outsourcedWorkers || "").split(",").map(n => n.trim()).filter(n => n);
  
  const dateStr = new Date().toISOString().slice(0, 10);
  
  const startedAt = p.started_at ? new Date(p.started_at) : null;
  const finishedAt = new Date();
  const durationHours = startedAt ? ((finishedAt - startedAt) / (1000 * 60 * 60)).toFixed(1) : "未知";
  
  const startTimeStr = startedAt ? `${startedAt.getFullYear()}/${String(startedAt.getMonth() + 1).padStart(2, "0")}/${String(startedAt.getDate()).padStart(2, "0")} ${String(startedAt.getHours()).padStart(2, "0")}:${String(startedAt.getMinutes()).padStart(2, "0")}` : "未记录";
  const endTimeStr = `${finishedAt.getFullYear()}/${String(finishedAt.getMonth() + 1).padStart(2, "0")}/${String(finishedAt.getDate()).padStart(2, "0")} ${String(finishedAt.getHours()).padStart(2, "0")}:${String(finishedAt.getMinutes()).padStart(2, "0")}`;
  
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
        <div style="font-weight:600;color:#059669;">${esc(durationHours)} 小时</div>
      </div>
    </div>
  </div>`;
  
  if (workers.length > 0) {
    form += `<div class="form-row" style="grid-column:1/-1;">
      <label>施工人员工时</label>
      <span style="font-size:12px;color:#6b7280;">根据实际工作时间填写</span>
    </div>`;
    
    workers.forEach((w, idx) => {
      form += `<div class="form-row" style="grid-column:1/-1;margin-bottom:8px;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;">
          <span style="min-width:80px;font-weight:500;flex-shrink:0;">👷 ${esc(w.name)}</span>
          <div style="flex:0 0 auto;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">工时</label>
            <input type="number" id="workerHours_${idx}" placeholder="0" step="0.5" min="0" max="24" class="input" style="width:70px;padding:4px 6px;font-size:13px;">
          </div>
          <div style="flex:0 0 auto;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">等级</label>
            <select id="workerLevel_${idx}" class="input" style="width:80px;padding:4px 6px;font-size:13px;">
              <option value="初级">初级</option>
              <option value="中级" selected>中级</option>
              <option value="高级">高级</option>
              <option value="特级">特级</option>
            </select>
          </div>
          <div style="flex:1;min-width:150px;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">备注</label>
            <input type="text" id="workerNote_${idx}" placeholder="备注" class="input" style="width:100%;padding:4px 6px;font-size:13px;">
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
      form += `<div class="form-row" style="grid-column:1/-1;margin-bottom:8px;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;">
          <span style="min-width:80px;font-weight:500;flex-shrink:0;color:#8b5cf6;">👤 ${esc(name)}（外协）</span>
          <div style="flex:0 0 auto;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">工时</label>
            <input type="number" id="outsourcedHours_${idx}" placeholder="0" step="0.5" min="0" max="24" class="input" style="width:70px;padding:4px 6px;font-size:13px;">
          </div>
          <div style="flex:0 0 auto;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">等级</label>
            <select id="outsourcedLevel_${idx}" class="input" style="width:80px;padding:4px 6px;font-size:13px;">
              <option value="初级">初级</option>
              <option value="中级" selected>中级</option>
              <option value="高级">高级</option>
              <option value="特级">特级</option>
            </select>
          </div>
          <div style="flex:1;min-width:150px;">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:1px;">备注</label>
            <input type="text" id="outsourcedNote_${idx}" placeholder="备注" class="input" style="width:100%;padding:4px 6px;font-size:13px;">
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
    onConfirm: () => {
      let totalHours = 0;
      const logs = [];
      
      workers.forEach((w, idx) => {
        const hours = parseFloat(document.getElementById(`workerHours_${idx}`)?.value);
        const level = document.getElementById(`workerLevel_${idx}`)?.value || "中级";
        const note = document.getElementById(`workerNote_${idx}`)?.value;
        if (hours && hours > 0) {
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
        const hours = parseFloat(document.getElementById(`outsourcedHours_${idx}`)?.value);
        const level = document.getElementById(`outsourcedLevel_${idx}`)?.value || "中级";
        const note = document.getElementById(`outsourcedNote_${idx}`)?.value;
        if (hours && hours > 0) {
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
      
      if (totalHours <= 0) {
        toast("请至少填写一个人员的工时");
        return false;
      }
      
      const now = new Date().toISOString();
      
      p.status = "已完工";
      p.actualHours = totalHours;
      p.finished_at = now;
      
      const newLogs = logs.map(log => ({ id: uid(), ...log }));
      const newLogKeys = new Set(newLogs.map(l => `${l.workerId}_${l.date}`));
      const preservedLogs = (p.workLogs || []).filter(l => !newLogKeys.has(`${l.workerId}_${l.date}`));
      p.workLogs = [...preservedLogs, ...newLogs];
      
      if (MODE === "cloud" && cloudConfigured()) {
        sb.from("work_logs").delete().eq("project_id", id).eq("date", dateStr).then(() => {
          return Promise.all([
            sb.from("projects").update({ status: "已完工", actualHours: p.actualHours, finished_at: now, updated_at: now }).eq("id", id),
            ...logs.map(log => sb.from("work_logs").insert({
              id: log.id, project_id: id, worker_id: log.workerId,
              worker_name: log.workerName, hours: log.hours, date: log.date, note: log.note,
              is_outsourced: log.isOutsourced || false
            }))
          ]);
        }).then(() => {
          toast(`项目已完工，总工时：${totalHours}小时`);
          renderConstruction();
        }).catch(() => {
          toast("更新失败");
        });
      } else {
        saveLocal();
        toast(`项目已完工，总工时：${totalHours}小时`);
        renderConstruction();
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

function collectStats() {
  const month = document.getElementById("statsMonth").value;
  const workerFilter = document.getElementById("statsWorker").value;
  const rows = {};
  cache.projects.forEach((p) => {
    (p.workLogs || []).forEach((l) => {
      if (month && monthKey(l.date) !== month) return;
      if (workerFilter && l.workerId !== workerFilter) return;
      const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
      const key = l.id || l.workerId || l.workerName;
      if (!rows[key]) {
        rows[key] = { name: l.workerName || "未知", hours: 0, levelHours: {初级:0, 中级:0, 高级:0, 特级:0}, days: new Set(), projects: new Set(), daily: {}, leaveDays: new Set(), leaveRecords: [], isOutsourced };
      }
      const level = l.level || "中级";
      rows[key].hours += Number(l.hours) || 0;
      rows[key].levelHours[level] += Number(l.hours) || 0;
      rows[key].days.add(fmtDate(l.date));
      rows[key].projects.add(p.name);
      const dayKey = l.date;
      if (!rows[key].daily[dayKey]) {
        rows[key].daily[dayKey] = [];
      }
      rows[key].daily[dayKey].push({ hours: Number(l.hours) || 0, level: level });
    });
  });
  
  cache.leaveRecords.forEach((l) => {
    if (l.status !== "approved") return;
    if (workerFilter && l.workerId !== workerFilter) return;
    if (!rows[l.workerId]) {
      const w = getWorker(l.workerId);
      rows[l.workerId] = { name: l.workerName || (w ? w.name : "未知"), hours: 0, days: new Set(), projects: new Set(), daily: {}, leaveDays: new Set(), leaveRecords: [], isOutsourced: false };
    }
    const start = new Date(l.startDate);
    const end = new Date(l.endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateKey = fmtDate(d);
      if (month && monthKey(dateKey) !== month) continue;
      rows[l.workerId].leaveDays.add(dateKey);
    }
    if (!month || (monthKey(l.startDate) === month || monthKey(l.endDate) === month)) {
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
  const month = document.getElementById("statsMonth").value;
  const workerFilter = document.getElementById("statsWorker").value;
  return cache.projects
    .filter((p) => !month || monthKey(p.appointmentTime) === month)
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
        store: storeName(p.storeId)
      };
    })
    .sort((a, b) => b.diff - a.diff);
}

function renderStats() {
  const rows = collectStats();
  const totalHours = rows.reduce((s, r) => s + r.hours, 0);

  const projRows = collectProjectStats();
  const recorded = projRows.filter((r) => r.hasActual);
  const totalEst = recorded.reduce((s, r) => s + r.est, 0);
  const totalAct = rows.reduce((s, r) => s + r.hours, 0);
  const totalDiff = totalAct - totalEst;
  
  const totalOutsourcedHours = rows.filter(r => r.isOutsourced).reduce((s, r) => s + r.hours, 0);
  const totalOutsourcedWorkers = rows.filter(r => r.isOutsourced).length;

  const summary = document.getElementById("statsSummary");
  summary.innerHTML = `
    <div class="stat-card"><div class="num">${rows.length}</div><div class="lbl">参与施工人数</div></div>
    <div class="stat-card"><div class="num">${totalHours}</div><div class="lbl">合计安装工时(小时)</div></div>
    <div class="stat-card"><div class="num">${totalEst}</div><div class="lbl">预计工时(小时)</div></div>
    <div class="stat-card"><div class="num">${totalAct}</div><div class="lbl">实际工时(小时)</div></div>
    <div class="stat-card"><div class="num" style="color:#8b5cf6">${totalOutsourcedHours}h</div><div class="lbl">外协工时</div></div>
    <div class="stat-card"><div class="num" style="color:#8b5cf6">${totalOutsourcedWorkers}人</div><div class="lbl">外协人员</div></div>
    <div class="stat-card"><div class="num" style="color:${diffColor(totalDiff)}">${fmtSignedDiff(totalDiff)}</div><div class="lbl">工时差异</div></div>
  `;

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
            calGrid += `<div class="worker-cal-cell ${hours ? "has-hours" : ""} ${isLeaveDay ? "leave-day" : ""}">
              <div class="day-num">${day}</div>
              ${hours ? `<div class="day-hours">${hours}h</div>` : ""}
              ${isLeaveDay ? `<div class="day-leave">🏥</div>` : ""}
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
              logs.map((log) => `<div class="daily-item"><span class="daily-date">${esc(date)}</span><span class="daily-hours">${log.hours}h</span><span class="daily-level">${esc(log.level)}</span></div>`)
            ).join("")}
          </div>`;
          
        const rowColor = r.isOutsourced ? 'color:#8b5cf6' : '';
        return `
        <div class="detail-block" style="padding:0;overflow:hidden;margin-bottom:16px">
          <table class="data">
            <thead>
              <tr><th>施工人员</th><th>安装工时(小时)</th><th>初级</th><th>中级</th><th>高级</th><th>特级</th><th>施工天数</th><th>请假天数</th><th>参与项目数</th></tr>
            </thead>
            <tbody>
              <tr>
                <td style="${rowColor}">${esc(r.name)}${r.isOutsourced ? ' (外协)' : ''}</td>
                <td style="${rowColor}"><b>${r.hours}</b></td>
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
              <div style="font-weight:600;color:#dc2626;margin-bottom:8px">🏥 本月请假记录</div>
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
            <tr><td><b>合计</b></td><td><b>${totalHours}</b></td>
              <td>${rows.reduce((s, r) => s + (r.levelHours?.初级 || 0), 0)}</td>
              <td>${rows.reduce((s, r) => s + (r.levelHours?.中级 || 0), 0)}</td>
              <td>${rows.reduce((s, r) => s + (r.levelHours?.高级 || 0), 0)}</td>
              <td>${rows.reduce((s, r) => s + (r.levelHours?.特级 || 0), 0)}</td>
              <td colspan="3"></td>
            </tr>
          </tbody>
        </table>
      </div>`;

  const projectTable = projRows.length === 0
    ? `<div class="empty">所选月份暂无项目。</div>`
    : `
    <div class="detail-block" style="padding:0;overflow:hidden">
      <table class="data">
        <thead>
          <tr><th>日期</th><th>店面</th><th>项目</th><th>状态</th><th>预计工时</th><th>实际工时</th><th>差异(实际−预计)</th><th>初级</th><th>中级</th><th>高级</th><th>特级</th><th>施工人员工时</th><th style="color:#8b5cf6">外协人数</th></tr>
        </thead>
        <tbody>
          ${projRows.map((r) => {
            const internalWorkers = r.workerHours.map((w) => `${esc(w.name)} ${w.hours}h`).join("、");
            const outsourcedWorkers = r.outsourcedWorkerHours.map((w) => `<span style="color:#8b5cf6">${esc(w.name)} ${w.hours}h</span>`).join("、");
            const workerText = (internalWorkers || "") + (internalWorkers && outsourcedWorkers ? "、" : "") + (outsourcedWorkers || "");
            const outsourcedCount = r.outsourcedWorkerHours.length;
            return `
            <tr>
              <td>${r.date ? fmtDate(r.date) : "—"}</td>
              <td>${esc(r.store || "—")}</td>
              <td>${esc(r.name)}</td>
              <td><span class="badge ${r.status}">${r.status}</span></td>
              <td>${r.est}</td>
              <td>${r.hasActual ? r.act : "—"}</td>
              <td style="color:${r.hasActual ? diffColor(r.diff) : "var(--muted)"};font-weight:600">${r.hasActual ? fmtSignedDiff(r.diff) : "未登记"}</td>
              <td style="color:#6b7280">${r.levelHours?.初级 || 0}</td>
              <td style="color:#3b82f6">${r.levelHours?.中级 || 0}</td>
              <td style="color:#f59e0b">${r.levelHours?.高级 || 0}</td>
              <td style="color:#dc2626">${r.levelHours?.特级 || 0}</td>
              <td style="white-space:normal;max-width:320px">${workerText || `<span style="color:var(--muted)">—</span>`}</td>
              <td style="color:#8b5cf6;font-weight:600">${outsourcedCount > 0 ? outsourcedCount + "人" : "—"}</td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot>
          <tr><td colspan="4">合计（已登记实际）</td><td>${totalEst}</td><td>${totalAct}</td><td style="color:${diffColor(totalDiff)};font-weight:600">${fmtSignedDiff(totalDiff)}</td>
            <td>${projRows.reduce((s, r) => s + (r.levelHours?.初级 || 0), 0)}</td>
            <td>${projRows.reduce((s, r) => s + (r.levelHours?.中级 || 0), 0)}</td>
            <td>${projRows.reduce((s, r) => s + (r.levelHours?.高级 || 0), 0)}</td>
            <td>${projRows.reduce((s, r) => s + (r.levelHours?.特级 || 0), 0)}</td>
            <td></td><td style="color:#8b5cf6;font-weight:600">${totalOutsourcedWorkers}人</td>
          </tr>
        </tfoot>
      </table>
    </div>`;

  document.getElementById("statsTable").innerHTML = `
    <h3 class="stats-subhead">👷 人员安装工时</h3>
    ${workerTable}
    <h3 class="stats-subhead">📐 项目工时差异（预计 vs 实际）</h3>
    ${projectTable}`;
}

function exportStats() {
  const rows = collectStats();
  const projRows = collectProjectStats();
  if (rows.length === 0 && projRows.length === 0) { toast("暂无数据可导出"); return; }
  const month = document.getElementById("statsMonth").value || "全部";

  let html = `
<html xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<meta charset="utf-8"/>
<style>
table {border-collapse:collapse;font-family:Microsoft YaHei,sans-serif;font-size:12px;margin:0 auto;}
th {background:#4f46e5;color:#fff;font-weight:bold;text-align:center;padding:8px 12px;border:1px solid #e5e7eb;white-space:nowrap;}
td {border:1px solid #e5e7eb;padding:8px 12px;text-align:center;}
.num {text-align:right;}
.title {font-size:16px;font-weight:bold;margin:16px 0 8px;color:#1f2937;text-align:center;}
</style>
</head>
<body>
`;

  html += '<div class="title">👷 人员安装工时</div>\n<table>\n<col width="120"/><col width="100"/><col width="80"/><col width="80"/><col width="80"/><col width="80"/><col width="80"/><col width="80"/><col width="100"/>\n<tr><th>施工人员</th><th>安装工时(小时)</th><th>初级工时</th><th>中级工时</th><th>高级工时</th><th>特级工时</th><th>施工天数</th><th>请假天数</th><th>参与项目数</th></tr>';

  rows.forEach((r) => {
    html += '<tr>\n<td>' + esc(r.name) + (r.isOutsourced ? ' (外协)' : '') + '</td>\n<td class="num">' + r.hours + '</td>\n<td class="num">' + (r.levelHours?.初级 || 0) + '</td>\n<td class="num">' + (r.levelHours?.中级 || 0) + '</td>\n<td class="num">' + (r.levelHours?.高级 || 0) + '</td>\n<td class="num">' + (r.levelHours?.特级 || 0) + '</td>\n<td class="num">' + r.days + '</td>\n<td class="num">' + (r.leaveDays || 0) + '</td>\n<td class="num">' + r.projects + '</td>\n</tr>';
  });

  html += '<tr style="background:#f3f4f6;"><td style="font-weight:bold;">合计</td>\n<td class="num" style="font-weight:bold;">' + rows.reduce((s, r) => s + r.hours, 0) + '</td>\n<td class="num">' + rows.reduce((s, r) => s + (r.levelHours?.初级 || 0), 0) + '</td>\n<td class="num">' + rows.reduce((s, r) => s + (r.levelHours?.中级 || 0), 0) + '</td>\n<td class="num">' + rows.reduce((s, r) => s + (r.levelHours?.高级 || 0), 0) + '</td>\n<td class="num">' + rows.reduce((s, r) => s + (r.levelHours?.特级 || 0), 0) + '</td>\n<td colspan="3"></td></tr>\n</table>';

  html += '<div class="title">📅 每日工时明细</div>\n<table>\n<col width="120"/><col width="100"/><col width="100"/><col width="80"/><col width="80"/>\n<tr><th>施工人员</th><th>日期</th><th>工时(小时)</th><th>工时等级</th><th>是否请假</th></tr>';

  rows.forEach((r) => {
    Object.entries(r.daily).sort(([a], [b]) => a.localeCompare(b)).forEach(([date, logs]) => {
      const isLeave = r.leaveRecords && r.leaveRecords.some((lr) => date >= lr.startDate && date <= lr.endDate);
      logs.forEach((log) => {
        html += '<tr>\n<td>' + esc(r.name) + '</td>\n<td>' + date + '</td>\n<td class="num">' + log.hours + '</td>\n<td>' + esc(log.level) + '</td>\n<td>' + (isLeave ? '是' : '') + '</td>\n</tr>';
      });
    });
  });

  html += '</table>';

  const hasLeaves = rows.some((r) => r.leaveRecords && r.leaveRecords.length > 0);
  if (hasLeaves) {
    html += '<div class="title">🏥 请假记录</div>\n<table>\n<col width="120"/><col width="180"/><col width="300"/>\n<tr><th>施工人员</th><th>请假时段</th><th>请假原因</th></tr>';

    rows.forEach((r) => {
      if (!r.leaveRecords || r.leaveRecords.length === 0) return;
      r.leaveRecords.forEach((lr) => {
        html += '<tr>\n<td>' + esc(r.name) + '</td>\n<td>' + formatLeaveTime(lr) + '</td>\n<td>' + esc(lr.reason || '') + '</td>\n</tr>';
      });
    });

    html += '</table>';
  }

  html += '<div class="title">📐 项目工时差异</div>\n<table>\n<col width="100"/><col width="100"/><col width="250"/><col width="80"/><col width="80"/><col width="80"/><col width="100"/><col width="60"/><col width="60"/><col width="60"/><col width="60"/><col width="250"/><col width="80"/>\n<tr><th>日期</th><th>店面</th><th>项目</th><th>状态</th><th>预计工时</th><th>实际工时</th><th>差异</th><th>初级</th><th>中级</th><th>高级</th><th>特级</th><th>施工人员工时</th><th>外协人数</th></tr>';

  projRows.forEach((r) => {
    const internalWorkers = r.workerHours.map((w) => esc(w.name) + ' ' + w.hours + 'h').join('、');
    const outsourcedWorkers = r.outsourcedWorkerHours.map((w) => esc(w.name) + ' ' + w.hours + 'h').join('、');
    const workerText = (internalWorkers || '') + (internalWorkers && outsourcedWorkers ? '、' : '') + (outsourcedWorkers || '');
    const outsourcedCount = r.outsourcedWorkerHours.length;
    html += '<tr>\n<td>' + (r.date ? fmtDate(r.date) : '') + '</td>\n<td>' + esc(r.store || '') + '</td>\n<td>' + esc(r.name) + '</td>\n<td>' + r.status + '</td>\n<td class="num">' + r.est + '</td>\n<td class="num">' + (r.hasActual ? r.act : '') + '</td>\n<td class="num">' + (r.hasActual ? fmtSignedDiff(r.diff) : '未登记') + '</td>\n<td class="num">' + (r.levelHours?.初级 || 0) + '</td>\n<td class="num">' + (r.levelHours?.中级 || 0) + '</td>\n<td class="num">' + (r.levelHours?.高级 || 0) + '</td>\n<td class="num">' + (r.levelHours?.特级 || 0) + '</td>\n<td>' + workerText + '</td>\n<td class="num">' + (outsourcedCount > 0 ? outsourcedCount + '人' : '') + '</td>\n</tr>';
  });

  const recorded = projRows.filter((r) => r.hasActual);
  const totalEst = recorded.reduce((s, r) => s + r.est, 0);
  const totalAct = recorded.reduce((s, r) => s + r.act, 0);
  html += '<tr style="background:#f3f4f6;"><td colspan="4" style="font-weight:bold;">合计</td>\n<td class="num" style="font-weight:bold;">' + totalEst + '</td>\n<td class="num" style="font-weight:bold;">' + totalAct + '</td>\n<td class="num" style="font-weight:bold;">' + fmtSignedDiff(totalAct - totalEst) + '</td>\n<td class="num">' + projRows.reduce((s, r) => s + (r.levelHours?.初级 || 0), 0) + '</td>\n<td class="num">' + projRows.reduce((s, r) => s + (r.levelHours?.中级 || 0), 0) + '</td>\n<td class="num">' + projRows.reduce((s, r) => s + (r.levelHours?.高级 || 0), 0) + '</td>\n<td class="num">' + projRows.reduce((s, r) => s + (r.levelHours?.特级 || 0), 0) + '</td>\n<td colspan="2"></td></tr>\n</table>';

  html += '</body></html>';

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '工时统计_' + month + '.xls';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 Excel');
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
  if (!confirm(msg)) return;
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
  if (MODE !== "cloud" || !isManager()) { box.innerHTML = ""; return; }
  const accounts = await repo.loadProfiles();
  if (accounts.length === 0) { box.innerHTML = `<div class="empty">暂无账号。</div>`; return; }

  const roleOpts = (cur) => `<option value="">待分配</option>` +
    Object.keys(ROLE_LABEL).map((r) => `<option value="${r}" ${cur === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("");
  const storeOpts = (cur) => `<option value="">—</option>` +
    cache.stores.map((s) => `<option value="${s.id}" ${cur === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("");

  box.innerHTML = `
    <div class="detail-block" style="padding:0;overflow:hidden">
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
  await repo.setProfile(id, { name });
  toast("姓名已更新");
}

async function changeAccountRole(id, role) {
  await repo.setProfile(id, { role });
  toast("角色已更新");
  renderAccounts();
}

async function changeAccountStore(id, storeId) {
  await repo.setProfile(id, { storeId });
  toast("门店已更新");
}

async function deleteAccount(id, email) {
  if (!confirm(`确定要删除账号 ${email} 吗？此操作不可撤销。`)) return;
  await repo.deleteAccount(id);
  toast("账号已删除");
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
  PROJECT_COMPLETE: "完成项目",
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

async function logOperation(type, target, detail = "") {
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
  if (cache.operationLogs.length > 1000) {
    cache.operationLogs = cache.operationLogs.slice(0, 1000);
  }
  saveLocal();
  if (sb) {
    try {
      await sb.from("operation_logs").insert(log);
    } catch (e) {
      console.warn("保存操作日志失败:", e);
    }
  }
}

function showOperationLogs() {
  const logs = cache.operationLogs.slice(0, 100);
  
  const modalContent = `
    <div style="max-height:600px;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;">📝 操作日志</h3>
        ${logs.length > 0 ? `<button class="btn small" onclick="clearOperationLogs()" style="background:#ef4444;color:#fff;border:none">🗑️ 清除日志</button>` : ""}
      </div>
      ${logs.length > 0 ? logs.map(log => `
        <div style="border-bottom:1px solid #f3f4f6;padding:12px 0;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:bold;color:var(--primary)">${esc(log.typeLabel || log.type_label)}</span>
            <span style="font-size:12px;color:var(--muted)">${new Date(log.timestamp).toLocaleString()}</span>
          </div>
          <div style="margin-top:4px;font-size:13px;">目标：${esc(log.target)}</div>
          ${log.detail ? `<div style="margin-top:4px;font-size:12px;color:var(--muted)">详情：${esc(log.detail)}</div>` : ""}
          <div style="margin-top:4px;font-size:12px;color:#6b7280;">操作人：${esc(log.operatorName || log.operator_name)}（${ROLE_LABEL[log.operatorRole || log.operator_role] || log.operatorRole || log.operator_role}）</div>
        </div>
      `).join("") : `<div style="text-align:center;color:var(--muted);padding:40px;">暂无操作日志</div>`}
    </div>
  `;
  
  modal.open("操作日志", modalContent);
}

async function clearOperationLogs() {
  if (!confirm("确定要清除所有操作日志吗？此操作不可撤销。")) return;
  
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
    p.started_at || "",
    p.finished_at || "",
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
    status: row["状态"] || row["status"] || "预约中",
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
    project_id: projectId,
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
    stores: perm.manageStores(),
    accounts: perm.manageAccounts() && MODE === "cloud",
    rolePerms: perm.manageAccounts() && MODE === "cloud",
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

  const bottomNavVisible = {
    projects: role != null,
    calendar: role != null,
    construction: role != null,
    workers: role != null,
    leaves: role != null,
    stats: perm.viewStats(),
    storeStats: perm.viewStoreStats(),
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
    if (!confirm("该日期已存在节假日设置，确定覆盖吗？")) return;
  }
  
  await repo.saveHoliday({ date, name, isWorkday });
  await repo.loadAll();
  renderLeaves();
  modal.close();
  toast("节假日已保存");
}

async function deleteHoliday(id) {
  if (!confirm("确定删除该节假日设置？")) return;
  
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
    
    if (!confirm(`⚠️ 警告：\n\n该员工在此时间段有 ${conflicts.length} 个项目排期冲突！\n\n冲突项目：\n${conflictMsg}\n\n批准后可能导致项目延期或人员调配困难，确认批准吗？`)) {
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
  
  const note = prompt("请输入拒绝原因：");
  if (note === null) return;
  
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
    if (!confirm(`确定要撤回 ${record.workerName} 的 ${LEAVE_TYPE_LABEL[record.leaveType]} 批准吗？`)) return;
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
    if (!confirm(`确定要撤回您的 ${LEAVE_TYPE_LABEL[record.leaveType]} 申请吗？`)) return;
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
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
  "预约中": "booked",
  "施工中": "working",
  "已完工": "done",
  "已验收": "accepted",
  "已审核": "reviewed",
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
      <div class="cal-cell ${items.length ? "has" : ""} ${isToday ? "today" : ""} ${isSelected ? "selected" : ""}" onclick="selectCalDay('${ds}');">
        <div class="cal-daynum">${day}${countBadge}</div>
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
                         p.status === "施工中" ? "timeline-task-working" :
                         p.status === "已完工" ? "timeline-task-done" :
                         p.status === "已验收" ? "timeline-task-accepted" :
                         "timeline-task-default";

      const conflicts = hasInternal && !isCompleted(p) ? (p.assignedWorkerIds || []).reduce((total, wid) => {
        return total + assignConflicts(p, wid).length;
      }, 0) : 0;
      const conflictClass = conflicts >= 1 ? "timeline-task-conflict" : "";
      const overtimeClass = isOvertime ? "timeline-task-overtime" : "";
      const canDrag = p.status === "预约中";
      const dragAttr = canDrag
        ? `draggable="true" ondragstart="timelineDragStart(event)" ondragend="timelineDragEnd(event)" onmousedown="timelineDragMouseDown(event)"`
        : `draggable="false"`;
      const lockClass = canDrag ? "" : "timeline-task-locked";
      
      const isOverdue = p.status === "预约中" && !p.started_at && new Date() > end;
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
            <span>⏰ ${timeStr}</span>
            <span>⏱️ ${p.estimatedHours}h</span>
            <span>👥 需${p.workerCount || 1}人</span>
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
          return `<div class="tl-leave-section"><div class="tl-leave-header">🏥 近期请假人员</div><div class="tl-leave-list">${leaveInfo.join("")}</div></div>`;
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
    if (hasLeaveConflict) label += ' 🏥请假';
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
        ${cache.outsourcedWorkers.length > 0 ? `
        <div class="tl-menu-assign-form" style="margin-bottom:6px;">
          <select class="input" id="tlMenuOutsourcedSelect" onchange="timelineAddOutsourcedWorker('${p.id}', this.value)">
            <option value="">从常用外协人员列表添加</option>
            ${cache.outsourcedWorkers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}${w.phone ? ` (${esc(w.phone)})` : ''}</option>`).join("")}
          </select>
        </div>` : ""}
        <div class="tl-menu-assign-form">
          <input type="text" class="input" id="tlMenuOutsourcedInput" placeholder="输入外协姓名" value="${esc(p.outsourcedWorkers || "")}" style="flex:1">
          <button class="btn small" onclick="timelineSaveOutsourced('${p.id}', document.getElementById('tlMenuOutsourcedInput').value)">保存</button>
        </div>
        ${p.outsourcedWorkers ? `<div class="tl-menu-outsourced-hint">已设置外协，不占用内部人员</div>` : ""}
      </div>
    </div>` : `<div class="tl-menu-info"><div><span>人员</span><b>${esc(workers)}</b></div></div>`}
    <div class="tl-menu-actions">
      <button class="btn small primary" onclick="closeTimelineActionMenu(); gotoConstruction('${p.id}')">施工管理</button>
      ${p.repairOrder && p.repairOrder.status === "待维修" && (isManager() || isWorker()) ? `<button class="btn small" onclick="closeTimelineActionMenu(); completeRepair('${p.id}')">✅ 完成维修</button>` : ""}
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
    const msg = `${w ? w.name : "该人员"} 在此时间段已被分配到：\n` +
      conflicts.map((c) => `· ${c.name}（${fmtTimeRange(c)}）`).join("\n") +
      `\n\n存在时间冲突，仍要分配吗？`;
    if (!confirm(msg)) {
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
  await repo.setAssignedWorkers(pid, (getProject(pid).assignedWorkerIds || []).filter((x) => x !== wid));
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

function timelineAddOutsourcedWorker(pid, name) {
  if (!name) return;
  const input = document.getElementById("tlMenuOutsourcedInput");
  const sel = document.getElementById("tlMenuOutsourcedSelect");
  if (!input) return;
  const current = input.value.trim();
  const names = current ? current.split(",").map(n => n.trim()).filter(n => n) : [];
  if (!names.includes(name)) {
    names.push(name);
    input.value = names.join(", ");
  }
  if (sel) sel.value = "";
}

/* 时间线保存外协人员 */
async function timelineSaveOutsourced(pid, names) {
  const p = getProject(pid);
  if (!p) return;
  await repo.saveProject({ outsourcedWorkers: names.trim() }, pid);
  await repo.loadAll();
  renderTimelineInDetail();
  setTimeout(() => {
    const taskEl = document.querySelector(`.timeline-task[data-project-id="${pid}"]`);
    if (taskEl) {
      openTimelineActionMenu(taskEl, pid);
    }
  }, 100);
  toast(names.trim() ? "外协已保存，不占用内部施工人员" : "外协已清除");
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
    localStorage.setItem("auth_password", password);
    localStorage.setItem("auth_remember", "true");
  } else {
    localStorage.removeItem("auth_email");
    localStorage.removeItem("auth_password");
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
    const savedPassword = localStorage.getItem("auth_password");
    if (remember === "true" && savedEmail && savedPassword) {
      document.getElementById("authEmail").value = savedEmail;
      document.getElementById("authPassword").value = savedPassword;
      document.getElementById("authRemember").checked = true;
      const { error } = await sb.auth.signInWithPassword({ email: savedEmail, password: savedPassword });
      if (!error) {
        await startCloudSession();
        return;
      }
    }
    document.getElementById("authScreen").classList.remove("hidden");
    if (savedEmail) {
      document.getElementById("authEmail").value = savedEmail;
      document.getElementById("authRemember").checked = true;
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
  if (!confirm("⚠️ 危险操作：将把本机浏览器保存的历史数据上传到云端（不会删除本地数据）。确定继续？")) return;

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
  if (!confirm("⚠️ 危险操作：将把云端数据导出到本地浏览器存储，会覆盖本地已有数据。确定继续？")) return;
  
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
  document.getElementById("modalConfirm").addEventListener("click", () => {
    if (modalOnConfirm) {
      const result = modalOnConfirm();
      if (result !== false) {
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
  document.getElementById("projectStatusFilter").addEventListener("change", renderProjects);
  document.getElementById("projectStoreFilter").addEventListener("change", renderProjects);

  document.getElementById("constructionProjectSelect").addEventListener("change", (e) => {
    currentProjectId = e.target.value;
    renderConstruction();
  });

  document.getElementById("calPrev").addEventListener("click", calPrevMonth);
  document.getElementById("calNext").addEventListener("click", calNextMonth);
  document.getElementById("calToday").addEventListener("click", calGotoToday);
  document.getElementById("calToggleView").addEventListener("click", toggleCalView);

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("statsMonth").value = thisMonth;
  document.getElementById("statsMonth").addEventListener("change", renderStats);
  document.getElementById("statsWorker").addEventListener("change", renderStats);
  document.getElementById("btnExportStats").addEventListener("click", exportStats);

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
    }
    await startCloudSession();
  } else {
    MODE = "local";
    setSyncStatus("", "● 本地模式");
    currentProfile = { role: ROLE.MANAGER, storeId: null }; // 本地单机为全权限
    await repo.loadAll();
    renderRoleInfo();
    applyPermissions();
    renderAll();
  }
}

document.addEventListener("DOMContentLoaded", init);

/* ---------- PWA：注册 Service Worker（离线可用 / 可安装到主屏 / 自动更新） ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((registration) => {
      registration.update();
      
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.location.reload();
      });
      
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data && e.data.type === "VERSION_UPDATED") {
          if (confirm(`应用已更新至新版本 ${e.data.version}！是否立即刷新？`)) {
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
      if (document.body.classList.contains("timeline-view")) {
        const activeTab = document.querySelector(".tab-panel.active");
        if (activeTab) {
          if (activeTab.id === "calendar") {
            renderCalendar();
          } else if (activeTab.id === "workers") {
            renderWorkers();
          }
        }
      }
    }, 200);
  });
}

function showHelp() {
  window.open("help.html", "_blank");
}
