/**
 * DOM-side mobile controller: the non-React half of the plugin. Owns the
 * pieces the frame itself cannot express — the viewport meta upgrade, the
 * safe-area/keyboard CSS variables, the pager page mirror on <html>, and the
 * plugin's own chrome (hero menu FAB). Everything it installs is removed by
 * dispose(), and every rule it depends on is scoped under the
 * [data-dsh-mobile] attribute it sets on <html>.
 *
 * Mobile layout is PiUI's chat pager: the STOCK AppFrame becomes a
 * horizontal scroll-snap pager whose columns are the pages (sidebar | chat |
 * details — mobile.css reflows the grid tracks). The current page is driven
 * by the frame's own state: below the breakpoint, a collapsed sidebar means
 * the chat page is active, an expanded one means the sidebar page is. The
 * controller watches the frame's data-sidebar-collapsed attribute and
 * scrolls the pager to match; a manual swipe is never overridden.
 */

/** The narrow breakpoint the pager keys off (PiUI's 768px). */
export const MOBILE_BREAKPOINT = '(max-width: 768px)'

/** The <html> attribute that mirrors the active pager page (CSS/aria reads it). */
export const PAGE_ATTR = 'data-dshm-page'

/** Marker attribute for the plugin-owned hero FAB. */
export const FAB_ATTR = 'data-dshm-fab-menu'

/** Pager page names (the mirror values of PAGE_ATTR). */
export type MobilePage = 'sidebar' | 'chat'

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

/** Hamburger glyph shared by the menu button and the hero FAB. */
export const MENU_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">'
  + '<path d="M2 4.25h12M2 8h12M2 11.75h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>'

/** The AppFrame element, or null before the layout entry mounts it. */
function findFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FRAME_SELECTOR)
}

/** The pager's chat-page snap position: the rendered width of the sidebar
 *  page column (PiUI's overlayWidth; the CSS track is calc(100% - 72px)). */
function chatPageLeft(frame: HTMLElement): number {
  const sidebar = frame.firstElementChild
  return sidebar instanceof HTMLElement ? sidebar.offsetWidth : 0
}

/** Callbacks the controller needs from the apply world. */
export interface MobileControllerOptions {
  /** Toggle the sidebar panel (frame-owned layout action). */
  toggleSidebar: () => void
}

/** Test-facing surface of the controller (the class keeps everything else private). */
export interface MobileControllerHandle {
  /** True while the pager sits on the sidebar page (mobile, sidebar expanded). */
  isSidebarOpen(): boolean
  /** Return to the chat page when the sidebar page is open (a session pick). */
  returnToChat(): void
  /** Install the controller; idempotent. */
  mount(): void
  /** Remove every DOM effect; idempotent. */
  dispose(): void
}

/** The DOM-side controller (see module doc). */
export class MobileController implements MobileControllerHandle {
  readonly #options: MobileControllerOptions
  #html: HTMLElement | null = null
  #fab: HTMLButtonElement | null = null
  #mql: MediaQueryList | null = null
  #frameObserver: MutationObserver | null = null
  #rootObserver: MutationObserver | null = null
  #viewportMeta: HTMLMetaElement | null = null
  #viewportOriginal: string | null = null
  #keyboardFrame: number | null = null
  #resizeTimer: number | null = null
  #mounted = false
  #disposed = false

  /** @param options - apply-world callbacks. */
  constructor(options: MobileControllerOptions) {
    this.#options = options
  }

  /**
   * True while the pager sits on the sidebar page. Reads the ACTUAL scroll
   * position, not the state mirror: the user can swipe there manually
   * without the frame's collapse state changing.
   */
  isSidebarOpen(): boolean {
    const frame = findFrame()
    if (frame === null || !(this.#mql?.matches ?? false)) return false
    return frame.scrollLeft < chatPageLeft(frame) / 2
  }

  /**
   * Return to the chat page (a session picked from the sidebar). Two entry
   * shapes: the sidebar was opened through the menu (frame expanded — flip
   * the state back and let the observer slide the pager), or the user just
   * swiped there (frame still collapsed — scroll back directly).
   */
  returnToChat(): void {
    if (!this.isSidebarOpen()) return
    const frame = findFrame()
    if (frame === null) return
    if (frame.hasAttribute('data-sidebar-collapsed')) {
      frame.scrollTo({ left: chatPageLeft(frame), behavior: 'smooth' })
    } else {
      this.#options.toggleSidebar()
    }
  }

  /**
   * Install the controller. Safe to call once; a second call is a no-op.
   * The frame may not exist yet (the layout entry mounts after this plugin's
   * apply), so the observer chain re-finds it when #root gains its child.
   */
  mount(): void {
    if (this.#mounted) return
    this.#mounted = true
    const html = document.documentElement
    this.#html = html
    html.dataset.dshMobile = ''

    this.#installViewportMeta()
    this.#fab = this.#makeFab()
    document.body.append(this.#fab)

    this.#mql = window.matchMedia(MOBILE_BREAKPOINT)
    this.#mql.addEventListener('change', this.#onMqlChange)

    // Keyboard inset: the visual viewport shrinks when the OS keyboard opens;
    // the composer seat pads itself by the difference (rAF-throttled — the
    // resize fires every frame of the keyboard animation).
    const vv = window.visualViewport
    vv?.addEventListener('resize', this.#requestKeyboard)
    vv?.addEventListener('scroll', this.#requestKeyboard)

    // Keep the active page in place when the viewport width changes within a
    // breakpoint side (rotation / split-screen reflows the page tracks).
    window.addEventListener('resize', this.#onWindowResize)

    // The pager follows the frame's own collapse state (single source of
    // truth: AppFrame flips it when the sidebar expands over the squeezed
    // center below the breakpoint).
    const root = document.getElementById('root')
    if (root !== null) {
      this.#rootObserver = new MutationObserver(() => { this.#ensureFrameObserver() })
      this.#rootObserver.observe(root, { childList: true })
    }
    this.#ensureFrameObserver()

    this.#syncPage('auto')
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
    this.#mql?.removeEventListener('change', this.#onMqlChange)
    this.#mql = null
    window.removeEventListener('resize', this.#onWindowResize)
    window.visualViewport?.removeEventListener('resize', this.#requestKeyboard)
    window.visualViewport?.removeEventListener('scroll', this.#requestKeyboard)
    if (this.#keyboardFrame !== null) {
      cancelAnimationFrame(this.#keyboardFrame)
      this.#keyboardFrame = null
    }
    if (this.#resizeTimer !== null) {
      window.clearTimeout(this.#resizeTimer)
      this.#resizeTimer = null
    }
    this.#fab?.remove()
    this.#fab = null
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

  #makeFab(): HTMLButtonElement {
    const fab = document.createElement('button')
    fab.type = 'button'
    fab.dataset.dshmFabMenu = ''
    fab.setAttribute('aria-label', this.#fabLabel())
    fab.setAttribute('aria-expanded', 'false')
    fab.innerHTML = MENU_ICON
    fab.addEventListener('click', this.#options.toggleSidebar)
    return fab
  }

  #fabLabel(): string {
    return document.documentElement.lang === 'zh-CN' ? '打开侧边栏' : 'Open sidebar'
  }

  /**
   * Mirror the pager page on <html> and, on mobile, scroll the frame to the
   * page the frame's own state demands. `behavior` distinguishes the
   * state-driven flip (smooth) from initial placement and reflow (auto).
   */
  readonly #syncPage = (behavior: ScrollBehavior): void => {
    const html = this.#html
    if (html === null) return
    const mobile = this.#mql?.matches ?? false
    const frame = findFrame()
    const page: MobilePage = !mobile || frame === null || frame.hasAttribute('data-sidebar-collapsed')
      ? 'chat'
      : 'sidebar'
    html.setAttribute(PAGE_ATTR, page)
    this.#fab?.setAttribute('aria-expanded', String(page === 'sidebar'))
    if (frame === null || !mobile) return
    const left = page === 'sidebar' ? 0 : chatPageLeft(frame)
    if (Math.abs(frame.scrollLeft - left) > 2) {
      frame.scrollTo({ left, behavior })
    }
  }

  /** State flips animate the page transition. */
  readonly #onFrameCollapseChange = (): void => { this.#syncPage('smooth') }

  readonly #ensureFrameObserver = (): void => {
    if (this.#frameObserver !== null) return
    const frame = findFrame()
    if (frame === null) return
    this.#frameObserver = new MutationObserver(this.#onFrameCollapseChange)
    this.#frameObserver.observe(frame, {
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed'],
    })
    this.#syncPage('auto')
  }

  readonly #onMqlChange = (): void => { this.#syncPage('auto') }

  /** Width reflow within one breakpoint side: reposition the active page. */
  readonly #onWindowResize = (): void => {
    if (this.#resizeTimer !== null) return
    this.#resizeTimer = window.setTimeout(() => {
      this.#resizeTimer = null
      this.#syncPage('auto')
    }, 120)
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
