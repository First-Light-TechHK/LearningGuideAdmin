-- BackOffice 默认管理员（2026-10-23 用户决定）：库里还没有任何员工时，建一个受保护管理员，
-- 部署后即可登录，不依赖 BOOTSTRAP_ADMIN_* 环境变量。
-- 这里只存 scrypt 哈希（格式见 password.ts），原密码不在仓库里；登录后可在页面里修改密码。
INSERT INTO employees
  (login_email, role, account_status, email_verification, email_verified_at,
   password_hash, is_bootstrap_admin)
SELECT
  'admin@ilovelearningguide.com', 'ADMIN', 'ACTIVE', 'VERIFIED', now(),
  'scrypt$16384$8$1$hjutMGsBrzWdoTlWaHuNVA==$gZ7TR10yF28rAxK2cWpO7kLGpcij9baPw4BIT1kH5UpK8Rv7pWlGboKxDJKRR4JtdnZCawg3IkBYBV+wQIaqRQ==',
  true
WHERE NOT EXISTS (SELECT 1 FROM employees);
