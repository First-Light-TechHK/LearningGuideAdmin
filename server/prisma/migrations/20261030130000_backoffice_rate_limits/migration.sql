-- BackOffice 限流计数（登录、找回密码、发信等）放到数据库，多实例共用一份
-- （PRD PORT-SEC-005）。固定窗口：resets_at 之前累计 count，过期后重开。
CREATE TABLE IF NOT EXISTS backoffice_rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count > 0),
  resets_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS backoffice_rate_limits_resets_at_idx ON backoffice_rate_limits (resets_at);
