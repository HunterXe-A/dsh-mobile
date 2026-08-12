// @vitest-environment jsdom
/** MobileController: always-open sidebar + pager flip/settle, chrome, keyboard inset, teardown. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileController, PAGE_ATTR, type MobileControllerOptions } from '../src/client/controller.ts'

/** A MediaQueryList stub (jsdom has none) that records its change listener. */
function stubMatchMedia(matches: boolean): { fire: (next: boolean) => void } {
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
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return {
    fire: (next: boolean): void => {
      ;(mql as unknown as { matches: boolean }).matches = next
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent)
    },
  }
}

/**
 * Build the AppFrame-shaped frame: a scrollable grid whose first child is the
 * half-open sidebar page (offsetWidth 300 = the chat page's snap position).
 * scrollTo is stubbed onto the instance so tests can read the requested
 * position. The frame starts collapsed (rail).
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
  frame.append(center)
  frame.scrollTo = ((opts: ScrollToOptions): void => { frame.scrollLeft = opts.left ?? 0 }) as never
  root.append(frame)
  document.body.append(root)
  return frame
}

function toggleSidebarSpy() { return vi.fn() }

/** Track every mounted controller so afterEach can dispose it. */
const liveControllers: MobileController[] = []
function makeController(options: MobileControllerOptions): MobileController {
  const controller = new MobileController(options)
  liveControllers.push(controller)
  return controller
}

async function flushTimers(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(() => {
  for (const controller of liveControllers.splice(0)) controller.dispose()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MobileController mount/dispose', () => {
  it('tags <html> and upgrades the viewport meta', () => {
    stubMatchMedia(false)
    makeFrame()
    const controller = makeController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(document.documentElement.dataset.dshMobile).toBe('')
    const meta = document.querySelector('meta[name="viewport"]')
    expect(meta?.getAttribute('content')).toContain('viewport-fit=cover')
    expect(meta?.getAttribute('content')).toContain('maximum-scale=1')
    controller.dispose()
    expect(document.documentElement.hasAttribute('data-dsh-mobile')).toBe(false)
  })

  it('restores the pre-existing viewport meta content on dispose', () => {
    stubMatchMedia(false)
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = 'width=device-width, initial-scale=1'
    document.head.append(meta)
    const controller = makeController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(meta.content).toContain('maximum-scale=1')
    controller.dispose()
    expect(meta.content).toBe('width=device-width, initial-scale=1')
  })
})

describe('MobileController always-open sidebar + pager', () => {
  it('expands the collapsed sidebar on mount and lands the pager on the sidebar page', () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    // The real toggle flips the frame's collapsed attribute (AppFrame
    // re-renders from the layout store); the spy simulates that reaction.
    const toggle = vi.fn(() => { frame.removeAttribute('data-sidebar-collapsed') })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(controller.isSidebarOpen()).toBe(true)
    expect(frame.scrollLeft).toBe(0) // the sidebar page (half-open card)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('sidebar')
  })

  it('does not expand on wide viewports', () => {
    stubMatchMedia(false)
    makeFrame()
    const toggle = toggleSidebarSpy()
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    expect(toggle).not.toHaveBeenCalled()
    expect(controller.isSidebarOpen()).toBe(false)
  })

  it('flips to the chat page when the sidebar collapses, and back on expand', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = vi.fn(() => { frame.removeAttribute('data-sidebar-collapsed') })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    expect(frame.scrollLeft).toBe(0)
    // The user collapses the sidebar (rail): the pager flips to the chat page.
    frame.setAttribute('data-sidebar-collapsed', '')
    await new Promise(resolve => setTimeout(resolve, 0)) // mutation observer delivers
    expect(frame.scrollLeft).toBe(300)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
    // Expanding again returns to the sidebar page.
    toggle()
    frame.removeAttribute('data-sidebar-collapsed')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(frame.scrollLeft).toBe(0)
  })

  it('stays on the chat page on wide viewports even when the frame is expanded', async () => {
    stubMatchMedia(false)
    const frame = makeFrame()
    const controller = makeController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    frame.removeAttribute('data-sidebar-collapsed')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
  })

  it('picks up the frame when it mounts after the controller', async () => {
    stubMatchMedia(true)
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
    let frame: HTMLElement | null = null
    const toggle = vi.fn(() => { frame?.removeAttribute('data-sidebar-collapsed') })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    const frameEl = document.createElement('div')
    frame = frameEl
    frameEl.setAttribute('data-sidebar-collapsed', '')
    frameEl.setAttribute('data-details-collapsed', '')
    const sidebar = document.createElement('div')
    Object.defineProperty(sidebar, 'offsetWidth', { configurable: true, value: 300 })
    frameEl.append(sidebar)
    frameEl.scrollTo = ((opts: ScrollToOptions): void => { frameEl.scrollLeft = opts.left ?? 0 }) as never
    root.append(frameEl)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(toggle).toHaveBeenCalledTimes(1) // always-open expand
    expect(frameEl.scrollLeft).toBe(0) // lands on the sidebar page
  })
})

describe('MobileController pager settle (re-snap without state sync)', () => {
  /** Mount with a synchronous rAF so the mount-time re-sync cannot race the
   *  manual scrollLeft the tests set afterwards. */
  function mountSync(frame: HTMLElement, toggle: ReturnType<typeof toggleSidebarSpy>) {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    return controller
  }

  it('parks on the chat page after a past-midpoint swipe WITHOUT syncing state', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = vi.fn(() => { frame.removeAttribute('data-sidebar-collapsed') })
    mountSync(frame, toggle)
    expect(toggle).toHaveBeenCalledTimes(1) // the mount-time always-open expand
    // Let the mutation observer deliver the mount-time sync before the test
    // drives the scroll (it would otherwise reset scrollLeft to page 0).
    await new Promise(resolve => setTimeout(resolve, 0))
    // Swipe from the sidebar page (0) toward the chat, stopping past the
    // midpoint: the settle re-snaps to the chat page, but the state stays
    // expanded — the sidebar column keeps its full rendering (PiUI).
    frame.scrollLeft = 200 // chatLeft 300, midpoint 150
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(frame.scrollLeft).toBe(300)
    expect(toggle).toHaveBeenCalledTimes(1) // no state flip from the swipe
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('sidebar')
    expect(controllerIsOpen()).toBe(true)
    function controllerIsOpen(): boolean {
      return !frame.hasAttribute('data-sidebar-collapsed')
    }
  })

  it('nudges a stop just short of a page back to the whole page', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = toggleSidebarSpy()
    mountSync(frame, toggle)
    expect(toggle).toHaveBeenCalledTimes(1) // the mount-time always-open expand
    // Stops just short of the chat page: the settle nudges the scroll.
    frame.scrollLeft = 290 // chatLeft 300, nearest chat
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(toggle).toHaveBeenCalledTimes(1) // no new flip
    expect(frame.scrollLeft).toBe(300)
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
    const controller = makeController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 300 })
    resizeHandlers[0]?.()
    expect(document.documentElement.style.getPropertyValue('--dshm-keyboard-inset')).toBe('300px')
    controller.dispose()
  })
})
