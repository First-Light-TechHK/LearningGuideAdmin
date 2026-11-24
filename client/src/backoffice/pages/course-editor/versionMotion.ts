/**
 * 版本页的动效：只解释“已经发生”的变化，所有序列都从最终 DOM 反推，不让任何状态等动画。
 * Web Animations API，无依赖。减少动效或没有 Element.animate（jsdom）时，只做 150 ms 的淡入。
 */
const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)'
const EASE_PUBLISH = 'cubic-bezier(0.5, 0, 0.2, 1)'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
}

function canAnimate(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function' && !prefersReducedMotion()
}

/** 一次 150 ms 的淡入（reduced motion 的统一替身）。 */
export function fadeIn(...elements: Array<Element | null | undefined>): void {
  for (const el of elements) {
    if (!el) continue
    el.classList.remove('course-ui-fade')
    void (el as HTMLElement).offsetWidth
    el.classList.add('course-ui-fade')
    window.setTimeout(() => el.classList.remove('course-ui-fade'), 220)
  }
}

type Box = { x: number; y: number; w: number; h: number }
const boxIn = (el: Element, host: Element): Box => {
  const a = el.getBoundingClientRect()
  const b = host.getBoundingClientRect()
  return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }
}

function finish(animations: Animation[]): Promise<unknown> {
  return Promise.allSettled(animations.map((animation) => animation.finished))
}

/**
 * 发布：草稿板描成实线 → 版本名从草稿板滑进列表第一行 → 下面的行落位 → 灯亮、线上板文字滚入。约 680 ms。
 * 两栏布局才有滑动；堆叠布局只描边（200 ms）再淡入新行（150 ms）。
 */
export async function runPublishMotion(grid: HTMLElement, versionName: string): Promise<void> {
  const set = (state: 'running' | 'done') => {
    grid.dataset.publishMotion = state
  }
  const draft = grid.querySelector<HTMLElement>('.course-ui-plate.isDraft')
  const row = grid.querySelector<HTMLElement>('tr[data-testid^="version-row-"]')
  if (!row) {
    set('done')
    return
  }
  if (!canAnimate() || !draft) {
    fadeIn(row)
    set('done')
    return
  }
  set('running')
  const stacked = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length === 1
  const below: HTMLElement[] = []
  for (let next = row.nextElementSibling; next; next = next.nextElementSibling) below.push(next as HTMLElement)
  const rowHeight = row.getBoundingClientRect().height
  const overlay = document.createElement('div')
  overlay.className = 'course-ui-motion'
  overlay.setAttribute('aria-hidden', 'true')
  grid.appendChild(overlay)
  const animations: Animation[] = []
  const play = (el: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
    const animation = el.animate(frames, { fill: 'both', easing: EASE_PUBLISH, ...options })
    animations.push(animation)
    return animation
  }

  // 30–230：1 px 实线外框在草稿板上合拢
  const p = boxIn(draft, grid)
  const outline = document.createElement('div')
  outline.className = 'course-ui-motionOutline'
  Object.assign(outline.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` })
  overlay.appendChild(outline)
  play(outline, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { delay: 30, duration: 200 })
  play(outline, [{ opacity: 1 }, { opacity: 0 }], { delay: 230, duration: 200 })

  const lampParts = Array.from(row.querySelectorAll('.course-ui-node.isLamp, .course-ui-liveTag'))

  if (stacked) {
    play(row, [{ opacity: 0 }, { opacity: 1 }], { delay: 230, duration: 150, easing: 'linear' })
    await finish(animations)
  } else {
    // 新行先隐藏，下面的行上提一行高
    play(row, [{ opacity: 0 }, { opacity: 1 }], { delay: 430, duration: 50, easing: 'linear' })
    for (const el of below) play(el, [{ transform: `translateY(${-rowHeight}px)` }, { transform: 'translateY(0)' }], { delay: 480, duration: 200 })
    for (const el of lampParts) play(el, [{ opacity: 0 }, { opacity: 1 }], { delay: 480, duration: 200, easing: 'linear' })

    // 230–480：版本名从草稿板右缘滑到新行的 Version 单元格
    const cell = row.querySelector('td:nth-child(2)') ?? row
    const target = boxIn(cell, grid)
    const slip = document.createElement('div')
    slip.className = 'course-ui-motionSlip'
    slip.textContent = versionName
    overlay.appendChild(slip)
    const sx = p.x + p.w
    const sy = p.y + p.h / 2
    Object.assign(slip.style, { left: `${sx}px`, top: `${sy}px` })
    const dx = target.x - sx + 4
    const dy = target.y + target.h / 2 - sy
    play(
      slip,
      [
        { opacity: 0, transform: 'translate(0, -50%) scale(1)', offset: 0 },
        { opacity: 1, transform: 'translate(0, -50%) scale(1)', offset: 230 / 480 },
        { opacity: 1, transform: `translate(${dx}px, calc(${dy}px - 50%)) scale(0.92)`, offset: 430 / 480 },
        { opacity: 0, transform: `translate(${dx}px, calc(${dy}px - 50%)) scale(0.92)`, offset: 1 },
      ],
      { duration: 480, easing: 'linear' },
    )
    // 480–680：线上板与页头线上段的版本文字滚入，草稿板的新内容淡入
    const rolling = [grid.querySelector('[data-testid="versions-live-state"]'), document.querySelector('[data-testid="course-summary-live"]')]
    for (const el of rolling) if (el) play(el, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { delay: 480, duration: 200, easing: EASE })
    for (const el of Array.from(draft.children).slice(1)) play(el, [{ opacity: 0 }, { opacity: 1 }], { delay: 480, duration: 200, easing: 'linear' })
    await finish(animations)
  }
  for (const animation of animations) animation.cancel()
  overlay.remove()
  set('done')
}

/** “前往版本”：两道外框回声从页头的草稿 / 线上段飞到两块板（250 ms），然后淡出。 */
export function runEchoMotion(): void {
  if (!canAnimate()) return
  const pairs: Array<[string, string, boolean]> = [
    ['[data-testid="course-summary-draft"]', '[data-testid="versions-current-draft"]', true],
    ['[data-testid="course-summary-live"]', '[data-testid="versions-current-live"]', false],
  ]
  for (const [fromSel, toSel, dashed] of pairs) {
    const from = document.querySelector(fromSel)
    const to = document.querySelector(toSel)
    if (!from || !to) continue
    const a = from.getBoundingClientRect()
    const b = to.getBoundingClientRect()
    const echo = document.createElement('div')
    echo.className = 'course-ui-echo'
    echo.setAttribute('aria-hidden', 'true')
    echo.style.borderStyle = dashed ? 'dashed' : 'solid'
    Object.assign(echo.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` })
    document.body.appendChild(echo)
    const animation = echo.animate(
      [
        { transform: 'translate(0, 0)', width: `${a.width}px`, height: `${a.height}px`, opacity: 0.9 },
        { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px)`, width: `${b.width}px`, height: `${b.height}px`, opacity: 0 },
      ],
      { duration: 250, easing: EASE, fill: 'forwards' },
    )
    void animation.finished.then(() => echo.remove(), () => echo.remove())
  }
}
