// @vitest-environment jsdom
/** MobileController: DOM mirror, viewport meta, backdrop/FAB, keyboard inset, teardown. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKDROP_ATTR, DRAWER_ATTR, FAB_ATTR, MobileController,
} from '../src/client/controller.ts'

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

function makeFrame(): HTMLElement {
  const root = document.createElement('div')
  root.id = 'root'
  const frame = document.createElement('div')
  frame.setAttribute('data-sidebar-collapsed', '')
  frame.setAttribute('data-details-collapsed', '')
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
  it('tags <html>, upgrades the viewport meta, and appends backdrop + FAB', () => {
    stubMatchMedia(false)
    makeFrame()
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(document.documentElement.dataset.dshMobile).toBe('')
    const meta = document.querySelector('meta[name="viewport"]')
    expect(meta?.getAttribute('content')).toContain('viewport-fit=cover')
    expect(meta?.getAttribute('content')).toContain('maximum-scale=1')
    expect(document.querySelector(`[${BACKDROP_ATTR}]`)).not.toBeNull()
    const fab = document.querySelector(`[${FAB_ATTR}]`)
    expect(fab).not.toBeNull()
    expect(fab?.getAttribute('aria-expanded')).toBe('false')
    controller.dispose()
    expect(document.documentElement.hasAttribute('data-dsh-mobile')).toBe(false)
    expect(document.querySelector(`[${BACKDROP_ATTR}]`)).toBeNull()
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

describe('MobileController drawer mirror', () => {
  it('opens the drawer mirror when the frame expands on a narrow viewport', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(controller.isDrawerOpen()).toBe(false)
    // The frame's own collapse attribute is the single source of truth:
    // AppFrame flips it when the sidebar expands over the squeezed center.
    frame.removeAttribute('data-sidebar-collapsed')
    await flushObservers()
    expect(controller.isDrawerOpen()).toBe(true)
    expect(document.documentElement.getAttribute(DRAWER_ATTR)).toBe('open')
    frame.setAttribute('data-sidebar-collapsed', '')
    await flushObservers()
    expect(controller.isDrawerOpen()).toBe(false)
  })

  it('stays closed on wide viewports even when the frame is expanded', () => {
    stubMatchMedia(false)
    const frame = makeFrame()
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    frame.removeAttribute('data-sidebar-collapsed')
    expect(controller.isDrawerOpen()).toBe(false)
  })

  it('picks up the frame when it mounts after the controller', async () => {
    stubMatchMedia(true)
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
    const controller = new MobileController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(controller.isDrawerOpen()).toBe(false)
    const frame = document.createElement('div')
    frame.setAttribute('data-sidebar-collapsed', '')
    frame.setAttribute('data-details-collapsed', '')
    root.append(frame)
    await flushObservers() // the root observer attaches the frame observer
    frame.removeAttribute('data-sidebar-collapsed')
    await flushObservers()
    expect(controller.isDrawerOpen()).toBe(true)
  })

  it('closes on a session-row pick inside the open drawer, after the row handler', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    // The real toggle flips the frame's collapsed attribute (AppFrame
    // re-renders from the layout store); the spy simulates that reaction.
    const toggle = vi.fn(() => { frame.setAttribute('data-sidebar-collapsed', '') })
    const controller = new MobileController({ toggleSidebar: toggle })
    controller.mount()
    frame.removeAttribute('data-sidebar-collapsed')
    await flushObservers()
    expect(controller.isDrawerOpen()).toBe(true)
    const row = document.createElement('div')
    row.setAttribute('role', 'treeitem')
    document.body.append(row)
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // The close is deferred to a microtask so the native open runs first.
    expect(toggle).not.toHaveBeenCalled()
    await flushObservers()
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(controller.isDrawerOpen()).toBe(false)
  })

  it('ignores clicks on the plugin chrome itself', () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = toggleSidebarSpy()
    const controller = new MobileController({ toggleSidebar: toggle })
    controller.mount()
    frame.removeAttribute('data-sidebar-collapsed')
    const backdrop = document.querySelector<HTMLElement>(`[${BACKDROP_ATTR}]`)!
    backdrop.click()
    expect(toggle).toHaveBeenCalledTimes(1) // the backdrop's own handler, once
    const fab = document.querySelector<HTMLElement>(`[${FAB_ATTR}]`)!
    fab.click()
    expect(toggle).toHaveBeenCalledTimes(2) // no double-fire from the capture listener
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
