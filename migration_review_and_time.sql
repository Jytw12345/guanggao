-- ============================================================
-- 迁移脚本：添加审核功能和施工时间记录
-- 使用方法：登录 Supabase 控制台 → SQL Editor → 新建查询 →
--          粘贴本文件全部内容 → 点击 Run 执行
-- ============================================================

-- 1. 为 projects 表添加开始施工时间和完工时间字段
alter table public.projects add column if not exists started_at timestamptz;
alter table public.projects add column if not exists finished_at timestamptz;

-- 2. 更新默认角色权限，添加 review_project（审核项目）权限
--    店长默认开启审核权限，施工人员默认关闭
update public.role_permissions
set perms = jsonb_set(
  coalesce(perms, '{}'::jsonb),
  '{review_project}',
  'true'::jsonb
)
where role = 'store_manager';

update public.role_permissions
set perms = jsonb_set(
  coalesce(perms, '{}'::jsonb),
  '{review_project}',
  'false'::jsonb
)
where role = 'worker';

-- 如果 role_permissions 表中还没有对应角色，则插入
insert into public.role_permissions (role, perms)
values
  ('store_manager', '{"project_create":true,"project_edit":true,"project_delete":true,"assign_worker":false,"construction":false,"view_stats":false,"view_store_stats":false,"manage_stores":false,"manage_workers":false,"review_project":true}'::jsonb),
  ('worker',        '{"project_create":false,"project_edit":false,"project_delete":false,"assign_worker":true,"construction":true,"view_stats":false,"view_store_stats":false,"manage_stores":false,"manage_workers":false,"review_project":false}'::jsonb)
on conflict (role) do nothing;

-- 3. （可选）如果你想让已有的 "已完工" 项目也能自动回填完工时间
--    可以执行以下语句（以 updated_at 作为完工时间的近似值）：
-- update public.projects
-- set finished_at = updated_at
-- where status = '已完工' and finished_at is null;
