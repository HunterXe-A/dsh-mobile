/**
 * DOM-side mobile controller: the non-React half of the plugin. Owns the
 * pieces the frame itself cannot express — the viewport meta upgrade and
 * the safe-area/keyboard CSS variables. Everything it installs is removed by
 * dispose(), and every rule it depends on is scoped under the
 * [data-dsh-mobile] attribute it sets on <html>.
 *
 * Mobile layout follows PiUI's chat pager: the STOCK AppFrame becomes a
 * horizontal scroll-snap pager whose columns are two pages — a half-open
 * sidebar page and a full-width chat page that stays visible beside it.
 * The controller's only frame interaction is to expand the auto-collapsed
 * sidebar ONCE below the breakpoint (AppFrame collapses it to the rail on
 * narrow viewports) and leave it there: the sidebar column then keeps its
 * full content rendered at all times, so swiping to it never triggers a
 * late render — the pager is a pure visual scroll. Manual swipes are never
 * state-synced; the settle handler only re-snaps a short-of-page stop.
 */

/** The narrow breakpoint the pager keys off (PiUI's 768px). */
export const MOBILE_BREAKPOINT = '(max-width: 768px)'

/** The <html> attribute that mirrors the pager page the state demands. */
export const PAGE_ATTR = 'data-dshm-page'

/** Pager page names (the mirror values of PAGE_ATTR). */
export type MobilePage = 'sidebar' | 'chat'

/** Wait after the last scroll event before the pager settles. */
const SCROLL_SETTLE_MS = 200

/**
 * Viewport meta content: maximum-scale blocks the iOS focus zoom that would
 * otherwise fight the fixed-height mobile layout; viewport-fit=cover exposes
 * the safe-area insets to env().
 */
const VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'

/**
 * The AppFrame keeps at least one of its two data attributes in every state
 * (a closed sidebar renders the rail, a closed details column renders zero
 * width), so the union always selects the frame and never a descendant.
 */
const FRAME_SELECTOR = '#root > div[data-sidebar-collapsed], #root > div[data-details-collapsed]'

/** The AppFrame element, or null before the layout entry mounts it. */
function findFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FRAME_SELECTOR)
}

/**
 * The pager's chat-page snap position: the rendered width of the sidebar
 * page column (the half-open card). Falls back to the frame's own width
 * while the layout has not settled (offsetWidth is 0 before first layout).
 */
function chatPageLeft(frame: HTMLElement): number {
  const sidebar = frame.firstElementChild
  if (sidebar instanceof HTMLElement && sidebar.offsetWidth > 0) return sidebar.offsetWidth
  return frame.clientWidth
}

/** Callbacks the controller needs from the apply world. */
export interface MobileControllerOptions {
  /** Toggle the sidebar panel (frame-owned layout action). */
  toggleSidebar: () => void
}

/** Test-facing surface of the controller (the class keeps everything else private). */
export interface MobileControllerHandle {
  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean
  /** Install the controller; idempotent. */
  mount(): void
  /** Remove every DOM effect; idempotent. */
  dispose(): void
}

/** The DOM-side controller (see module doc). */
export class MobileController implements MobileControllerHandle {
  readonly #options: MobileControllerOptions
  #html: HTMLElement | null = null
  #mql: MediaQueryList | null = null
  #frameObserver: MutationObserver | null = null
  #rootObserver: MutationObserver | null = null
  #viewportMeta: HTMLMetaElement | null = null
  #viewportOriginal: string | null = null
  #keyboardFrame: number | null = null
  #mountFrame: number | null = null
  #resizeTimer: number | null = null
  #settleTimer: number | null = null
  #expandPending = false
  #mounted = false
  #disposed = false

  /** @param options - apply-world callbacks. */
  constructor(options: MobileControllerOptions) {
    this.#options = options
  }

  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean {
    const frame = findFrame()
    return frame !== null && !frame.hasAttribute('data-sidebar-collapsed')
  }

  /** Install the controller. Safe to call once; a second call is a no-op.
   *  The frame may not exist yet (the layout entry mounts after this
   *  plugin's apply), so the observer chain re-finds it when #root gains
   *  its child. */
  mount(): void {
    if (this.#mounted) return
    this.#mounted = true
    const html = document.documentElement
    this.#html = html
    html.dataset.dshMobile = ''

    this.#installViewportMeta()

    this.#mql = window.matchMedia(MOBILE_BREAKPOINT)
    this.#mql.addEventListener('change', this.#onBreakpointChange)

    // Keyboard inset: the visual viewport shrinks when the OS keyboard
    // opens; the composer seat pads itself by the difference (rAF-throttled
    // — the resize fires every frame of the keyboard animation).
    const vv = window.visualViewport
    vv?.addEventListener('resize', this.#requestKeyboard)
    vv?.addEventListener('scroll', this.#requestKeyboard)

    // Keep the active page in place when the viewport width changes within
    // a breakpoint side (rotation / split-screen reflows the page tracks).
    window.addEventListener('resize', this.#onWindowResize)

    const root = document.getElementById('root')
    if (root !== null) {
      this.#rootObserver = new MutationObserver(() => { this.#ensureFrameObserver() })
      this.#rootObserver.observe(root, { childList: true })
    }
    this.#ensureFrameObserver()

    // The always-open phone layout: expand the sidebar first (AppFrame
    // auto-collapses it to the rail on narrow viewports), then place the
    // pager on the sidebar page without an animation. The rAF pass covers
    // the case where the frame's narrow flag settles after first paint.
    this.#ensureSidebarOpen()
    this.#syncPage('auto')
    this.#mountFrame = requestAnimationFrame(() => {
      this.#mountFrame = null
      this.#ensureSidebarOpen()
      this.#syncPage('auto')
    })
  }

  /** Remove every DOM effect; safe to call twice. */
  dispose(): void {
    if (!this.#mounted || this.#disposed) return
    this.#disposed = true
    this.#mounted = false
    this.#frameObserver?.disconnect()
    this.#frameObserver = null
    this.#rootObserver?.disconnect()
    this.#rootObserver = null
    this.#mql?.removeEventListener('change', this.#onBreakpointChange)
    this.#mql = null
    window.removeEventListener('resize', this.#onWindowResize)
    window.visualViewport?.removeEventListener('resize', this.#requestKeyboard)
    window.visualViewport?.removeEventListener('scroll', this.#requestKeyboard)
    for (const timer of [this.#keyboardFrame, this.#mountFrame, this.#resizeTimer, this.#settleTimer]) {
      if (timer !== null) (timer === this.#keyboardFrame || timer === this.#mountFrame ? cancelAnimationFrame : window.clearTimeout)(timer)
    }
    this.#keyboardFrame = null
    this.#mountFrame = null
    this.#resizeTimer = null
    this.#settleTimer = null
    const frame = findFrame()
    if (frame !== null) frame.removeEventListener('scroll', this.#onPagerScroll)
    if (this.#viewportMeta !== null) {
      if (this.#viewportOriginal !== null) this.#viewportMeta.content = this.#viewportOriginal
      else this.#viewportMeta.remove()
      this.#viewportMeta = null
      this.#viewportOriginal = null
    }
    const html = this.#html
    if (html !== null) {
      html.removeAttribute('data-dsh-mobile')
      html.removeAttribute(PAGE_ATTR)
      html.style.removeProperty('--dshm-keyboard-inset')
    }
    this.#html = null
  }

  #installViewportMeta(): void {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (existing !== null) {
      this.#viewportMeta = existing
      this.#viewportOriginal = existing.content
      existing.content = VIEWPORT_CONTENT
      return
    }
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = VIEWPORT_CONTENT
    document.head.append(meta)
    this.#viewportMeta = meta
  }

  /** The always-open phone layout expands the docked sidebar once when the
   *  viewport crosses into the mobile breakpoint (AppFrame auto-collapses
   *  it to the rail there). The request is idempotent: repeated calls while
   *  one expand is still in flight (mount sync pass, rAF pass, late frame)
   *  do not re-toggle. Seeing the frame actually expanded clears the pending
   *  request. A later manual collapse is left alone. */
  readonly #ensureSidebarOpen = (): void => {
    if (!(this.#mql?.matches ?? false)) return
    const frame = findFrame()
    if (frame === null) return
    if (!frame.hasAttribute('data-sidebar-collapsed')) {
      this.#expandPending = false
      return
    }
    if (this.#expandPending) return
    this.#expandPending = true
    this.#options.toggleSidebar()
  }

  /** Mirror the state-demanded page on <html> and, on mobile, scroll the
   *  frame to it. `behavior` distinguishes the state-driven flip (smooth)
   *  from initial placement and reflow (auto). Leaving the mobile breakpoint
   *  clears the 3D flip vars so the desktop layout renders flat. */
  readonly #syncPage = (behavior: ScrollBehavior): void => {
    const html = this.#html
    if (html === null) return
    const mobile = this.#mql?.matches ?? false
    const frame = findFrame()
    const page: MobilePage = !mobile || frame === null || frame.hasAttribute('data-sidebar-collapsed')
      ? 'chat'
      : 'sidebar'
    html.setAttribute(PAGE_ATTR, page)
    if (frame === null || !mobile) {
      // Desktop: the stock layout owns the columns; drop any leftover flip.
      for (const prop of ['--dshm-rotate', '--dshm-scale', '--dshm-offset-x', '--dshm-origin-x']) {
        frame?.style.removeProperty(prop)
      }
      return
    }
    const left = page === 'sidebar' ? 0 : chatPageLeft(frame)
    if (Math.abs(frame.scrollLeft - left) > 2) {
      frame.scrollTo({ left, behavior })
    }
    // The 3D flip vars must reflect the resting position too — an initial
    // placement on the sidebar page (or a state flip) does not fire a
    // scroll event, so the chat card would otherwise sit at rotateY(0).
    this.#updateFlipVars(frame)
  }

  /** State flips animate the page transition; an expand that landed clears
   *  the pending always-open request. */
  readonly #onFrameCollapseChange = (): void => {
    if (!findFrame()?.hasAttribute('data-sidebar-collapsed')) this.#expandPending = false
    this.#syncPage('smooth')
  }

  readonly #ensureFrameObserver = (): void => {
    if (this.#frameObserver !== null) return
    const frame = findFrame()
    if (frame === null) return
    this.#frameObserver = new MutationObserver(this.#onFrameCollapseChange)
    this.#frameObserver.observe(frame, {
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed'],
    })
    // Live pager settle re-snap rides the frame's own scroll.
    frame.addEventListener('scroll', this.#onPagerScroll, { passive: true })
    // A frame that appears after mount (the layout entry loads later) still
    // gets the always-open treatment.
    this.#ensureSidebarOpen()
    this.#syncPage('auto')
  }

  /** Crossing the breakpoint: entering mobile re-expands the sidebar (the
   *  state flip then moves the pager); leaving does nothing — the stock
   *  layout owns the desktop. */
  readonly #onBreakpointChange = (): void => {
    this.#ensureSidebarOpen()
    this.#syncPage('auto')
  }

  /** Width reflow within one breakpoint side: reposition the active page. */
  readonly #onWindowResize = (): void => {
    if (this.#resizeTimer !== null) return
    this.#resizeTimer = window.setTimeout(() => {
      this.#resizeTimer = null
      this.#syncPage('auto')
    }, 120)
  }

  /** Live pager driver: PiUI's 3D flip vars follow the scroll, and once the
   *  scroll settles the pager re-snaps to the nearest whole page (a
   *  short-of-page stop is nudged). The state is deliberately NOT synced —
   *  the sidebar stays expanded (always rendered), so a swipe merely parks
   *  the pager; the sidebar column never re-renders. */
  readonly #onPagerScroll = (): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    this.#updateFlipVars(frame)
    if (this.#settleTimer !== null) window.clearTimeout(this.#settleTimer)
    this.#settleTimer = window.setTimeout(() => {
      this.#settleTimer = null
      this.#settlePager()
    }, SCROLL_SETTLE_MS)
  }

  /** PiUI's flip: progress -1 (sidebar page) … 0 (chat page); the chat card
   *  rotates about the edge toward the swipe side and shrinks, so on the
   *  sidebar page it sinks away leaving only a sliver visible. */
  readonly #updateFlipVars = (frame: HTMLElement): void => {
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    const progress = Math.max(-1, Math.min(1, (frame.scrollLeft - chatLeft) / chatLeft))
    const abs = Math.abs(progress)
    const right = Math.max(0, progress)
    frame.style.setProperty('--dshm-rotate', `${progress * 10}deg`)
    frame.style.setProperty('--dshm-scale', `${1 - abs * 0.06}`)
    frame.style.setProperty('--dshm-offset-x', `${right * right * -48}px`)
    frame.style.setProperty('--dshm-origin-x', `${50 - progress * 50}%`)
  }

  readonly #settlePager = (): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    const left = frame.scrollLeft
    const nearest: MobilePage = left < chatLeft / 2 ? 'sidebar' : 'chat'
    const target = nearest === 'sidebar' ? 0 : chatLeft
    if (Math.abs(left - target) > 4) {
      frame.scrollTo({ left: target, behavior: 'smooth' })
    }
  }

  readonly #requestKeyboard = (): void => {
    if (this.#keyboardFrame !== null) return
    this.#keyboardFrame = requestAnimationFrame(() => {
      this.#keyboardFrame = null
      this.#updateKeyboardInset()
    })
  }

  readonly #updateKeyboardInset = (): void => {
    const html = this.#html
    if (html === null) return
    const vv = window.visualViewport
    const inset = vv !== null && vv.height < window.innerHeight
      ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      : 0
    html.style.setProperty('--dshm-keyboard-inset', `${inset}px`)
  }
}
