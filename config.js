// ============================================================
// Supabase 云端配置
// ------------------------------------------------------------
// 填写方法：
//   1. 打开 https://supabase.com 注册并新建一个 Project
//   2. 进入 Project → 左侧菜单 Settings → API
//   3. 复制 "Project URL" 填到 SUPABASE_URL
//      复制 "Project API keys" 里的 anon public 填到 SUPABASE_ANON_KEY
//   4. 到 SQL Editor 执行本项目的 supabase_schema.sql 建表
//   5. 到 Authentication → Users 新建用户（或在登录页点"注册"）
//
// 若下面两项留空，系统会自动运行在【本地单机模式】(数据存浏览器)，
// 便于你在配置云端前先体验。
// ============================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://ktejtqqcxzxkfplzhipy.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0ZWp0cXFjeHp4a2ZwbHpoaXB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4NDAzOTksImV4cCI6MjA5OTQxNjM5OX0.f66edfRZN4s1nfv_CUXygzm7LCNJtEhSDEtXhgmFdew",

  // ============================================================
  // 安全说明（重要）
  // ------------------------------------------------------------
  // 绝不要把 service_role 密钥放到前端代码里。任何能打开浏览器
  // 开发者工具的人都能提取它，从而绕过所有 RLS 行级安全策略、完全
  // 控制数据库（读取/篡改/删除所有账号与数据）。
  //
  // 需要管理员权限的敏感操作（如彻底删除 Auth 用户）应在【服务端】
  // 完成，例如使用 Supabase Edge Function / 自有后端，密钥只保存在
  // 服务端的环境变量中，前端用 anon key 调用该接口即可。
  //
  // 当前未配置 service key：删除账号时只会删除 profiles 表记录，
  // Auth 用户（登录凭据）需到 Supabase 控制台手动清理。
  // ============================================================
};
