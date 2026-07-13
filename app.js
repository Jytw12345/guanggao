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
const cache = { workers: [], projects: [], stores: [] };

/* 角色 */
const ROLE = { MANAGER: "manager", STORE: "store_manager", WORKER: "worker" };
const ROLE_LABEL = { manager: "总经理", store_manager: "店长", worker: "施工人员" };

/* 运行时状态 */
let MODE = "local";        // 'cloud' | 'local'
let sb = null;             // supabase client
let sbAdmin = null;        // supabase admin client (for deleteUser)
let currentUser = null;    // 云端登录用户
let currentProfile = { role: null, storeId: null }; // 当前用户角色与门店
let reloadTimer = null;    // 实时刷新去抖

const getWorker = (id) => cache.workers.find((w) => w.id === id);
const getProject = (id) => cache.projects.find((p) => p.id === id);
const getStore = (id) => cache.stores.find((s) => s.id === id);
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
  manage_stores: "管理门店",
  review_project: "审核项目（审核后不可编辑）",
};

/* 默认权限模板（与 SQL seed 一致）；云端会用 role_permissions 表覆盖 */
const DEFAULT_ROLE_PERMS = {
  store_manager: {
    project_create: true, project_edit: true, project_delete: true,
    assign_worker: false, construction: false, view_stats: false,
    view_store_stats: false, manage_stores: false, manage_workers: false,
    review_project: true,
  },
  worker: {
    project_create: false, project_edit: false, project_delete: false,
    assign_worker: true, construction: true, view_stats: false,
    view_store_stats: false, manage_stores: false, manage_workers: false,
    review_project: false,
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
  const el = document.getElementById("pSpanHint");
  if (!el) return;
  const start = document.getElementById("pTime").value;
  const end = document.getElementById("pEnd").value;
  if (!start || !end) { el.textContent = ""; return; }
  const s = new Date(start), e = new Date(end);
  if (isNaN(s) || isNaN(e)) { el.textContent = ""; return; }
  if (e <= s) {
    el.innerHTML = `<span style="color:var(--danger)">结束时间需晚于开始时间</span>`;
    return;
  }
  const mins = Math.round((e - s) / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  const span = `${h ? h + " 小时 " : ""}${m || !h ? m + " 分钟" : ""}`.trim();
  el.textContent = `现场占用时长：${span}`;
}

function sumHours(project) {
  return (project.workLogs || []).reduce((s, l) => s + (Number(l.hours) || 0), 0);
}

/* 工时差异：实际 - 预计。actualHours>0 视为已登记实际工时 */
function hoursDiff(project) {
  const est = Number(project.estimatedHours) || 0;
  const act = Number(project.actualHours) || 0;
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

/* ============================================================
 * 推送通知功能
 * ============================================================ */
let notificationPermissionGranted = false;
let lastNotificationTime = {};

async function requestNotificationPermission() {
  if ("Notification" in window && !notificationPermissionGranted) {
    const permission = await Notification.requestPermission();
    notificationPermissionGranted = permission === "granted";
    if (notificationPermissionGranted) {
      toast("通知权限已开启");
    }
  }
}

function showPushNotification(title, body, icon = "icons/icon-192.png", data = {}) {
  if (!("Notification" in window)) return;

  const key = title + body;
  const now = Date.now();
  if (lastNotificationTime[key] && now - lastNotificationTime[key] < 30000) {
    return;
  }
  lastNotificationTime[key] = now;

  if (!notificationPermissionGranted) {
    requestNotificationPermission();
    return;
  }

  try {
    const notification = new Notification(title, {
      body,
      icon,
      data,
      badge: "icons/icon-192.png",
      requireInteraction: false,
      timestamp: now,
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
      if (data.projectId) {
        openProjectDetail(data.projectId);
      }
    };
  } catch (e) {
    console.error("推送通知失败", e);
  }
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

function sendNotificationForProjectChange(eventType, project) {
  if (!project) return;

  const store = getStore(project.storeId);
  const storeName = store ? store.name : "未知门店";

  switch (eventType) {
    case "new":
      showPushNotification(
        "📋 新预约提醒",
        `门店「${storeName}」新增项目：${project.name}`,
        "icons/icon-192.png",
        { projectId: project.id }
      );
      showNotificationAlert(`📋 新预约：${project.name}（${storeName}）`);
      break;
    case "start":
      showPushNotification(
        "🏗️ 施工开始提醒",
        `项目「${project.name}」已开始施工`,
        "icons/icon-192.png",
        { projectId: project.id }
      );
      showNotificationAlert(`🏗️ 施工开始：${project.name}`);
      break;
    case "done":
      showPushNotification(
        "✅ 施工完成提醒",
        `项目「${project.name}」已完工，请安排验收`,
        "icons/icon-192.png",
        { projectId: project.id }
      );
      showNotificationAlert(`✅ 施工完成：${project.name}`);
      break;
    case "accepted":
      showPushNotification(
        "🎉 验收通过提醒",
        `项目「${project.name}」已验收通过`,
        "icons/icon-192.png",
        { projectId: project.id }
      );
      showNotificationAlert(`🎉 验收通过：${project.name}`);
      break;
    case "update":
      showPushNotification(
        "📝 项目更新提醒",
        `项目「${project.name}」信息已更新`,
        "icons/icon-192.png",
        { projectId: project.id }
      );
      showNotificationAlert(`📝 项目更新：${project.name}`);
      break;
  }
}

/* ============================================================
 * 字段映射（云端 snake_case <-> 前端 camelCase）
 * ============================================================ */
let modifiedProjectIds = new Set();

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
});

/* ============================================================
 * 数据仓储层（统一接口，内部按 MODE 分流）
 * 上层业务只调用 repo.xxx，不关心存在哪
 * ============================================================ */
const repo = {
  /* ---- 载入全部数据到 cache ---- */
  async loadAll() {
    if (MODE === "cloud") {
      const [wRes, pRes, lRes, sRes, rpRes] = await Promise.all([
        sb.from("workers").select("*"),
        sb.from("projects").select("*"),
        sb.from("work_logs").select("*"),
        sb.from("stores").select("*"),
        sb.from("role_permissions").select("*"),
      ]);
      if (wRes.error || pRes.error || lRes.error || sRes.error) {
        console.error(wRes.error || pRes.error || lRes.error || sRes.error);
        toast("云端数据读取失败，请检查建表脚本是否已执行");
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

  /* ---- 项目 ---- */
  async saveProject(project, id) {
    if (MODE === "cloud") {
      const base = id ? { ...getProject(id), ...project } : { id: uid(), actualHours: 0, ...project };
      const row = projectToRow(base);
      if (!id && currentUser) row.created_by = currentUser.id;
      const { error } = await sb.from("projects").upsert(row);
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
      };
      const { error } = await sb.from("work_logs").insert(row);
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
};

function fail(error) {
  console.error(error);
  toast("云端操作失败：" + (error.message || "未知错误"));
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
  localStorage.setItem(STORE_KEY, JSON.stringify({ workers: cache.workers, projects: cache.projects, stores: cache.stores }));
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
function renderWorkers() {
  const list = document.getElementById("workerList");
  const today = fmtDate(new Date());
  const canManage = perm.manageWorkers();
  const isWorkerRole = myRole() === ROLE.WORKER;
  
  if (isWorkerRole) {
    renderWorkerScheduleForWorker(today);
    return;
  }
  
  if (cache.workers.length === 0) {
    list.innerHTML = `<div class="empty">暂无施工人员，点击右上角「添加人员」创建。</div>`;
    return;
  }
  
  const timelineHtml = renderWorkerScheduleHtml(today);
  
  list.innerHTML = `
    <div id="workerScheduleSection" style="margin-bottom: 24px;">
      <div class="section-head" style="margin-bottom: 12px;">
        <h3 style="margin:0; font-size:16px;">📅 今日施工时间安排</h3>
        <button class="btn small primary" onclick="renderWorkers()">🔄 刷新</button>
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
            <button class="btn small" onclick="editWorker('${w.id}')">编辑</button>
            <button class="btn small danger" onclick="deleteWorker('${w.id}')">删除</button>
            <button class="btn small" onclick="renderWorkerSchedule('${today}', '${w.id}')">查看安排</button>
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
        <div class="timeline-task ${statusClass}" style="left:${left}px; width:${width}px; height:40px;">
          <div class="timeline-task-header">
            <span class="timeline-task-name" style="font-size:11px;">${esc(p.name)}</span>
          </div>
          <div class="timeline-task-body" style="font-size:9px;">
            ${esc(storeName(p.storeId))} · ${timeStr}
          </div>
        </div>`;
    });
    
    lanesHtml += `
      <div class="tl-lane" style="height:50px; border-bottom:1px solid #eee; display:flex;">
        <div class="tl-lane-label" style="width:60px; flex-shrink:0; padding:5px; font-size:12px; font-weight:bold;">${esc(w.name)}</div>
        <div class="tl-lane-body" style="flex:1; position:relative; height:50px;">
          <div class="tl-bg-work" style="left:${workBgLeft}px; width:${workBgWidth}px; height:100%;"></div>
          <div class="tl-bg-overtime" style="width:${workBgLeft}px; height:100%;"></div>
          <div class="tl-bg-overtime" style="left:${workBgLeft + workBgWidth}px; width:${totalWidth - workBgLeft - workBgWidth}px; height:100%;"></div>
          <div class="tl-tasks">${tasksHtml}</div>
        </div>
      </div>`;
  });
  
  return `
    <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">绿色区域为工作时间(8:00-18:00)，橙色区域为加班时间</div>
    <div class="tl-wrapper" style="width:100%;">
      <div class="timeline-horizontal" style="width:100%; min-width:${totalWidth + 60}px;">
        <div class="tl-axis" style="width:100%; margin-left:60px;">${hourMarks.join("")}</div>
        <div class="tl-scroll" style="max-height:${workers.length * 50 + 50}px;">
          ${lanesHtml}
        </div>
      </div>
    </div>`;
}

function renderWorkerScheduleForWorker(dateStr) {
  const list = document.getElementById("workerList");
  if (!list) return;
  
  document.body.classList.add("timeline-view");
  
  list.innerHTML = `
    <div id="workerScheduleSection" style="margin-bottom: 16px;">
      <p class="hint" style="font-size:12px;">📅 ${dateStr} 施工人员时间安排</p>
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

function newWorker() { modal.open("添加施工人员", workerForm()); }
function editWorker(id) { modal.open("编辑施工人员", workerForm(getWorker(id))); }

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
  const used = cache.projects.some((p) => (p.workLogs || []).some((l) => l.workerId === id));
  if (used && !confirm("该人员已有施工工时记录，删除不会移除历史记录。确定删除该人员？")) return;
  if (!used && !confirm("确定删除该人员？")) return;
  await repo.deleteWorker(id);
  await repo.loadAll();
  renderAll();
  toast("已删除");
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
    
    return `
      <div class="card ${isOverdue ? "card-overdue" : ""}">
        <div class="card-title">
          <h3>${esc(p.name)}</h3>
          <div style="display: flex; gap: 4px;">
            <span class="badge ${p.status}">${p.status}</span>
            ${isOverdue ? `<span class="badge overdue">🔴 超期</span>` : ""}
            ${p.timeModified ? `<span class="badge modified">✏️ 已改点</span>` : ""}
          </div>
        </div>
        <div class="card-row"><span>预约门店</span><b>${esc(storeName(p.storeId))}</b></div>
        <div class="card-row"><span>客户</span><b>${esc(p.customer || "—")}</b></div>
        <div class="card-row"><span>联系电话</span><b>${p.phone ? `<a href="tel:${esc(p.phone)}" style="color:var(--info)">${esc(p.phone)}</a>` : "—"}</b></div>
        <div class="card-row"><span>安装地址</span><b>${esc(p.address || "—")}</b></div>
        <div class="card-row"><span>预约时段</span><b>${fmtTimeRange(p)}</b></div>
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

function projectForm(p = {}) {
  const storeLocked = isStoreManager();
  const selectedStore = p.storeId || (storeLocked ? myStore() : "");
  const storeOpts = `<option value="">未指定门店</option>` +
    cache.stores.map((s) =>
      `<option value="${s.id}" ${s.id === selectedStore ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  return `
    <div class="form-row">
      <label>项目名称 *</label>
      <input class="input" id="pName" value="${esc(p.name || "")}" placeholder="如：某某商场门头广告安装" />
    </div>
    <div class="form-row">
      <label>所属门店</label>
      <select class="input" id="pStore" ${storeLocked ? "disabled" : ""}>
        ${storeOpts}
      </select>
      ${storeLocked ? `<small class="hint">店长只能创建本门店（${esc(storeName(myStore()))}）的预约</small>` : ""}
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label>客户名称</label>
        <input class="input" id="pCustomer" value="${esc(p.customer || "")}" placeholder="客户 / 单位" />
      </div>
      <div class="form-row">
        <label>联系电话</label>
        <input class="input" id="pPhone" value="${esc(p.phone || "")}" placeholder="客户电话" />
      </div>
    </div>
    <div class="form-row">
      <label>安装地址</label>
      <input class="input" id="pAddress" value="${esc(p.address || "")}" placeholder="施工现场地址" />
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label>开始时间 *</label>
        <input class="input" type="datetime-local" id="pTime" value="${esc(p.appointmentTime || "")}" oninput="updateSpanHint()" />
      </div>
      <div class="form-row">
        <label>结束时间 *</label>
        <input class="input" type="datetime-local" id="pEnd" value="${esc(p.endTime || "")}" oninput="updateSpanHint()" />
      </div>
    </div>
    <div class="form-row" style="margin-top:-6px">
      <small class="hint" id="pSpanHint" style="margin:0"></small>
    </div>
    <div class="form-row">
      <label>预计工时（人·小时，用于统计）</label>
      <input class="input" type="number" min="0" step="0.5" id="pEst" value="${esc(p.estimatedHours ?? "")}" placeholder="0" />
      <small class="hint" style="margin:2px 0 0">按人工总量填写，与现场时长无关。例：6 人·小时的活，2 人同时施工约 3 小时完工。</small>
    </div>
    <div class="form-row">
      <label>外协工时（人·小时，用于统计）</label>
      <input class="input" type="number" min="0" step="0.5" id="pOutsourcedHours" value="${esc(p.outsourcedHours ?? "")}" placeholder="0" />
      <small class="hint" style="margin:2px 0 0">外协人员完成的工时，与预计工时分开统计。</small>
    </div>
    <div class="form-row">
      <label>项目状态</label>
      <select class="input" id="pStatus">
        ${Object.values(STATUS).map((s) =>
          `<option value="${s}" ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
    <div class="form-row">
      <label>备注</label>
      <textarea class="input" id="pNote" placeholder="施工内容 / 注意事项">${esc(p.note || "")}</textarea>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="modal.close()">取消</button>
      <button class="btn primary" onclick="saveProject('${p.id || ""}')">保存</button>
    </div>`;
}

function newProject() { modal.open("新建项目预约", projectForm({ status: STATUS.BOOKED })); updateSpanHint(); }
function editProject(id) { modal.open("编辑项目", projectForm(getProject(id))); updateSpanHint(); }

async function saveProject(id) {
  if (id && isReviewed(getProject(id))) {
    toast("已审核的项目无法编辑");
    return;
  }
  const name = document.getElementById("pName").value.trim();
  const time = document.getElementById("pTime").value;
  const end = document.getElementById("pEnd").value;
  if (!name) { toast("请填写项目名称"); return; }
  if (!time) { toast("请选择开始时间"); return; }
  if (!end) { toast("请选择结束时间"); return; }
  if (new Date(end) <= new Date(time)) { toast("结束时间需晚于开始时间"); return; }
  const storeEl = document.getElementById("pStore");
  let storeId = storeEl ? storeEl.value : "";
  if (isStoreManager()) storeId = myStore();          // 店长强制本门店
  const payload = {
    name,
    customer: document.getElementById("pCustomer").value.trim(),
    phone: document.getElementById("pPhone").value.trim(),
    address: document.getElementById("pAddress").value.trim(),
    appointmentTime: time,
    endTime: end,
    estimatedHours: Number(document.getElementById("pEst").value) || 0,
    outsourcedHours: Number(document.getElementById("pOutsourcedHours").value) || 0,
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
  
  await repo.saveProject({ 
    repairOrder,
    appointmentTime: new Date(time).toISOString()
  }, projectId);
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
  
  await repo.saveProject({ 
    repairOrder: { 
      ...getProject(projectId).repairOrder, 
      status: "已完成",
      completedAt: new Date().toISOString()
    } 
  }, projectId);
  await repo.loadAll();
  openProjectDetail(projectId);
  toast("维修已完成");
}

async function deleteProject(id) {
  if (!confirm("确定删除该项目及其施工记录？")) return;
  await repo.deleteProject(id);
  if (currentProjectId === id) currentProjectId = "";
  await repo.loadAll();
  renderAll();
  toast("已删除");
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

function renderConstruction() {
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
          <td>${esc(l.note || "—")}</td>
          <td>${canEdit ? `<button class="btn small danger" onclick="deleteWorkLog('${p.id}','${l.id}')">删除</button>` : ""}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" style="color:var(--muted)">暂无施工工时记录</td></tr>`;

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
  const assignSelectOpts = cache.workers
    .filter((w) => !assigned.includes(w.id))
    .map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("");
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
        <div class="info-item"><div class="k">外协工时</div><div class="v" style="color:#8b5cf6;font-weight:600">${Math.max(p.outsourcedHours, p.outsourcedHoursFromLogs) || 0} 小时</div></div>
        <div class="info-item"><div class="k">工程实际用工时</div><div class="v">${p.actualHours || 0} 小时</div></div>
        <div class="info-item"><div class="k">工时差异（实际−预计）</div><div class="v">${diffLabel(p)}</div></div>
        ${p.started_at ? `<div class="info-item"><div class="k">⏰ 开始施工时间</div><div class="v">${esc(fmtDateTime(p.started_at))}</div></div>` : ""}
        ${p.finished_at ? `<div class="info-item"><div class="k">✅ 完工时间</div><div class="v">${esc(fmtDateTime(p.finished_at))}</div></div>` : ""}
        ${p.started_at && p.finished_at ? `<div class="info-item"><div class="k">⏱️ 实际施工时长</div><div class="v"><b>${esc(calcDuration(p.started_at, p.finished_at))}</b></div></div>` : ""}
      </div>
      ${canEdit ? `
      <div class="form-grid" style="margin-top:14px">
        <div class="form-row" style="margin:0">
          <label>更新项目状态</label>
          <select class="input" id="cStatus" onchange="updateProjectStatus('${p.id}', this.value)">
            ${Object.values(STATUS).map((s) =>
              `<option value="${s}" ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div class="form-row" style="margin:0">
          <label>工程实际用工时（小时）</label>
          <div style="display:flex;gap:8px">
            <input class="input" type="number" min="0" step="0.5" id="cActual" value="${p.actualHours || 0}" />
            <button class="btn primary" onclick="saveActualHours('${p.id}')">保存</button>
          </div>
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
      ${(reviewed || p.status === "已验收") && isManager() ? `
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
      ${isManager() && p.repairOrder.status === "待维修" ? `
      <div class="card-actions" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn primary" onclick="completeRepair('${p.id}')">✅ 完成维修</button>
      </div>` : ""}
    </div>` : ""}

    ${assignBlock}

    <div class="detail-block">
      <h3>👷 施工人员工时（分人填写）</h3>
      <table class="data">
        <thead>
          <tr><th>施工人员</th><th>施工日期</th><th>施工工时</th><th>说明</th><th></th></tr>
        </thead>
        <tbody>${logsRows}</tbody>
        <tfoot>
          <tr><td colspan="2">合计施工工时</td><td colspan="3">${totalHours} 小时</td></tr>
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
          <input class="input" id="logOutsourcedName" placeholder="输入外协人员姓名" />
        </div>
        <div class="field">
          <label>施工日期</label>
          <input class="input" type="date" id="logDate" value="${new Date().toISOString().slice(0,10)}" />
        </div>
        <div class="field">
          <label>施工工时(小时)</label>
          <input class="input" type="number" min="0" step="0.5" id="logHours" placeholder="0" style="width:120px" />
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
          <div class="info-item"><div class="k">验收结果</div><div class="v">${esc(ac.quality)}</div></div>
        </div>
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

async function addWorkLog(id) {
  const p = getProject(id);
  const type = document.getElementById("logType").value;
  const hours = Number(document.getElementById("logHours").value);
  const date = document.getElementById("logDate").value;
  const note = document.getElementById("logNote").value.trim();
  
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
  
  await repo.addWorkLog(id, { workerId, workerName, hours, date, note, isOutsourced: type === "outsourced" });
  if (p.status === STATUS.BOOKED) await repo.patchProject(id, { status: STATUS.WORKING, started_at: new Date().toISOString() });
  await repo.loadAll();
  renderAll();
  toast("已添加施工工时");
}

async function deleteWorkLog(pid, lid) {
  await repo.deleteWorkLog(pid, lid);
  await repo.loadAll();
  renderAll();
  toast("已删除");
}

function openAcceptance(id) {
  const p = getProject(id);
  const ac = p.acceptance || {};
  modal.open("填写验收信息", `
    <div class="form-grid">
      <div class="form-row">
        <label>验收人 *</label>
        <input class="input" id="acBy" value="${esc(ac.acceptedBy || "")}" placeholder="验收负责人" />
      </div>
      <div class="form-row">
        <label>验收时间</label>
        <input class="input" type="date" id="acAt" value="${esc(ac.acceptedAt || new Date().toISOString().slice(0,10))}" />
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
      <label>验收备注</label>
      <textarea class="input" id="acNote" placeholder="现场情况、遗留问题等">${esc(ac.note || "")}</textarea>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="modal.close()">取消</button>
      <button class="btn primary" onclick="saveAcceptance('${id}')">保存验收</button>
    </div>
  `);
}

async function saveAcceptance(id) {
  const by = document.getElementById("acBy").value.trim();
  if (!by) { toast("请填写验收人"); return; }
  const acceptance = {
    acceptedBy: by,
    acceptedAt: document.getElementById("acAt").value,
    quality: document.getElementById("acQuality").value,
    note: document.getElementById("acNote").value.trim(),
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
      if (!rows[l.workerId]) {
        rows[l.workerId] = { name: l.workerName, hours: 0, days: new Set(), projects: new Set(), daily: {}, isOutsourced };
      }
      rows[l.workerId].hours += Number(l.hours) || 0;
      rows[l.workerId].days.add(fmtDate(l.date));
      rows[l.workerId].projects.add(p.name);
      const dayKey = l.date;
      if (!rows[l.workerId].daily[dayKey]) {
        rows[l.workerId].daily[dayKey] = 0;
      }
      rows[l.workerId].daily[dayKey] += Number(l.hours) || 0;
    });
  });
  return Object.values(rows).map((r) => ({
    name: r.name,
    hours: r.hours,
    days: r.days.size,
    projects: r.projects.size,
    daily: r.daily,
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
      const { est, act, diff, hasActual } = hoursDiff(p);
      // 按施工人员汇总工时（区分内部和外协）
      const workerMap = {};
      const outsourcedWorkerMap = {};
      (p.workLogs || []).forEach((l) => {
        if (workerFilter && l.workerId !== workerFilter) return;
        const isOutsourced = l.isOutsourced || (l.workerId && l.workerId.startsWith("outsourced:"));
        const nm = l.workerName || "未知";
        if (isOutsourced) {
          if (!outsourcedWorkerMap[nm]) outsourcedWorkerMap[nm] = 0;
          outsourcedWorkerMap[nm] += Number(l.hours) || 0;
        } else {
          if (!workerMap[nm]) workerMap[nm] = 0;
          workerMap[nm] += Number(l.hours) || 0;
        }
      });
      const workerHours = Object.entries(workerMap)
        .sort((a, b) => b[1] - a[1])
        .map(([name, hours]) => ({ name, hours, isOutsourced: false }));
      const outsourcedWorkerHours = Object.entries(outsourcedWorkerMap)
        .sort((a, b) => b[1] - a[1])
        .map(([name, hours]) => ({ name, hours, isOutsourced: true }));
      // 外协人员数量
      const outsourcedCount = (p.outsourcedWorkers || "").split(',').map(w => w.trim()).filter(w => w.length > 0).length;
      const totalOutsourcedHoursFromLogs = Object.values(outsourcedWorkerMap).reduce((sum, h) => sum + h, 0);
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
  const totalAct = recorded.reduce((s, r) => s + r.act, 0);
  const totalDiff = totalAct - totalEst;
  
  const totalOutsourcedHours = projRows.reduce((s, r) => s + Math.max(r.outsourcedHours || 0, r.outsourcedHoursFromLogs || 0), 0);
  const totalOutsourcedWorkers = projRows.reduce((s, r) => s + r.outsourcedWorkerHours.length, 0);

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
            const hours = r.daily[dateKey];
            calGrid += `<div class="worker-cal-cell ${hours ? "has-hours" : ""}">
              <div class="day-num">${day}</div>
              ${hours ? `<div class="day-hours">${hours}h</div>` : ""}
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
            ${Object.entries(r.daily).sort(([a], [b]) => a.localeCompare(b)).map(([date, hours]) => 
              `<div class="daily-item"><span class="daily-date">${esc(date)}</span><span class="daily-hours">${hours}h</span></div>`
            ).join("")}
          </div>`;
          
        const rowColor = r.isOutsourced ? 'color:#8b5cf6' : '';
        return `
        <div class="detail-block" style="padding:0;overflow:hidden;margin-bottom:16px">
          <table class="data">
            <thead>
              <tr><th>施工人员</th><th>安装工时(小时)</th><th>施工天数</th><th>参与项目数</th></tr>
            </thead>
            <tbody>
              <tr>
                <td style="${rowColor}">${esc(r.name)}${r.isOutsourced ? ' (外协)' : ''}</td>
                <td style="${rowColor}"><b>${r.hours}</b></td>
                <td>${r.days}</td>
                <td>${r.projects}</td>
              </tr>
            </tbody>
          </table>
          ${dailyTable}
        </div>`;
      }).join("") + `
      <div class="detail-block" style="padding:0;overflow:hidden">
        <table class="data">
          <tbody>
            <tr><td><b>合计</b></td><td><b>${totalHours}</b></td><td colspan="2"></td></tr>
          </tbody>
        </table>
      </div>`;

  const projectTable = projRows.length === 0
    ? `<div class="empty">所选月份暂无项目。</div>`
    : `
    <div class="detail-block" style="padding:0;overflow:hidden">
      <table class="data">
        <thead>
          <tr><th>日期</th><th>店面</th><th>项目</th><th>状态</th><th>预计工时</th><th>实际工时</th><th>差异(实际−预计)</th><th>施工人员工时</th><th style="color:#8b5cf6">外协人数</th></tr>
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
              <td style="white-space:normal;max-width:320px">${workerText || `<span style="color:var(--muted)">—</span>`}</td>
              <td style="color:#8b5cf6;font-weight:600">${outsourcedCount > 0 ? outsourcedCount + "人" : "—"}</td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot>
          <tr><td colspan="4">合计（已登记实际）</td><td>${totalEst}</td><td>${totalAct}</td><td style="color:${diffColor(totalDiff)};font-weight:600">${fmtSignedDiff(totalDiff)}</td><td></td><td style="color:#8b5cf6;font-weight:600">${totalOutsourcedWorkers}人</td></tr>
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

  const workerHeader = ["施工人员", "安装工时(小时)", "施工天数", "参与项目数"];
  const workerLines = ["【人员安装工时】", workerHeader.join(",")].concat(
    rows.map((r) => [r.name, r.hours, r.days, r.projects].join(",")));

  const dailyHeader = ["施工人员", "日期", "工时(小时)"];
  const dailyLines = ["\n【每日工时明细】", dailyHeader.join(",")].concat(
    rows.flatMap((r) => 
      Object.entries(r.daily).sort(([a], [b]) => a.localeCompare(b)).map(([date, hours]) => 
        [r.name, date, hours].join(",")
      )
    )
  );

  const recorded = projRows.filter((r) => r.hasActual);
  const totalEst = recorded.reduce((s, r) => s + r.est, 0);
  const totalAct = recorded.reduce((s, r) => s + r.act, 0);
  const projHeader = ["项目", "状态", "预计工时", "实际工时", "差异(实际-预计)", "施工人员工时"];
  const projLines = ["\n【项目工时差异】", projHeader.join(",")].concat(
    projRows.map((r) => {
      const workerText = r.workerHours.length
        ? r.workerHours.map((w) => `${w.name} ${w.hours}h`).join("、")
        : "";
      return [
        `"${String(r.name).replace(/"/g, '""')}"`,
        r.status,
        r.est,
        r.hasActual ? r.act : "",
        r.hasActual ? fmtSignedDiff(r.diff) : "未登记",
        `"${workerText.replace(/"/g, '""')}"`,
      ].join(",");
    })
  ).concat(["合计(已登记实际),,," + totalEst + "," + totalAct + "," + fmtSignedDiff(totalAct - totalEst) + ","]);

  const csv = "\ufeff" + workerLines.join("\n") + dailyLines.join("\n") + projLines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `工时统计_${month}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出 CSV");
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
const modal = {
  open(title, bodyHtml) {
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalBody").innerHTML = bodyHtml;
    document.getElementById("modal").classList.remove("hidden");
  },
  close() {
    document.getElementById("modal").classList.add("hidden");
    document.getElementById("modalBody").innerHTML = "";
  },
};

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
  setHidden("btnNewStore", !perm.manageStores());

  const bottomNavVisible = {
    projects: role != null,
    calendar: role != null,
    construction: role != null,
    workers: role != null,
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
  renderStats();
  renderStoreStats();
  renderStores();
  renderAccounts();
  renderRolePermissions();
}

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
const TL_LANE_HEIGHT = 75;      /* 每行任务高度 */

function renderTimelineInDetail() {
  const grid = document.getElementById("calGrid");
  const weekdaysEl = document.getElementById("calWeekdays");
  const detailBox = document.getElementById("calDayDetail");
  const label = document.getElementById("calLabel");

  document.body.classList.add("timeline-view");

  if (label) label.textContent = `${calSelectedDate} 时间线视图`;

  const items = projectsOnDate(calSelectedDate);
  const totalHours = TL_VIEW_END_HOUR - TL_VIEW_START_HOUR;
  const containerWidth = window.innerWidth - 60;
  const minHourWidth = window.innerWidth < 768 ? 40 : 50;
  const hourWidth = Math.max(minHourWidth, Math.floor(containerWidth / totalHours));
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
  
  const statConflict = items.filter((p) => {
    if (!hasInternalWorker(p)) return false;
    if (isCompleted(p)) return false;
    const start = projectStart(p);
    const end = projectEnd(p) || new Date((start || new Date()).getTime() + (p.estimatedHours || 2) * 3600000);
    if (!start) return false;
    return items.filter((other) => {
      if (other.id === p.id) return false;
      if (isCompleted(other)) return false;
      if (!hasInternalWorker(other)) return false;
      const os = projectStart(other);
      const oe = projectEnd(other) || os;
      if (!os) return false;
      return intervalsOverlap(start, end, os, oe);
    }).length >= 2;
  }).length;

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
      const width = Math.max(60, duration * hourWidth);
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
             style="left: ${left}px; width: ${width}px; top: ${top}px; height: ${TL_LANE_HEIGHT - 10}px;"
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
              ${!canDrag ? `<span class="timeline-task-lock-badge">🔒 不可拖动</span>` : ""}
            </div>
          </div>
          <div class="timeline-task-info">
            <span>⏰ ${timeStr}</span>
            <span>⏱️ ${p.estimatedHours}h</span>
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
          <span class="tl-stat-item"><span class="tl-stat-label">人员冲突</span><span class="tl-stat-value ${statConflict > 0 ? 'danger' : ''}">${statConflict}个</span></span>
        </div>
        <div class="tl-legend">
          <span class="tl-legend-item"><span class="tl-legend-box work"></span>工作时间 8:00-18:00</span>
          <span class="tl-legend-item"><span class="tl-legend-box overtime"></span>加班区（需协调）</span>
          <span class="tl-legend-item">💡 仅"预约中"状态可拖动调整时间</span>
          <span class="tl-legend-item">🔒 施工中/已完工等不可拖动</span>
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
      </div>`;
  }

  if (detailBox) detailBox.innerHTML = timelineHtml;

  setTimeout(() => {
    document.addEventListener("click", timelineCloseAllTasks);
  }, 0);
}

let draggedTask = null;
let timelineMouseDown = { x: 0, y: 0, time: 0 };

/* 记录鼠标按下位置，用于区分点击和拖拽 */
function timelineTaskMouseDown(e) {
  timelineMouseDown = { x: e.clientX, y: e.clientY, time: Date.now() };
}

/* 点击任务卡片：弹出浮动操作菜单 */
function timelineTaskClick(e, projectId) {
  if (!timelineMouseDown.x && !timelineMouseDown.y) {
    openTimelineActionMenu(e.currentTarget, projectId);
    return;
  }
  
  const deltaX = Math.abs(e.clientX - timelineMouseDown.x);
  const deltaY = Math.abs(e.clientY - timelineMouseDown.y);
  const timeDiff = Date.now() - timelineMouseDown.time;
  
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
  const assignOpts = availableWorkers.map((w) => {
    const conflicts = assignConflicts(p, w.id);
    return `<option value="${w.id}" ${conflicts.length ? 'data-conflict="1"' : ''}>${esc(w.name)}${conflicts.length ? ' ⚠冲突' : ''}</option>`;
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
        <div class="tl-menu-assign-form">
          <input type="text" class="input" id="tlMenuOutsourcedInput" placeholder="输入外协姓名" value="${esc(p.outsourcedWorkers || "")}" style="flex:1">
          <button class="btn small" onclick="timelineSaveOutsourced('${p.id}', document.getElementById('tlMenuOutsourcedInput').value)">保存</button>
        </div>
        ${p.outsourcedWorkers ? `<div class="tl-menu-outsourced-hint">已设置外协，不占用内部人员</div>` : ""}
      </div>
    </div>` : `<div class="tl-menu-info"><div><span>人员</span><b>${esc(workers)}</b></div></div>`}
    <div class="tl-menu-actions">
      <button class="btn small primary" onclick="closeTimelineActionMenu(); gotoConstruction('${p.id}')">施工管理</button>
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
    } else if (Math.abs(deltaY) > DRAG_THRESHOLD) {
      touchDragTask = null;
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
    return;
  }

  const timelineMain = document.getElementById("timelineMain");
  if (!timelineMain) { touchDragTask = null; return; }

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
        <button class="btn" onclick="modal.close(); document.getElementById('timelineMain').querySelector('.timeline-task[data-project-id=\"${task.dataset.projectId}\"]').style.left = '${originalLeft}px';">取消</button>
        <button class="btn primary" onclick="modal.close(); saveTimelineTaskTime('${task.dataset.projectId}', new Date('${timelineStart.toISOString()}'), new Date('${newEnd.toISOString()}'));">确认调整时间</button>
      </div>
    </div>`;

  modal.open("修改预约时间", modalContent);
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
        <button class="btn" onclick="modal.close(); document.getElementById('timelineMain').querySelector('.timeline-task-dragging').style.left = '${originalLeft}px';">取消</button>
        <button class="btn primary" onclick="modal.close(); saveTimelineTaskTime('${task.dataset.projectId}', new Date('${timelineStart.toISOString()}'), new Date('${newEnd.toISOString()}'));">确认调整时间</button>
      </div>
    </div>`;

  modal.open("修改预约时间", modalContent);
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
    } else if (Math.abs(deltaY) > DRAG_THRESHOLD) {
      mouseDragTask = null;
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
    return;
  }

  const timelineMain = document.getElementById("timelineMain");
  if (!timelineMain) { mouseDragTask = null; return; }

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
        <button class="btn" onclick="modal.close(); document.getElementById('timelineMain').querySelector('.timeline-task[data-project-id=\"${task.dataset.projectId}\"]').style.left = '${originalLeft}px';">取消</button>
        <button class="btn primary" onclick="modal.close(); saveTimelineTaskTime('${task.dataset.projectId}', new Date('${timelineStart.toISOString()}'), new Date('${newEnd.toISOString()}'));">确认调整时间</button>
      </div>
    </div>`;

  modal.open("修改预约时间", modalContent);
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

  const userInfo = document.getElementById("userInfo");
  userInfo.textContent = currentUser.email;
  userInfo.classList.remove("hidden");
  document.getElementById("btnLogout").classList.remove("hidden");
  document.getElementById("btnMigrate").classList.remove("hidden");
  document.getElementById("userMenu").classList.remove("hidden");
  setSyncStatus("online", "● 连接中…");

  // 载入当前用户的角色 / 门店
  const { data: prof } = await sb.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
  currentProfile = { role: (prof && prof.role) || null, storeId: (prof && prof.store_id) || null };

  document.getElementById("dropdownEmail").textContent = currentUser.email;
  document.getElementById("dropdownRole").textContent = ROLE_LABEL[currentProfile.role] || currentProfile.role || "未分配";

  document.getElementById("btnMigrateMenu").addEventListener("click", () => {
    document.getElementById("userDropdown").classList.add("hidden");
    migrateLocalToCloud();
  });
  document.getElementById("btnLogoutMenu").addEventListener("click", () => {
    document.getElementById("userDropdown").classList.add("hidden");
    doLogout();
  });

  document.getElementById("btnNotifyToggle").addEventListener("click", () => {
    document.getElementById("userDropdown").classList.add("hidden");
    requestNotificationPermission();
  });

  // 未分配角色：显示提示并停止后续加载
  if (!currentProfile.role) {
    showNoAccess(currentUser.email);
    return;
  }

  await repo.loadAll();
  renderRoleInfo();
  applyPermissions();
  document.getElementById("btnMigrate").classList.toggle("hidden", !isManager());
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
  let local;
  try {
    local = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch (e) { local = null; }
  if (!local || ((local.workers || []).length === 0 && (local.projects || []).length === 0)) {
    toast("本地没有可导入的数据");
    return;
  }
  if (!confirm("将把本机浏览器保存的历史数据上传到云端（不会删除本地数据）。确定继续？")) return;

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
  document.getElementById("btnMigrate").addEventListener("click", migrateLocalToCloud);

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
  
  requestNotificationPermission();
}

document.addEventListener("DOMContentLoaded", init);

/* ---------- PWA：注册 Service Worker（离线可用 / 可安装到主屏） ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service Worker 注册失败", err));
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
