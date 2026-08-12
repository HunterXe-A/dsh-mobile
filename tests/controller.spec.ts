// @vitest-environment jsdom
/** MobileController: pager page mirror, viewport meta, FAB, keyboard inset, teardown. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAB_ATTR, MobileController, PAGE_ATTR } from '../src/client/controller.ts'

/** A MediaQueryList stub that records its change listener for manual firing. */
function stubMatchMedia(matches: boolean): { mql: MediaQueryList; fire: (next: boolean) => void } {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches,
    media: '(max-width: 768px)',
    onchange: null,
    addEventListener: (_type: string, fn: () => void) => { listeners.add(fn) },
    removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn) },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList
  const fire = (next: boolean): void => {
    ;(mql as unknown as { matches: boolean }).matches = next
    for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent)
  }
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return { mql, fire }
}

/**
 * Build the AppFrame-shaped frame: a scrollable grid whose first child is the
 * sidebar page (offsetWidth 100 — the chat page's snap position). scrollTo is
 * stubbed onto the instance so tests can read the requested position.
 */
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
  center.dataset.chatFlow = ''
  frame.append(center)
  const details = document.createElement('div')
  frame.append(details)
  frame.scrollTo = ((opts: ScrollToOptions): void => { frame.scrollLeft = opts.left ?? 0 }) as never
  root.append(frame)
  document.body.append(root)
  return frame
}

function toggleSidebarSpy() { return vi.fn() }

/** Let jsdom deliver pending MutationObserver callbacks (macrotask checkpoint). */
async function flushObservers(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MobileController mount/dispose', () => {
  it('tags <html>, upgrades the viewport meta, and appends the FAB (no backdrop)', () => {
    stubMatchMedia(false)
    makeFrame()
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(document.documentElement.dataset.dshMobile).toBe('')
    const meta = document.querySelector('meta[name="viewport"]')
    expect(meta?.getAttribute('content')).toContain('viewport-fit=cover')
    expect(meta?.getAttribute('content')).toContain('maximum-scale=1')
    expect(document.querySelector(`[${FAB_ATTR}]`)).not.toBeNull()
    expect(document.querySelector('[data-dshm-backdrop]')).toBeNull()
    controller.dispose()
    expect(document.documentElement.hasAttribute('data-dsh-mobile')).toBe(false)
    expect(document.querySelector(`[${FAB_ATTR}]`)).toBeNull()
  })

  it('restores the pre-existing viewport meta content on dispose', () => {
    stubMatchMedia(false)
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = 'width=device-width, initial-scale=1'
    document.head.append(meta)
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(meta.content).toContain('maximum-scale=1')
    controller.dispose()
    expect(meta.content).toBe('width=device-width, initial-scale=1')
  })
})

describe('MobileController pager', () => {
  it('places the pager on the chat page at mount (collapsed sidebar = chat page)', () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(controller.isSidebarOpen()).toBe(false)
    expect(frame.scrollLeft).toBe(300) // the sidebar page width = chat snap point
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
  })

  it('flips to the sidebar page when the frame expands, and back when it collapses', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(frame.scrollLeft).toBe(300)
    // AppFrame drops data-sidebar-collapsed when the sidebar expands on a
    // narrow viewport (the user toggled it): the pager flips to page 0.
    frame.removeAttribute('data-sidebar-collapsed')
    await flushObservers()
    expect(controller.isSidebarOpen()).toBe(true)
    expect(frame.scrollLeft).toBe(0)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('sidebar')
    frame.setAttribute('data-sidebar-collapsed', '')
    await flushObservers()
    expect(controller.isSidebarOpen()).toBe(false)
    expect(frame.scrollLeft).toBe(300)
  })

  it('stays on the chat page on wide viewports even when the frame is expanded', async () => {
    stubMatchMedia(false)
    const frame = makeFrame()
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    frame.removeAttribute('data-sidebar-collapsed')
    await flushObservers()
    expect(controller.isSidebarOpen()).toBe(false)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
  })

  it('picks up the frame when it mounts after the controller and centers the chat page', async () => {
    stubMatchMedia(true)
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    const frame = document.createElement('div')
    frame.setAttribute('data-sidebar-collapsed', '')
    frame.setAttribute('data-details-collapsed', '')
    const sidebar = document.createElement('div')
    Object.defineProperty(sidebar, 'offsetWidth', { configurable: true, value: 300 })
    frame.append(sidebar)
    frame.scrollTo = ((opts: ScrollToOptions): void => { frame.scrollLeft = opts.left ?? 0 }) as never
    root.append(frame)
    await flushObservers()
    expect(frame.scrollLeft).toBe(300)
    expect(controller.isSidebarOpen()).toBe(false)
  })

  it('repositions the active page after a width reflow', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(frame.scrollLeft).toBe(300)
    // The sidebar page narrows (viewport change): the chat snap point moves.
    const sidebar = frame.firstElementChild as HTMLElement
    Object.defineProperty(sidebar, 'offsetWidth', { configurable: true, value: 250 })
    window.dispatchEvent(new Event('resize'))
    await new Promise(resolve => setTimeout(resolve, 200)) // debounce
    expect(frame.scrollLeft).toBe(250)
  })
})

describe('MobileController returnToChat', () => {
  it('toggles back to the chat page when the sidebar was opened through the menu', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = toggleSidebarSpy()
    const controller = new MobileController({ toggleSidebar: toggle })
    controller.mount()
    // On the chat page: no toggle.
    controller.returnToChat()
    expect(toggle).not.toHaveBeenCalled()
    // Sidebar opened through the menu (frame expanded): toggle back.
    frame.removeAttribute('data-sidebar-collapsed')
    await flushObservers()
    expect(controller.isSidebarOpen()).toBe(true)
    controller.returnToChat()
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('scrolls back directly when the user swiped to the sidebar page (state unchanged)', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = toggleSidebarSpy()
    const controller = new MobileController({ toggleSidebar: toggle })
    controller.mount()
    // Manual swipe: scrollLeft moves to the sidebar page, the frame stays
    // collapsed (the state mirror still says chat).
    frame.scrollLeft = 0
    expect(controller.isSidebarOpen()).toBe(true)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
    controller.returnToChat()
    expect(toggle).not.toHaveBeenCalled()
    expect(frame.scrollLeft).toBe(300) // scrolled straight back to the chat page
  })
})

describe('MobileController keyboard inset', () => {
  it('writes the visual-viewport deficit as --dshm-keyboard-inset', () => {
    stubMatchMedia(false)
    makeFrame()
    const resizeHandlers: Array<() => void> = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 320,
        offsetTop: 0,
        width: 375,
        addEventListener: (_t: string, fn: () => void) => { resizeHandlers.push(fn) },
        removeEventListener: vi.fn(),
      },
    })
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    // Keyboard opens: the visual viewport shrinks below the layout viewport.
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 300 })
    resizeHandlers[0]?.()
    expect(document.documentElement.style.getPropertyValue('--dshm-keyboard-inset')).toBe('300px')
    controller.dispose()
  })
})
