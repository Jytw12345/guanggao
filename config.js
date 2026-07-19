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
  // 服务密钥（可选）
  // ------------------------------------------------------------
  // 用途：用于删除账号、管理 Auth 用户等需要管理员权限的操作
  // 获取方式：Project → Settings → API → Project API keys → service_role
  // 
  // 安全警告：
  //   - 此密钥拥有最高权限，可以绕过所有安全策略
  //   - 仅限部署到自己的服务器时使用，不要提交到 GitHub
  //   - 如果部署到 GitHub Pages 或其他公开托管服务，请留空此项
  //   - 留空时，删除账号功能将只删除 profiles 表，不会删除 Auth 用户
  // ============================================================
    SUPABASE_SERVICE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0ZWp0cXFjeHp4a2ZwbHpoaXB5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Mzg0MDM5OSwiZXhwIjoyMDk5NDE2Mzk5fQ.aVYDcihfye7StwjeHFsz4TIxhjr29i0NEcRWfc_bgY4",
  
  // 部署模式: 设置为 true 启用安全校验
  // 非 localhost 部署时，若 service key 非空，启动时将弹出警告
  ENFORCE_KEY_SECURITY: true,
};
