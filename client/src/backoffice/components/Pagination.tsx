import { ChevronLeftIcon, ChevronRightIcon } from "./icons";
import { t } from "../lib/i18n/messages";
import { PAGE_SIZE_OPTIONS, pageItems } from './paginationState';
import type { PaginationProps } from './paginationState';



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