import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { MIN_COLUMN_WIDTH, useResizableColumns } from '../src/backoffice/components/resizableColumns'

/**
 * 列宽调整：拖动表头分隔条改变 <col> 宽度、双击恢复默认、按 storageKey 持久化。
 */

// jsdom 没有 PointerEvent 时补一个基于 MouseEvent 的最小实现，让 clientX / pointerType 可用
const jsdomWindow = globalThis.window as unknown as Record<string, unknown>
if (typeof jsdomWindow.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent {
    pointerType: string
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerType = init.pointerType ?? 'mouse'
    }
  }
  jsdomWindow.PointerEvent = TestPointerEvent
  ;(globalThis as unknown as Record<string, unknown>).PointerEvent = TestPointerEvent
}

function DemoTable({ storageKey }: { storageKey: string }) {
  const table = useResizableColumns({ storageKey, defaultWidths: [100, 200] })
  return (
    <table>
      {table.colGroup}
      <thead>
        <tr>
          <th>A{table.resizeHandle(0)}</th>
          <th>B{table.resizeHandle(1)}</th>
        </tr>
      </thead>
    </table>
  )
}

function colWidths(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('col')).map((col) => (col as HTMLElement).style.width)
}

function drag(handle: HTMLElement, fromX: number, toX: number) {
  act(() => {
    fireEvent.pointerDown(handle, { clientX: fromX, button: 0, pointerType: 'mouse' })
    fireEvent.pointerMove(window, { clientX: toX, pointerType: 'mouse' })
    fireEvent.pointerUp(window, { clientX: toX, pointerType: 'mouse' })
  })
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('useResizableColumns', () => {
  test('renders the default column widths', () => {
    const { container } = render(<DemoTable storageKey="test-defaults" />)
    assert.deepEqual(colWidths(container), ['100px', '200px'])
    assert.equal(container.querySelectorAll('[role="separator"]').length, 2)
  })

  test('dragging the header handle resizes only the target column', () => {
    const { container } = render(<DemoTable storageKey="test-drag" />)
    const handles = container.querySelectorAll('[role="separator"]')
    drag(handles[0] as HTMLElement, 100, 140)
    assert.deepEqual(colWidths(container), ['140px', '200px'])
    drag(handles[1] as HTMLElement, 200, 120)
    assert.deepEqual(colWidths(container), ['140px', '120px'])
  })

  test('column width never drops below the minimum', () => {
    const { container } = render(<DemoTable storageKey="test-min" />)
    const handles = container.querySelectorAll('[role="separator"]')
    drag(handles[0] as HTMLElement, 100, -500)
    assert.deepEqual(colWidths(container), [`${MIN_COLUMN_WIDTH}px`, '200px'])
  })

  test('double-clicking the handle restores that column default', () => {
    const { container } = render(<DemoTable storageKey="test-reset" />)
    const handles = container.querySelectorAll('[role="separator"]')
    drag(handles[0] as HTMLElement, 100, 180)
    assert.deepEqual(colWidths(container), ['180px', '200px'])
    act(() => {
      fireEvent.doubleClick(handles[0] as HTMLElement)
    })
    assert.deepEqual(colWidths(container), ['100px', '200px'])
  })

  test('persists widths per storage key and restores them on remount', () => {
    const first = render(<DemoTable storageKey="test-persist" />)
    drag(first.container.querySelectorAll('[role="separator"]')[0] as HTMLElement, 100, 160)
    first.unmount()

    const second = render(<DemoTable storageKey="test-persist" />)
    assert.deepEqual(colWidths(second.container), ['160px', '200px'])

    const other = render(<DemoTable storageKey="test-other" />)
    assert.deepEqual(colWidths(other.container), ['100px', '200px'])
  })
})
