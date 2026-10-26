-- BackOffice Portal: employee identity, sessions, one-time tokens, audit, UI preferences.
-- Ported from backoffice/db/migrations/0001_backoffice_portal.sql (zhanfalong); gen_random_uuid() is built into PostgreSQL 13+.

-- ---------------------------------------------------------------- employees
CREATE TABLE IF NOT EXISTS employees (
  employee_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_email        TEXT        NOT NULL UNIQUE,
  role               TEXT        NOT NULL
                     CHECK (role IN ('ADMIN','COURSE_CREATOR','GRAPHIC_DESIGNER','FINANCE','OPERATION_ADMIN','OPERATION_AI')),
  account_status     TEXT        NOT NULL DEFAULT 'ACTIVE'
                     CHECK (account_status IN ('ACTIVE','INACTIVE')),
  email_verification TEXT        NOT NULL DEFAULT 'PENDING_VERIFICATION'
                     CHECK (email_verification IN ('PENDING_VERIFICATION','VERIFIED')),
  email_verified_at  TIMESTAMPTZ,
  password_hash      TEXT,
  last_login_at      TIMESTAMPTZ,
  -- 受保护管理员（PRD PORT-BOOT-003 / PORT-EDT-006）
  is_bootstrap_admin BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employees_email_lowercase CHECK (login_email = lower(login_email)),
  CONSTRAINT employees_verified_requires_hash
    CHECK (email_verification <> 'VERIFIED' OR password_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS employees_role_idx ON employees (role);
CREATE INDEX IF NOT EXISTS employees_status_idx ON employees (account_status, email_verification);

-- 受保护管理员不能被停用、降级或删除（服务层之外的数据库兜底）
CREATE OR REPLACE FUNCTION guard_bootstrap_admin()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_bootstrap_admin THEN
    RAISE EXCEPTION 'bootstrap admin cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.is_bootstrap_admin THEN
    IF NEW.account_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'bootstrap admin cannot be deactivated';
    END IF;
    IF NEW.role <> 'ADMIN' THEN
      RAISE EXCEPTION 'bootstrap admin cannot be demoted';
    END IF;
    IF NEW.is_bootstrap_admin = false THEN
      RAISE EXCEPTION 'bootstrap admin flag cannot be cleared';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employees_guard_bootstrap_admin ON employees;
CREATE TRIGGER employees_guard_bootstrap_admin
  BEFORE UPDATE OR DELETE ON employees
  FOR EACH ROW EXECUTE FUNCTION guard_bootstrap_admin();

-- -------------------------------------------------------- employee_sessions
CREATE TABLE IF NOT EXISTS employee_sessions (
  session_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID        NOT NULL REFERENCES employees (employee_id) ON DELETE CASCADE,
  -- 只存令牌 HMAC，原始令牌仅存在于浏览器 Cookie
  token_hash   TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  ip_address   TEXT,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS employee_sessions_employee_idx
  ON employee_sessions (employee_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------ verification_tokens
CREATE TABLE IF NOT EXISTS verification_tokens (
  token_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID        NOT NULL REFERENCES employees (employee_id) ON DELETE CASCADE,
  purpose     TEXT        NOT NULL CHECK (purpose IN ('ACTIVATION','PASSWORD_RESET')),
  token_hash  TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  -- 单次使用：消费后不可再次使用（INV-ONE-USE-TOKEN）
  consumed_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS verification_tokens_employee_idx
  ON verification_tokens (employee_id, purpose);

-- ------------------------------------------------------------ audit_events
CREATE TABLE IF NOT EXISTS audit_events (
  event_id           BIGSERIAL PRIMARY KEY,
  event_name         TEXT        NOT NULL,
  actor_employee_id  UUID        REFERENCES employees (employee_id) ON DELETE SET NULL,
  target_employee_id UUID        REFERENCES employees (employee_id) ON DELETE SET NULL,
  action             TEXT        NOT NULL,
  old_value          TEXT,
  new_value          TEXT,
  -- 禁止写入明文密码/会话令牌；仅记录结果与差异摘要
  result             TEXT        NOT NULL CHECK (result IN ('SUCCESS','FAILURE','DENIED')),
  ip_address         TEXT,
  request_id         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_no_obvious_secrets
    CHECK (
      COALESCE(old_value, '') !~* '(password|token|secret)\s*[:=]'
      AND COALESCE(new_value, '') !~* '(password|token|secret)\s*[:=]'
    )
);

CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target_employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_name_idx ON audit_events (event_name, created_at DESC);

-- -------------------------------------------------- employee_ui_preferences
CREATE TABLE IF NOT EXISTS employee_ui_preferences (
  employee_id   UUID PRIMARY KEY REFERENCES employees (employee_id) ON DELETE CASCADE,
  locale        TEXT        NOT NULL DEFAULT 'en-GB' CHECK (locale IN ('en-GB','zh-CN')),
  sidebar_state TEXT        NOT NULL DEFAULT 'expanded' CHECK (sidebar_state IN ('expanded','collapsed')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------- backoffice_settings
-- Server-generated secrets (e.g. the session HMAC key when SESSION_SECRET is not set).
CREATE TABLE IF NOT EXISTS backoffice_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
