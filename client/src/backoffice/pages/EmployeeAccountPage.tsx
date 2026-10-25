import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ErrorCode } from "../contracts/envelope";
import {
  DISPLAY_STATUSES,
  EMPLOYEE_ROLES,
  type AccountStatus,
  type EmployeeListItem,
  type EmployeeListResult,
  type EmployeeRole,
} from "../contracts/employee";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DotsIcon,
  PlusIcon,
  SearchIcon,
} from "../components/icons";
import type { Locale } from "../lib/i18n/config";
import { t } from "../lib/i18n/messages";
import { boFetch } from "../lib/api";

/** 设计稿默认一页 8 行；服务端上限 100（EMPLOYEE_PAGE_SIZE_MAX）。 */
const DEFAULT_PAGE_SIZE = 8;
const PAGE_SIZE_OPTIONS = [8, 10, 20, 50, 100] as const;
const PAGE_SIZE_STORAGE_KEY = "lgbo_employee_page_size";

function initialPageSize(): number {
  if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
  try {
    const saved = Number(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(saved)
      ? saved
      : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

/** 页码按钮最多 7 个，超出时用省略号收口（与常见后台分页一致）。 */
function pageItems(current: number, total: number): Array<number | "gap"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, "gap", total];
  }
  if (current >= total - 3) {
    return [1, "gap", total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, "gap", current - 1, current, current + 1, "gap", total];
}

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

const EMPTY_FILTERS: Filters = { email: "", role: "", status: "" };

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
  const [pageSize, setPageSize] = useState<number>(initialPageSize);
  const [data, setData] = useState<EmployeeListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 邮件发出后仍保留一次性链接，Admin 可直接复制转交（无需进入员工邮箱）
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorCode(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (appliedFilters.email.trim() !== "") params.set("email", appliedFilters.email.trim());
      if (appliedFilters.role !== "") params.set("role", appliedFilters.role);
      if (appliedFilters.status !== "") params.set("status", appliedFilters.status);

      const response = await boFetch(`/api/admin/employees?${params.toString()}`);
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
    } catch {
      setErrorCode("INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

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
    try {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(value));
    } catch {
      // 隐私模式下 localStorage 可能不可写，忽略即可
    }
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
      setEditor(null);
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
    setOpenMenuId(null);
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

  const from = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const totalPages = useMemo(() => {
    if (!data || data.total === 0) return 1;
    return Math.max(1, Math.ceil(data.total / data.pageSize));
  }, [data]);

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
          onClick={() =>
            setEditor({
              mode: "create",
              email: "",
              role: "",
              accountStatus: "ACTIVE",
            })
          }
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
      {notice ? <div className="alert alertOk">{notice}</div> : null}
      {manualLink ? (
        <div className="alert alertInfo manualLinkAlert" data-testid="manual-link">
          <div className="manualLinkBody">
            <span>{t(locale, "employees.results.manualLink")}</span>
            <span className="manualLinkValue" data-testid="manual-link-value">
              {manualLink}
            </span>
          </div>
          <button
            type="button"
            className="button buttonGhost buttonSmall"
            onClick={() => void copyManualLink()}
          >
            {t(locale, linkCopied ? "common.copied" : "common.copy")}
          </button>
        </div>
      ) : null}

      <div className="tableWrap">
        <table className="table">
          <colgroup>
            {/* 设计稿列宽：300 / 180 / 140 / 240 / 158（内容宽 1018） */}
            <col style={{ width: "29.5%" }} />
            <col style={{ width: "17.7%" }} />
            <col style={{ width: "13.8%" }} />
            <col style={{ width: "23.6%" }} />
            <col style={{ width: "15.4%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t(locale, "employees.columns.email")}</th>
              <th>{t(locale, "employees.columns.role")}</th>
              <th>{t(locale, "employees.columns.status")}</th>
              <th>{t(locale, "employees.columns.lastLogin")}</th>
              <th>{t(locale, "employees.columns.actions")}</th>
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
                          aria-expanded={openMenuId === employee.employeeId}
                          onClick={() =>
                            setOpenMenuId((current) =>
                              current === employee.employeeId ? null : employee.employeeId
                            )
                          }
                        >
                          <DotsIcon size={18} />
                        </button>

                        {openMenuId === employee.employeeId ? (
                          <div className="rowMenu">
                            <button
                              type="button"
                              className="rowMenuItem"
                              onClick={() => {
                                setOpenMenuId(null);
                                setEditor({
                                  mode: "edit",
                                  employee,
                                  email: employee.loginEmail,
                                  role: employee.role,
                                  accountStatus: employee.accountStatus,
                                });
                              }}
                            >
                              {t(locale, "employees.actions.edit")}
                            </button>
                            <button
                              type="button"
                              className="rowMenuItem"
                              onClick={() => void runAction(employee, "reset-password")}
                            >
                              {t(locale, "employees.actions.resetPassword")}
                            </button>
                            {employee.displayStatus === "Pending" ? (
                              <button
                                type="button"
                                className="rowMenuItem"
                                onClick={() => void runAction(employee, "resend-activation")}
                              >
                                {t(locale, "employees.actions.resendActivation")}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              : null}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span className="paginationSummary">
          {!data
            ? t(locale, "common.loading")
            : data.total === 0
              ? t(locale, "employees.showingEmpty")
              : from === to
                ? t(locale, "employees.showingSingle", { from, total: data.total })
                : t(locale, "employees.showing", { from, to, total: data.total })}
        </span>
        <div className="paginationControls">
          <label className="pageSizeLabel">
            {t(locale, "employees.pageSizeLabel")}
            <select
              className="pageSizeSelect"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              aria-label={t(locale, "employees.pageSizeLabel")}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>

          <span className="pageOf">
            {t(locale, "employees.pageOf", { page, total: totalPages })}
          </span>

          <span className="pager">
            <button
              type="button"
              className="pagerButton pagerNav"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeftIcon size={14} />
              {t(locale, "common.previous")}
            </button>
            {pageItems(page, totalPages).map((item, index) =>
              item === "gap" ? (
                <span key={`gap-${index}`} className="pagerGap" aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={
                    item === page ? "pagerButton pagerCurrent" : "pagerButton"
                  }
                  aria-current={item === page ? "page" : undefined}
                  aria-label={t(locale, "employees.pageNumber", { page: item })}
                  onClick={() => setPage(item)}
                >
                  {item}
                </button>
              )
            )}
            <button
              type="button"
              className="pagerButton pagerNav"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >
              {t(locale, "common.next")}
              <ChevronRightIcon size={14} />
            </button>
          </span>
        </div>
      </div>

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
                onClick={() => setEditor(null)}
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
            </div>

            <div className="modalFooter">
              <button type="button" className="button buttonGhost" onClick={() => setEditor(null)}>
                {t(locale, "common.cancel")}
              </button>
              <button type="submit" className="button" disabled={submitting}>
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
