// @vitest-environment jsdom
/** Turn-status rewrite: the stock "Deep diving..." label becomes the actual
 *  task (思考中/读取中/写入中/执行中), keyed off the newest running tool row,
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
  it('rewrites "Deep diving..." to 思考中 while no tool is running', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('思考中')
  })

  it('shows 读取中 while a read/search tool is running', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeToolRow(scroll, 'read')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('读取中')
  })

  it('shows 写入中 while a write/edit tool is running', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeToolRow(scroll, 'edit')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('写入中')
  })

  it('shows 执行中 for bash rows and unknown tools', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeBashRow(scroll)
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('执行中')
  })

  it('falls back to 思考中 when the running tool settles', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    const row = makeToolRow(scroll, 'read')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('读取中')
    row.setAttribute('data-state', 'ok')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('思考中')
  })

  it('keeps the newest running tool when several run in parallel', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    makeToolRow(scroll, 'read')
    makeToolRow(scroll, 'write')
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('写入中')
  })

  it('survives a React-style text re-render (same constant string)', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('思考中')
    // React reconciles the same constant text child without touching it —
    // simulate a re-render that would only recreate the node if the diff
    // decided to; a direct nodeValue write must persist.
    status.firstChild!.nodeValue = 'Deep diving...'
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('思考中')
  })

  it('dispose() restores the original stock text', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { scroll, status } = makeConversation()
    const controller = makeController({ toggleSidebar: vi.fn() })
    controller.mount()
    makeBashRow(scroll)
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('执行中')
    controller.dispose()
    expect(status.firstChild?.nodeValue).toBe('Deep diving...')
  })

  it('animates the trailing dots 0 → 1 → 2 → 3 → 0 while the turn runs', async () => {
    stubMatchMedia(false)
    makeFrame()
    const { status } = makeConversation()
    makeController({ toggleSidebar: vi.fn() }).mount()
    await nextFrame()
    expect(status.firstChild?.nodeValue).toBe('思考中') // 0 dots
    await flushTimers(450) // first interval step
    expect(status.firstChild?.nodeValue).toBe('思考中.')
    await flushTimers(400)
    expect(status.firstChild?.nodeValue).toBe('思考中..')
    await flushTimers(400)
    expect(status.firstChild?.nodeValue).toBe('思考中...')
    await flushTimers(400)
    expect(status.firstChild?.nodeValue).toBe('思考中') // wraps to 0
  })
})
