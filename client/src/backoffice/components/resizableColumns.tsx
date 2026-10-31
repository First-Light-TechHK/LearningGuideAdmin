import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

/**
 * 后台表格列宽调整。
 *
 * 表格统一使用 table-layout: fixed，列宽由 <colgroup> 的像素宽度决定：
 * - 拖动表头右侧的分隔条调整该列宽度；
 * - 双击分隔条恢复该列默认宽度；
 * - 用户调整后的宽度按 storageKey 存在 localStorage，刷新后保留。
 */
export const MIN_COLUMN_WIDTH = 48

const STORAGE_PREFIX = 'lgbo_table_widths.'

const RESIZE_TITLE = '拖动调整列宽，双击恢复默认 / Drag to resize, double-click to reset'

function normalizeWidths(value: unknown, fallback: number[], minWidth: number): number[] {
  if (!Array.isArray(value) || value.length !== fallback.length) return fallback.slice()
  return fallback.map((defaultWidth, index) => {
    const width = value[index]
    return typeof width === 'number' && Number.isFinite(width) && width >= minWidth
      ? Math.round(width)
      : defaultWidth
  })
}

function readStoredWidths(storageKey: string, fallback: number[], minWidth: number): number[] {
  if (typeof window === 'undefined') return fallback.slice()
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey)
    if (!raw) return fallback.slice()
    return normalizeWidths(JSON.parse(raw) as unknown, fallback, minWidth)
  } catch {
    return fallback.slice()
  }
}

export type ResizableColumnsOptions = {
  /** localStorage 中的唯一键，不同表格互不影响 */
  storageKey: string
  /** 每列默认宽度（px），长度即列数 */
  defaultWidths: number[]
  minWidth?: number
}

export function useResizableColumns({
  storageKey,
  defaultWidths,
  minWidth = MIN_COLUMN_WIDTH,
}: ResizableColumnsOptions) {
  const [widths, setWidths] = useState<number[]>(() => readStoredWidths(storageKey, defaultWidths, minWidth))
  const widthsRef = useRef(widths)
  const defaultsRef = useRef(defaultWidths)
  const stopDragRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    widthsRef.current = widths
  }, [widths])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(widths))
    } catch {
      // 私有模式或配额已满时忽略，列宽仍在本会话内生效
    }
  }, [storageKey, widths])

  useEffect(() => () => stopDragRef.current?.(), [])

  const startResize = useCallback(
    (index: number, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return
      event.preventDefault()
      event.stopPropagation()
      stopDragRef.current?.()

      const startX = event.clientX
      const startWidth = widthsRef.current[index] ?? defaultsRef.current[index] ?? minWidth
      let nextWidths = widthsRef.current.slice()

      const onMove = (moveEvent: PointerEvent) => {
        const width = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX))
        if (width === nextWidths[index]) return
        nextWidths = nextWidths.slice()
        nextWidths[index] = width
        setWidths(nextWidths)
      }

      const stop = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        document.body.classList.remove('tableColResizing')
        stopDragRef.current = null
      }

      stopDragRef.current = stop
      document.body.classList.add('tableColResizing')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    },
    [minWidth],
  )

  const resetColumn = useCallback((index?: number) => {
    setWidths((current) =>
      index === undefined
        ? defaultsRef.current.slice()
        : current.map((width, i) => (i === index ? defaultsRef.current[i] ?? width : width)),
    )
  }, [])

  const colGroup = useMemo(
    () => (
      <colgroup>
        {widths.map((width, index) => (
          <col key={index} style={{ width }} />
        ))}
      </colgroup>
    ),
    [widths],
  )

  const totalWidth = widths.reduce((sum, width) => sum + width, 0)
  // 表格不窄于内容区；列宽总和超出时容器横向滚动，不会挤压其它列
  const tableStyle: CSSProperties = { width: `max(100%, ${totalWidth}px)` }

  const resizeHandle = (index: number) => (
    <span
      className="tableColResizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      title={RESIZE_TITLE}
      onPointerDown={(event) => startResize(index, event)}
      onDoubleClick={() => resetColumn(index)}
    />
  )

  return { widths, colGroup, tableStyle, resizeHandle, resetColumn }
}
