import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ErrorCode } from "../contracts/envelope";
import {
  DISPLAY_STATUSES,
  EMPLOYEE_ROLES,
  effectiveFeatureMap,
  baselineFeatureMap,
  featureDraftFromFeatures,
  featureGrantsPayload,
  setFeatureMode,
  type AccountStatus,
  type EmployeeFeatures,
  type EmployeeListItem,
  type EmployeeListResult,
  type EmployeeRole,
  type FeatureMode,
} from "../contracts/employee";
import { EmployeeFeatureGrants } from "../components/EmployeeFeatureGrants";
import {
  CloseCircleIcon,
  DotsIcon,
  PlusIcon,
  SearchIcon,
} from "../components/icons";
import { Pagination } from '../components/Pagination';
import { usePageSize } from '../components/paginationState';
import type { Locale } from "../lib/i18n/config";
import { t } from "../lib/i18n/messages";
import { boFetch, boRequest } from "../lib/api";
import { notifySessionChanged } from "../lib/navigation";
import { useResizableColumns } from "../components/resizableColumns";

type Filters = { email: string; role: string; status: string };

type EditorState =
  | { mode: "create"; email: string; role: EmployeeRole | ""; accountStatus: AccountStatus }
  | {
      mode: "edit";
      employee: EmployeeListItem;
      email: string;
      role: EmployeeRole;
      accountStatus: AccountStatus;
    };

/**
 * 编辑抽屉里的「功能权限」数据：
 * 目录/显式开关/生效结果都来自服务端 GET /api/admin/employees/:id/features；
 * 草稿只保存三态，保存时替换式 PUT（继承 = 省略）。
 */
type FeatureEditorState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: EmployeeFeatures; draft: Record<string, FeatureMode> }
  | { kind: "error"; error: ErrorCode };

function isEmployeeFeatures(value: unknown): value is EmployeeFeatures {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<EmployeeFeatures>;
  return (
    Array.isArray(data.catalog) &&
    Array.isArray(data.grants) &&
    Array.isArray(data.effective)
  );
}

/** 行操作菜单改用 fixed 定位渲染到 body，避免被可滚动的表格容器裁切。 */
type OpenMenu = {
  employee: EmployeeListItem;
  top: number;
  left: number;
};

const EMPTY_FILTERS: Filters = { email: "", role: "", status: "" };
const ROW_MENU_WIDTH = 160;

function formatLastLogin(value: string | null, locale: Locale): string {
  if (!value) return "—";
  // PRD 只要求展示最近一次成功登录时间，未规定时区，这里按浏览器本地时区显示
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(value))
    .replace(",", "");
}

export function EmployeeAccountClient({ locale }: { locale: Locale }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize("employee-list");
  const [data, setData] = useState<EmployeeListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 邮件发出后仍保留一次性链接，Admin 可直接复制转交（无需进入员工邮箱）
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [featureEditor, setFeatureEditor] = useState<FeatureEditorState>({ kind: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const employeeTable = useResizableColumns({
    // Total 840 so Last Login and Actions stay whole inside the wall at 1280 wide.
    storageKey: "employee-list-v2",
    defaultWidths: [250, 140, 110, 190, 150],
  });

  /** 功能权限只在编辑既有账号时加载（新建还没有 employeeId）；失败走页面既有错误码机制。 */
  const loadEmployeeFeatures = useCallback((employeeId: string) => {
    setFeatureEditor({ kind: "loading" });
    setErrorCode(null);
    return boRequest<EmployeeFeatures>(`/api/admin/employees/${employeeId}/features`).then((result) => {
      if (result.success && isEmployeeFeatures(result.data)) {
        setFeatureEditor({
          kind: "ready",
          data: result.data,
          draft: featureDraftFromFeatures(result.data),
        });
        return;
      }
      const error = result.success ? "INTERNAL_ERROR" : result.error;
      setFeatureEditor({ kind: "error", error });
      setErrorCode(error);
    });
  }, []);

  function openCreateEditor() {
    setFeatureEditor({ kind: "idle" });
    setEditor({ mode: "create", email: "", role: "", accountStatus: "ACTIVE" });
  }

  function openEditEditor(employee: EmployeeListItem) {
    setEditor({
      mode: "edit",
      employee,
      email: employee.loginEmail,
      role: employee.role,
      accountStatus: employee.accountStatus,
    });
    void loadEmployeeFeatures(employee.employeeId);
  }

  function closeEditor() {
    setEditor(null);
    setFeatureEditor({ kind: "idle" });
  }

  const fetchLoad = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (appliedFilters.email.trim() !== "") params.set("email", appliedFilters.email.trim());
    if (appliedFilters.role !== "") params.set("role", appliedFilters.role);
    if (appliedFilters.status !== "") params.set("status", appliedFilters.status);

    return boFetch(`/api/admin/employees?${params.toString()}`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          success: boolean;
          data: EmployeeListResult | null;
          error: ErrorCode | null;
        };
        if (!payload.success || !payload.data) {
          setErrorCode(payload.error ?? "INTERNAL_ERROR");
          return;
        }

        // 筛选/删除后总数变少时，把越界的页码拉回最后一页，避免停在空白页
        const lastPage = Math.max(1, Math.ceil(payload.data.total / payload.data.pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setData(payload.data);
      })
      .catch(() => setErrorCode("INTERNAL_ERROR"))
      .finally(() => setLoading(false));
  }, [appliedFilters, page, pageSize]);

  const [loadSource, setLoadSource] = useState(() => ({ appliedFilters, page, pageSize }));
  if (
    loadSource.appliedFilters !== appliedFilters ||
    loadSource.page !== page ||
    loadSource.pageSize !== pageSize
  ) {
    setLoadSource({ appliedFilters, page, pageSize });
    setLoading(true);
    setErrorCode(null);
  }
  const load = useCallback(() => {
    setLoading(true);
    setErrorCode(null);
    return fetchLoad();
  }, [fetchLoad]);
  useEffect(() => {
    void fetchLoad();
  }, [fetchLoad]);

  // 表格/页面滚动或窗口变化时关闭行菜单，避免 fixed 菜单停在旧位置
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  // PORT-LST-002：邮箱支持部分匹配，输入停 300ms 后自动查询
  function onEmailChange(value: string) {
    setFilters((current) => ({ ...current, email: value }));
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setPage(1);
      setAppliedFilters((current) => ({ ...current, email: value }));
    }, 300);
  }

  function onSelectChange(key: "role" | "status", value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
    setAppliedFilters((current) => ({ ...current, [key]: value }));
  }

  function onPageSizeChange(value: number) {
    setPageSize(value);
    setPage(1);
  }

  function toggleRowMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    employee: EmployeeListItem
  ) {
    if (openMenu?.employee.employeeId === employee.employeeId) {
      setOpenMenu(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    // 编辑 + （已验证：重置密码 / 未验证：重发激活）
    const itemCount = 2;
    // .rowMenu: padding 4*2 + 32px/项 + 2px 间距
    const menuHeight = 8 + itemCount * 32 + (itemCount - 1) * 2;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      spaceBelow >= menuHeight + margin
        ? rect.bottom + margin
        : Math.max(margin, rect.top - menuHeight - margin);
    const left = Math.min(
      Math.max(margin, rect.right - ROW_MENU_WIDTH),
      window.innerWidth - ROW_MENU_WIDTH - margin
    );
    setOpenMenu({ employee, top, left });
  }

  async function submitEditor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    if (editor.role === "") {
      setErrorCode("INVALID_INPUT");
      return;
    }
    setSubmitting(true);
    setErrorCode(null);

    try {
      const isCreate = editor.mode === "create";
      const url = isCreate
        ? "/api/admin/employees"
        : `/api/admin/employees/${editor.employee.employeeId}`;
      const body = {
        email: editor.email,
        role: editor.role,
        accountStatus: editor.accountStatus,
        locale,
      };

      const response = await boFetch(url, {
        method: isCreate ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data: { delivery?: string; manualLink?: string | null } | null;
        error: ErrorCode | null;
      };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }

      // 功能权限随账号一起保存：账号 PATCH 成功后再替换式 PUT（服务端按目录只留显式开关）。
      // 失败时保留抽屉打开并复用既有错误提示；再次保存是幂等的。
      if (!isCreate && featureEditor.kind === "ready") {
        const featureResponse = await boRequest<EmployeeFeatures>(
          `/api/admin/employees/${editor.employee.employeeId}/features`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(featureGrantsPayload(featureEditor.draft, featureEditor.data.catalog)),
          }
        );
        if (!featureResponse.success) {
          setErrorCode(featureResponse.error);
          setFeatureEditor({ kind: "error", error: featureResponse.error });
          return;
        }
        if (isEmployeeFeatures(featureResponse.data)) {
          setFeatureEditor({
            kind: "ready",
            data: featureResponse.data,
            draft: featureDraftFromFeatures(featureResponse.data),
          });
        } else {
          await loadEmployeeFeatures(editor.employee.employeeId);
        }
        // 角色/开关可能改的是当前登录账号：让外壳重读会话，菜单与子导航立即跟随生效结果
        notifySessionChanged();
      }

      setManualLink(payload.data?.manualLink ?? null);
      setLinkCopied(false);

      const delivery = payload.data?.delivery;
      setNotice(
        isCreate
          ? t(locale, "employees.results.created", {
              result: t(locale, `delivery.${delivery ?? "UNKNOWN"}`),
            })
          : delivery
            ? t(locale, "employees.results.emailChanged", {
                result: t(locale, `delivery.${delivery}`),
              })
            : t(locale, "employees.results.updated")
      );
      closeEditor();
      await load();
    } catch {
      setErrorCode("INTERNAL_ERROR");
    } finally {
      setSubmitting(false);
    }
  }

  async function runAction(
    employee: EmployeeListItem,
    action: "reset-password" | "resend-activation"
  ) {
    setErrorCode(null);
    setNotice(null);
    setManualLink(null);
    setLinkCopied(false);
    setOpenMenu(null);
    try {
      const response = await boFetch(`/api/admin/employees/${employee.employeeId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data: { delivery: string; manualLink?: string | null } | null;
        error: ErrorCode | null;
      };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }
      setManualLink(payload.data?.manualLink ?? null);
      setLinkCopied(false);
      const delivery = payload.data?.delivery ?? "UNKNOWN";
      const result = t(locale, `delivery.${delivery}`);
      setNotice(
        action === "reset-password"
          ? t(locale, "employees.results.resetSent", { result })
          : t(locale, "employees.results.resent", { result })
      );
      await load();
    } catch {
      setErrorCode("INTERNAL_ERROR");
    }
  }

  async function copyManualLink() {
    if (!manualLink) return;
    try {
      await navigator.clipboard.writeText(manualLink);
      setLinkCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // 浏览器拒绝剪贴板权限时退化为选中链接文本，Admin 可自行 Ctrl/Cmd+C
      const node = document.querySelector('[data-testid="manual-link-value"]');
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setLinkCopied(false);
    }
  }

  return (
    <section className="card cardGrow">
      <div className="pageHead">
        <div>
          <h1 className="cardTitle">{t(locale, "employees.title")}</h1>
          <p className="cardSubtitle">{t(locale, "employees.subtitle")}</p>
        </div>
        <button
          type="button"
          className="button buttonCompact"
          onClick={openCreateEditor}
        >
          <PlusIcon size={15} />
          {t(locale, "employees.addEmployee")}
        </button>
      </div>

      <div className="filters">
        <label className="searchField">
          <SearchIcon size={15} />
          <input
            type="search"
            placeholder={t(locale, "employees.searchPlaceholder")}
            value={filters.email}
            onChange={(event) => onEmailChange(event.target.value)}
            aria-label={t(locale, "employees.searchPlaceholder")}
          />
        </label>
        <select
          className="filterSelect"
          value={filters.role}
          onChange={(event) => onSelectChange("role", event.target.value)}
          aria-label={t(locale, "employees.allRoles")}
        >
          <option value="">{t(locale, "employees.allRoles")}</option>
          {EMPLOYEE_ROLES.map((role) => (
            <option key={role} value={role}>
              {t(locale, `roles.${role}`)}
            </option>
          ))}
        </select>
        <select
          className="filterSelect"
          value={filters.status}
          onChange={(event) => onSelectChange("status", event.target.value)}
          aria-label={t(locale, "employees.allStatus")}
        >
          <option value="">{t(locale, "employees.allStatus")}</option>
          {DISPLAY_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(locale, `status.${status}`)}
            </option>
          ))}
        </select>
      </div>

      {errorCode ? <div className="alert alertError">{t(locale, `errors.${errorCode}`)}</div> : null}
      {notice || manualLink ? (
        <div className="alert alertOk employeeStatus" data-testid="employee-status">
          <div className="employeeStatusHead">
            <span>{notice ?? t(locale, "employees.results.linkReady")}</span>
            <button
              type="button"
              className="alertClose"
              aria-label={t(locale, "common.close")}
              title={t(locale, "common.close")}
              onClick={() => {
                setNotice(null);
                setManualLink(null);
                setLinkCopied(false);
              }}
            >
              <CloseCircleIcon size={14} />
            </button>
          </div>
          {manualLink ? (
            <div className="manualLinkRow" data-testid="manual-link">
              <span className="linkLabel">{t(locale, "employees.results.linkLabel")}</span>
              <span className="manualLinkValue" data-testid="manual-link-value">
                {manualLink}
              </span>
              <button
                type="button"
                className="button buttonGhost buttonSmall"
                onClick={() => void copyManualLink()}
              >
                {t(locale, linkCopied ? "common.copied" : "common.copy")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="tableWrap" onScroll={() => setOpenMenu(null)}>
        <table className="table" style={employeeTable.tableStyle}>
          {employeeTable.colGroup}
          <thead>
            <tr>
              <th>{t(locale, "employees.columns.email")}{employeeTable.resizeHandle(0)}</th>
              <th>{t(locale, "employees.columns.role")}{employeeTable.resizeHandle(1)}</th>
              <th>{t(locale, "employees.columns.status")}{employeeTable.resizeHandle(2)}</th>
              <th>{t(locale, "employees.columns.lastLogin")}{employeeTable.resizeHandle(3)}</th>
              <th>{t(locale, "employees.columns.actions")}{employeeTable.resizeHandle(4)}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5}>{t(locale, "common.loading")}</td>
              </tr>
            ) : null}

            {!loading && data && data.items.length === 0 ? (
              <tr>
                <td colSpan={5}>{t(locale, "employees.empty")}</td>
              </tr>
            ) : null}

            {!loading && data
              ? data.items.map((employee) => (
                  <tr key={employee.employeeId}>
                    <td>{employee.loginEmail}</td>
                    <td>{t(locale, `roles.${employee.role}`)}</td>
                    <td>
                      <span className="statusPill">
                        <span
                          className={
                            employee.displayStatus === "Active"
                              ? "dot dotActive"
                              : employee.displayStatus === "Pending"
                                ? "dot dotPending"
                                : "dot dotInactive"
                          }
                          aria-hidden="true"
                        />
                        {t(locale, `status.${employee.displayStatus}`)}
                      </span>
                    </td>
                    <td suppressHydrationWarning>{formatLastLogin(employee.lastLoginAt, locale)}</td>
                    <td>
                      <div className="rowMenuWrap">
                        <button
                          type="button"
                          className="iconButton"
                          aria-label={t(locale, "common.actions")}
                          aria-haspopup="menu"
                          aria-expanded={openMenu?.employee.employeeId === employee.employeeId}
                          onClick={(event) => toggleRowMenu(event, employee)}
                        >
                          <DotsIcon size={18} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              : null}
          </tbody>
        </table>
      </div>

      <Pagination
        locale={locale}
        page={data?.page ?? page}
        pageSize={data?.pageSize ?? pageSize}
        total={data ? data.total : null}
        onPageChange={setPage}
        onPageSizeChange={onPageSizeChange}
      />

      {openMenu
        ? createPortal(
            <>
              <div
                className="rowMenuBackdrop"
                onClick={() => setOpenMenu(null)}
                aria-hidden="true"
              />
              <div
                className="rowMenu rowMenuFixed"
                role="menu"
                style={{ top: openMenu.top, left: openMenu.left }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="rowMenuItem"
                  onClick={() => {
                    const employee = openMenu.employee;
                    setOpenMenu(null);
                    openEditEditor(employee);
                  }}
                >
                  {t(locale, "employees.actions.edit")}
                </button>
                {/* 未激活（Pending，或停用但从未激活）的账号只能重发激活：重置密码不能替代激活 */}
                {openMenu.employee.emailVerification === "VERIFIED" ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="rowMenuItem"
                    onClick={() => void runAction(openMenu.employee, "reset-password")}
                  >
                    {t(locale, "employees.actions.resetPassword")}
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="rowMenuItem"
                    onClick={() => void runAction(openMenu.employee, "resend-activation")}
                  >
                    {t(locale, "employees.actions.resendActivation")}
                  </button>
                )}
              </div>
            </>,
            document.body
          )
        : null}

      {editor ? (
        <div className="modalBackdrop">
          <form className="modal" onSubmit={submitEditor} noValidate>
            <div className="modalHead">
              <div>
                <h2 className="modalTitle">
                  {editor.mode === "create"
                    ? t(locale, "employees.newTitle")
                    : t(locale, "employees.editTitle")}
                </h2>
                <p className="modalSubtitle">
                  {editor.mode === "create"
                    ? t(locale, "employees.newSubtitle")
                    : t(locale, "employees.editSubtitle")}
                </p>
              </div>              <button
                type="button"
                className="modalClose"
                onClick={closeEditor}
                aria-label={t(locale, "common.close")}
                title={t(locale, "common.close")}
              >
                <CloseCircleIcon size={16} />
              </button>
            </div>

            {errorCode ? (
              <div className="alert alertError" style={{ margin: "0 28px" }}>
                {t(locale, `errors.${errorCode}`)}
              </div>
            ) : null}

            <div className="modalBody">
              <label className="field">
                <span className="fieldLabel">{t(locale, "employees.fields.email")}</span>
                <input
                  className="fieldInput"
                  type="email"
                  placeholder="name@company.com"
                  value={editor.email}
                  disabled={editor.mode === "edit" && editor.employee.emailVerification === "VERIFIED"}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, email: event.target.value } : current
                    )
                  }
                  required
                />
                <span className="fieldHint">
                  {editor.mode === "edit" && editor.employee.emailVerification === "VERIFIED"
                    ? t(locale, "employees.hintEmailVerified")
                    : t(locale, "employees.hintActivation")}
                </span>
              </label>

              <label className="field">
                <span className="fieldLabel">{t(locale, "employees.fields.role")}</span>
                <select
                  className="fieldSelect"
                  value={editor.role}
                  disabled={editor.mode === "edit" && editor.employee.isBootstrapAdmin}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, role: event.target.value as EmployeeRole } : current
                    )
                  }
                  required
                >
                  <option value="">{t(locale, "employees.rolePlaceholder")}</option>
                  {EMPLOYEE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {t(locale, `roles.${role}`)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="field">
                <span className="fieldLabel">{t(locale, "employees.fields.status")}</span>
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-label={t(locale, "employees.fields.status")}
                >
                  {(["ACTIVE", "INACTIVE"] as AccountStatus[]).map((option) => {
                    const selected = editor.accountStatus === option;
                    const locked = editor.mode === "edit" && editor.employee.isBootstrapAdmin;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={locked}
                        className={selected ? "segment segmentSelected" : "segment"}
                        onClick={() =>
                          setEditor((current) =>
                            current ? { ...current, accountStatus: option } : current
                          )
                        }
                      >
                        <span
                          className={
                            option === "ACTIVE"
                              ? "segmentDot segmentDotActive"
                              : "segmentDot segmentDotInactive"
                          }
                          aria-hidden="true"
                        />
                        {t(locale, `status.${option === "ACTIVE" ? "Active" : "Inactive"}`)}
                      </button>
                    );
                  })}
                </div>
                {editor.mode === "edit" && editor.employee.isBootstrapAdmin ? (
                  <span className="fieldHint">{t(locale, "employees.bootstrapLocked")}</span>
                ) : null}
              </div>

              {editor.mode === "edit" ? (
                <div className="field" data-testid="employee-feature-grants-section">
                  <span className="fieldLabel">{t(locale, "employees.features.title")}</span>
                  <span className="fieldHint">{t(locale, "employees.features.subtitle")}</span>
                  {featureEditor.kind === "loading" ? (
                    <p className="fieldHint" data-testid="employee-feature-grants-loading">
                      {t(locale, "employees.features.loading")}
                    </p>
                  ) : null}
                  {featureEditor.kind === "error" ? (
                    <p className="fieldHint" data-testid="employee-feature-grants-error">
                      {t(locale, "employees.features.loadFailed")}{" "}
                      <button
                        type="button"
                        className="button buttonGhost buttonSmall"
                        onClick={() => void loadEmployeeFeatures(editor.employee.employeeId)}
                      >
                        {t(locale, "common.retry")}
                      </button>
                    </p>
                  ) : null}
                  {featureEditor.kind === "ready" ? (
                    <EmployeeFeatureGrants
                      locale={locale}
                      catalog={featureEditor.data.catalog}
                      draft={featureEditor.draft}
                      effective={effectiveFeatureMap(featureEditor.data.effective)}
                      baseline={baselineFeatureMap(featureEditor.data.baseline)}
                      disabled={submitting}
                      onChange={(key, mode) =>
                        setFeatureEditor((current) =>
                          current.kind === "ready"
                            ? { ...current, draft: setFeatureMode(current.draft, key, mode) }
                            : current
                        )
                      }
                    />
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="modalFooter">
              <button type="button" className="button buttonGhost" onClick={closeEditor}>
                {t(locale, "common.cancel")}
              </button>
              <button
                type="submit"
                className="button"
                disabled={submitting || (editor.mode === "edit" && featureEditor.kind === "loading")}
              >
                {editor.mode === "create"
                  ? submitting
                    ? t(locale, "common.creating")
                    : t(locale, "employees.createAction")
                  : submitting
                    ? t(locale, "common.saving")
                    : t(locale, "employees.saveAction")}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
