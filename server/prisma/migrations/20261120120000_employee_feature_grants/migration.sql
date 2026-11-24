-- 账号级功能开关（owner 2026-11-20）：角色给基线，账号开关可加可减。
-- 缺省（没有行）= 继承角色矩阵；显式行覆盖基线的单点。
-- 生效 = 环境能力（ADMIN_CAPABILITIES）∩ 角色矩阵 ∩ 账号开关；
-- 账号开关永远不能越过环境能力。规则见 src/backoffice/modules/rbac/features.ts。

CREATE TABLE employee_feature_grants (
  id         BIGSERIAL PRIMARY KEY,
  employee_id UUID        NOT NULL REFERENCES employees (employee_id) ON DELETE CASCADE,
  feature    TEXT        NOT NULL,
  allowed    BOOLEAN     NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_by UUID        REFERENCES employees (employee_id) ON DELETE SET NULL,
  CONSTRAINT employee_feature_grants_employee_feature_key
    UNIQUE (employee_id, feature)
);

CREATE INDEX employee_feature_grants_feature_idx
  ON employee_feature_grants (feature);

COMMENT ON TABLE employee_feature_grants IS
  '账号级功能开关：缺省继承角色基线；allowed=false 收紧，true 在模块上抬到至少 VIEW';
COMMENT ON COLUMN employee_feature_grants.updated_by IS
  '最后修改该开关的 Admin（审计另见 audit_events.EMPLOYEE_FEATURES_CHANGED）';
