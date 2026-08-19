// @vitest-environment jsdom
/** Turn-status rewrite: the stock "Deep diving..." label becomes the actual
 *  task (小鲸鱼在想事情呢/小鲸鱼在翻资料呢/小鲸鱼在写笔记呢/小鲸鱼在干活呢), keyed off the newest running tool row,
 *  and the rewrite survives React-style text re-renders. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileController, type MobileControllerOptions } from '../src/client/controller.ts'

/** A MediaQueryList stub (jsdom has none) plus an ASYNC rAF stub (jsdom has
 *  none). The async form matches the browser: requestAnimationFrame returns
 *  a handle and runs the callback later, so the controller's
 *  #taskStatusFrame guard behaves exactly as in production (a synchronous
 *  stub would assign the return value 0 over the cleared frame and starve
 *  every subsequent sync). cancelAnimationFrame maps to clearTimeout. */
function stubMatchMedia(matches: boolean): void {
  const mql = {
    matches,
    media: '(max-width: 768px)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn((query: string) => {
    if (query.includes('prefers-reduced-motion')) return { matches: false } as MediaQueryList
    return mql
  }))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
}

/** Build the AppFrame-shaped frame (see controller.spec.ts makeFrame). */
function makeFrame(): HTMLElement {
  const root = document.createElement('div')
  root.id = 'root'
  const frame = document.createElement('div')
  frame.setAttribute('data-sidebar-collapsed', '')
  frame.setAttribute('data-details-collapsed', '')
  const sidebar = document.createElement('div')
  Object.defineProperty(sidebar, 'offsetWidth', { configurable: true, value: 300 })
  frame.append(sidebar)
  const center = document.createElement('div')
  frame.append(center)
  frame.scrollTo = ((opts: ScrollToOptions): void => { frame.scrollLeft = opts.left ?? 0 }) as never
  root.append(frame)
  document.body.append(root)
  return frame
}

/** Build the conversation scroll body with the stock turn-status element. */
function makeConversation(): { scroll: HTMLElement, status: HTMLDivElement } {
  const scroll = document.createElement('div')
  scroll.setAttribute('data-conversation-scroll', '')
  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.append('Deep diving...')
  scroll.append(status)
  document.body.append(scroll)
  return { scroll, status }
}

/** A running tool row in the stock ToolRow chrome. */
function makeToolRow(scroll: HTMLElement, tool: string): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-tool', tool)
  row.setAttribute('data-state', 'running')
  scroll.append(row)
  return row
}

/** A running bash row (data-sample, no data-tool). */
function makeBashRow(scroll: HTMLElement): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-sample', 'bash')
  row.setAttribute('data-state', 'running')
  scroll.append(row)
  return row
}

/** A running /compact command card (GenericCommandCard chrome): the title
 *  span "compact" plus the stock running summary ("正在压缩…"). */
function makeCompactingCard(scroll: HTMLElement, summary = '正在压缩…'): HTMLElement {
  const card = document.createElement('div')
  card.setAttribute('data-variant', 'others')
  card.setAttribute('data-state', 'running')
  const title = document.createElement('span')
  title.textContent = 'compact'
  card.append(title)
  const summarySpan = document.createElement('span')
  summarySpan.textContent = summary
  card.append(summarySpan)
  scroll.append(card)
  return card
}

const liveControllers: MobileController[] = []
function makeController(options: MobileControllerOptions): MobileController {
  const controller = new MobileController(options)
  liveControllers.push(controller)
  return controller
}

afterEach(() => {
  for (const controller of liveControllers.splice(0)) controller.dispose()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Flush the async sync pipeline: MutationObserver delivers as a microtask,
 *  then the rAF-throttled rewrite runs in the NEXT macrotask — so a
 *  double-timer flush (or a single await that resolves after both) is
 *  needed. */
async function nextFrame(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Wait real time so setInterval-driven dot steps can fire. */
async function flushTimers(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('MobileController turn-status rewrite', () => {
  it('rewrites "Deep diving..." to 小鲸鱼在想事情呢 while no tool is running', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢')
  })

  it('shows 小鲸鱼在翻资料呢 while a read/search tool is running', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeToolRow(scroll, 'read')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在翻资料呢')
  })

  it('shows 小鲸鱼在写笔记呢 while a write/edit tool is running', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeToolRow(scroll, 'edit')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在写笔记呢')
  })

  it('shows 小鲸鱼在干活呢 for bash rows and unknown tools', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeBashRow(scroll)
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在干活呢')
  })

  it('falls back to 小鲸鱼在想事情呢 when the running tool settles', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    const row = makeToolRow(scroll, 'read')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在翻资料呢')
    row.setAttribute('data-state', 'ok')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢')
  })

  it('keeps the newest running tool when several run in parallel', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeToolRow(scroll, 'read')
    makeToolRow(scroll, 'write')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在写笔记呢')
  })

  it('survives a React-style text re-render (same constant string)', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢')
    // React reconciles the same constant text child without touching it —
    // simulate a re-render that would only recreate the node if the diff
    // decided to; a direct nodeValue write must persist.
    status.firstChild!.nodeValue = 'Deep diving...'
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢')
  })

  it('dispose() restores the original stock text', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    const controller = makeController({ toggleSidebar: vi.fn() })
    controller.mount()
    makeBashRow(scroll)
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在干活呢')
    controller.dispose()
    expect(status.firstChild?.nodeValue).toBe('Deep diving...')
  })

  it('animates the trailing dots 0 → 1 → 2 → 3 → 0 while the turn runs', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢') // 0 dots
    await flushTimers(450) // first interval step
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢.')
    await flushTimers(400)
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢..')
    await flushTimers(400)
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢...')
    await flushTimers(400)
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在想事情呢') // wraps to 0
  })

  it('shows 小鲸鱼在打包记忆呢 while a /compact card is running, beating running tools', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeBashRow(scroll)
    const card = makeCompactingCard(scroll)
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在打包记忆呢')
    card.setAttribute('data-state', 'ok')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在干活呢') // bash still running
  })

  it('shows 小鲸鱼在打包记忆呢 from the live compaction event flag (no DOM card needed)', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    const controller = makeController({ toggleSidebar: vi.fn() })
    controller.mount()
    makeBashRow(scroll)
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在干活呢')
    controller.setTaskCompacting(true) // compaction/start landed
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在打包记忆呢')
    controller.setTaskCompacting(false) // compaction/end landed
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('小鲸鱼在干活呢')
  })

  it('rewrites the /compact card summary 正在压缩… → 小鲸鱼在打包记忆呢, even with no turn-status element', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const card = makeCompactingCard(scroll)
    document.body.append(scroll)
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(card.lastElementChild?.textContent).toBe('小鲸鱼在打包记忆呢')
    expect(card.firstElementChild?.textContent).toBe('compact') // title untouched
  })

  it('animates the dots on the /compact card summary while no turn status exists', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const card = makeCompactingCard(scroll)
    document.body.append(scroll)
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(card.lastElementChild?.textContent).toBe('小鲸鱼在打包记忆呢') // 0 dots
    await flushTimers(450)
    expect(card.lastElementChild?.textContent).toBe('小鲸鱼在打包记忆呢.')
    await flushTimers(400)
    expect(card.lastElementChild?.textContent).toBe('小鲸鱼在打包记忆呢..')
  })

  it('rewrites the en stock summary "Compacting context…" too', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const card = makeCompactingCard(scroll, 'Compacting context…')
    document.body.append(scroll)
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(card.lastElementChild?.textContent).toBe('小鲸鱼在打包记忆呢')
  })

  it('leaves a running non-compact command card summary untouched', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const card = document.createElement('div')
    card.setAttribute('data-variant', 'others')
    card.setAttribute('data-state', 'running')
    const title = document.createElement('span')
    title.textContent = 'clear'
    card.append(title)
    const summary = document.createElement('span')
    summary.textContent = '正在处理…'
    card.append(summary)
    scroll.append(card)
    document.body.append(scroll)
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(card.lastElementChild?.textContent).toBe('正在处理…')
  })

  it('stops the card-summary dots once the /compact card settles (no status element)', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const card = makeCompactingCard(scroll)
    document.body.append(scroll)
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(card.lastElementChild?.textContent).toBe('小鲸鱼在打包记忆呢')
    card.setAttribute('data-state', 'ok') // compaction completes, React re-renders
    // The rewrite only targets running cards; after the state flip the
    // observer re-syncs and leaves the (now stock, settled) card alone.
    card.lastElementChild!.textContent = '已压缩 12 条历史记录' // React replaced the node
    await nextFrame()
    expect(card.lastElementChild?.textContent).toBe('已压缩 12 条历史记录')
  })

  it('shows a floating 小鲸鱼在打包记忆呢 pill during automatic compaction (no DOM card, no status)', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    document.body.append(scroll) // no status element, no /compact card — a pure automatic run
    const controller = makeController({ toggleSidebar: vi.fn() })
    controller.mount()
    await nextFrame()
    expect(document.querySelector('[data-dshm-indicator="compacting"]')).toBeNull()
    controller.setTaskCompacting(true) // compaction/start landed
    const pill = document.querySelector('[data-dshm-indicator="compacting"]')
    expect(pill).not.toBeNull()
    expect(pill?.textContent).toBe('小鲸鱼在打包记忆呢') // 0 dots
    expect(pill?.getAttribute('aria-live')).toBe('polite')
    expect(document.body.contains(pill)).toBe(true) // attached to the page, not the conversation
    controller.setTaskCompacting(false) // compaction/end landed
    expect(document.querySelector('[data-dshm-indicator="compacting"]')).toBeNull()
  })

  it('animates the pill dots while the automatic compaction runs', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    document.body.append(scroll)
    const controller = makeController({ toggleSidebar: vi.fn() })
    controller.mount()
    controller.setTaskCompacting(true)
    const pill = document.querySelector<HTMLElement>('[data-dshm-indicator="compacting"]')!
    expect(pill.textContent).toBe('小鲸鱼在打包记忆呢')
    await flushTimers(450)
    expect(pill.textContent).toBe('小鲸鱼在打包记忆呢.')
    await flushTimers(400)
    expect(pill.textContent).toBe('小鲸鱼在打包记忆呢..')
    await flushTimers(400)
    expect(pill.textContent).toBe('小鲸鱼在打包记忆呢...')
    await flushTimers(400)
    expect(pill.textContent).toBe('小鲸鱼在打包记忆呢') // wraps to 0
  })

  it('does not show the pill while a running /compact card supplies the DOM', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    makeCompactingCard(scroll)
    document.body.append(scroll)
    const controller = makeController({ toggleSidebar: vi.fn() })
    controller.mount()
    await nextFrame()
    expect(cardSummary(scroll)).toBe('小鲸鱼在打包记忆呢') // the card is the surface
    controller.setTaskCompacting(true) // probe fires for /compact runs too
    expect(document.querySelector('[data-dshm-indicator="compacting"]')).toBeNull()
  })

  it('removes the pill when a manual /compact card appears mid-compaction (flag stays on)', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    document.body.append(scroll)
    const controller = makeController({ toggleSidebar: vi.fn() })
    controller.mount()
    controller.setTaskCompacting(true)
    expect(document.querySelector('[data-dshm-indicator="compacting"]')).not.toBeNull()
    makeCompactingCard(scroll) // React renders the manual card mid-run
    await nextFrame()
    expect(document.querySelector('[data-dshm-indicator="compacting"]')).toBeNull()
    expect(cardSummary(scroll)).toBe('小鲸鱼在打包记忆呢')
  })

  it('dispose() removes the pill and restores the room', async () => {
    stubMatchMedia(false)
    makeFrame()
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    document.body.append(scroll)
    const controller = makeController({ toggleSidebar: vi.fn() })
    controller.mount()
    controller.setTaskCompacting(true)
    expect(document.querySelector('[data-dshm-indicator="compacting"]')).not.toBeNull()
    controller.dispose()
    expect(document.querySelector('[data-dshm-indicator="compacting"]')).toBeNull()
    expect(controller.setTaskCompacting(false)).toBeUndefined() // no crash after dispose
  })
})

/** The summary span text of the running compact card in the scroll body (the
 *  card's last child — the title span "compact" is its first child). */
function cardSummary(scroll: HTMLElement): string | null {
  const card = scroll.querySelector('[data-variant="others"][data-state="running"]')
  return card?.lastElementChild?.textContent ?? null
}
