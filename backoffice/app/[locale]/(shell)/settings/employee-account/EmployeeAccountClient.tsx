"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ErrorCode } from "@/contracts/envelope";
import {
  DISPLAY_STATUSES,
  EMPLOYEE_ROLES,
  type AccountStatus,
  type EmployeeRole,
} from "@/contracts/employee";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DotsIcon,
  PlusIcon,
  SearchIcon,
} from "@/components/icons";
import type { Locale } from "@/lib/i18n/config";
import { t } from "@/lib/i18n/messages";
import type {
  EmployeeListItem,
  EmployeeListResult,
} from "@/modules/employee-account/services/employeeAccount";

/** 设计稿默认一页 8 行。 */
const PAGE_SIZE = 8;

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
  const [data, setData] = useState<EmployeeListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorCode(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (appliedFilters.email.trim() !== "") params.set("email", appliedFilters.email.trim());
      if (appliedFilters.role !== "") params.set("role", appliedFilters.role);
      if (appliedFilters.status !== "") params.set("status", appliedFilters.status);

      const response = await fetch(`/api/admin/employees?${params.toString()}`);
      const payload = (await response.json()) as {
        success: boolean;
        data: EmployeeListResult | null;
        error: ErrorCode | null;
      };
      if (!payload.success || !payload.data) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }
      setData(payload.data);
    } catch {
      setErrorCode("INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, page]);

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

      const response = await fetch(url, {
        method: isCreate ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data: { delivery?: string } | null;
        error: ErrorCode | null;
      };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }

      setNotice(
        isCreate ? t(locale, "employees.results.created") : t(locale, "employees.results.updated")
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
    setOpenMenuId(null);
    try {
      const response = await fetch(`/api/admin/employees/${employee.employeeId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      const payload = (await response.json()) as {
        success: boolean;
        data: { delivery: string } | null;
        error: ErrorCode | null;
      };
      if (!payload.success) {
        setErrorCode(payload.error ?? "INTERNAL_ERROR");
        return;
      }
      const delivery = payload.data?.delivery ?? "UNKNOWN";
      setNotice(
        action === "reset-password"
          ? t(locale, "employees.results.resetSent", { result: delivery })
          : t(locale, "employees.results.resent")
      );
      await load();
    } catch {
      setErrorCode("INTERNAL_ERROR");
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
                          <DotsIcon size={15} />
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
        <span>{t(locale, "employees.showing", { from, to, total: data?.total ?? 0 })}</span>
        <span className="pager">
          <button
            type="button"
            className="pagerButton"
            disabled={page <= 1}
            aria-label={t(locale, "common.previous")}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeftIcon size={14} />
          </button>
          <button
            type="button"
            className="pagerButton pagerCurrent"
            aria-current="page"
            onClick={() => setPage((value) => Math.min(totalPages, value))}
          >
            {page}
          </button>
          <button
            type="button"
            className="pagerButton"
            disabled={page >= totalPages}
            aria-label={t(locale, "common.next")}
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
          >
            <ChevronRightIcon size={14} />
          </button>
        </span>
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
              </div>
              <button
                type="button"
                className="modalClose"
                onClick={() => setEditor(null)}
                aria-label={t(locale, "common.cancel")}
              >
                <CloseIcon size={16} />
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
