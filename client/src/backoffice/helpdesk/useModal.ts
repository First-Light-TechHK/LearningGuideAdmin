import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * 模态层（FAQ 抽屉、Preview、抽屉里的确认框）共用的键盘行为：
 * - Escape 在整个文档上都有效（焦点落在 body 上也行），输入法组字时（isComposing / keyCode 229）不算；
 * - Tab / Shift+Tab 只在当前层里循环，焦点在层外时拉回来；
 * - 多层同时打开时只有最上面一层响应。
 * 层后面的页面由调用方设 inert（HelpDeskPage）。
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'

const layers: object[] = []

/** 层里能用 Tab 走到的控件（按文档顺序）。 */
export function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.closest('[inert]') && !element.closest('[hidden]'),
  )
}

export function useModal(container: () => HTMLElement | null, onEscape: () => void) {
  const latest = useRef({ container, onEscape })
  useLayoutEffect(() => {
    latest.current = { container, onEscape }
  })

  useEffect(() => {
    const layer = {}
    layers.push(layer)
    function onKeyDown(event: KeyboardEvent) {
      if (layers[layers.length - 1] !== layer) return
      if (event.isComposing || event.keyCode === 229) return
      const root = latest.current.container()
      if (!root) return
      if (event.key === 'Escape') {
        event.preventDefault()
        latest.current.onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const items = tabbable(root)
      const active = document.activeElement
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (!(active instanceof Node) || !root.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      layers.splice(layers.indexOf(layer), 1)
    }
  }, [])
}
