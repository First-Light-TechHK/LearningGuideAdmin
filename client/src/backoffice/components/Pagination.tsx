import { useCallback, useEffect, useState } from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "./icons";
import type { Locale } from "../lib/i18n/config";
import { t } from "../lib/i18n/messages";

/**
 * 后台列表统一分页。
 *
 * 所有列表（员工账号、课程…）都走同一套规则：
 * - 服务端分页：接口接收 page / pageSize，返回 total（课程返回 pages）；
 * - 每页条数固定为 10 / 20 / 50 / 100，选择结果按 storageKey 记住；
 * - 页码最多显示 7 个，超出用省略号收口。
 * 新增列表页时复用 `usePageSize` + `<Pagination>`，不要各写一套。
 */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export const DEFAULT_PAGE_SIZE: number = PAGE_SIZE_OPTIONS[0];

const PAGE_SIZE_STORAGE_PREFIX = "lgbo_page_size.";

function normalisePageSize(value: unknown): number {
  const size = Number(value);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(size)
    ? size
    : DEFAULT_PAGE_SIZE;
}

function readStoredPageSize(storageKey: string): number {
  if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
  try {
    // 旧版本存过 8 这类已下线的选项，读取时会回落到默认值
    return normalisePageSize(
      window.localStorage.getItem(PAGE_SIZE_STORAGE_PREFIX + storageKey)
    );
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

/** 页码按钮最多 7 个，超出时用省略号收口（与常见后台分页一致）。 */
export function pageItems(current: number, total: number): Array<number | "gap"> {
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

/** 每页条数状态：localStorage 持久化，越界或已下线的历史值自动回落。 */
export function usePageSize(storageKey: string): [number, (size: number) => void] {
  const [pageSize, setPageSize] = useState<number>(() => readStoredPageSize(storageKey));

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PAGE_SIZE_STORAGE_PREFIX + storageKey,
        String(pageSize)
      );
    } catch {
      // 隐私模式下 localStorage 可能不可写，忽略即可
    }
  }, [storageKey, pageSize]);

  const changePageSize = useCallback((size: number) => {
    setPageSize(normalisePageSize(size));
  }, []);

  return [pageSize, changePageSize];
}

export type PaginationProps = {
  locale: Locale;
  page: number;
  pageSize: number;
  /** null 表示首次加载中，摘要显示"加载中" */
  total: number | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
};

export function Pagination({
  locale,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const totalPages = !total || total <= 0 ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const from = total && total > 0 ? (page - 1) * pageSize + 1 : 0;
  const to = total ? Math.min(page * pageSize, total) : 0;

  const summary =
    total === null
      ? t(locale, "common.loading")
      : total === 0
        ? t(locale, "pagination.showingEmpty")
        : from === to
          ? t(locale, "pagination.showingSingle", { from, total })
          : t(locale, "pagination.showing", { from, to, total });

  return (
    <div className="pagination">
      <span className="paginationSummary">{summary}</span>
      <div className="paginationControls">
        <label className="pageSizeLabel">
          {t(locale, "pagination.pageSizeLabel")}
          <select
            className="pageSizeSelect"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label={t(locale, "pagination.pageSizeLabel")}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <span className="pageOf">
          {t(locale, "pagination.pageOf", { page, total: totalPages })}
        </span>

        <span className="pager">
          <button
            type="button"
            className="pagerButton"
            disabled={page <= 1}
            aria-label={t(locale, "common.previous")}
            title={t(locale, "common.previous")}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            <ChevronLeftIcon size={14} />
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
                className={item === page ? "pagerButton pagerCurrent" : "pagerButton"}
                aria-current={item === page ? "page" : undefined}
                aria-label={t(locale, "pagination.pageNumber", { page: item })}
                onClick={() => onPageChange(item)}
              >
                {item}
              </button>
            )
          )}
          <button
            type="button"
            className="pagerButton"
            disabled={page >= totalPages}
            aria-label={t(locale, "common.next")}
            title={t(locale, "common.next")}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          >
            <ChevronRightIcon size={14} />
          </button>
        </span>
      </div>
    </div>
  );
}
