/**
 * DOM-side mobile controller: the non-React half of the plugin. Owns the
 * pieces the frame itself cannot express — the viewport meta upgrade, the
 * safe-area/keyboard CSS variables, the drawer open-state mirror on <html>,
 * and the plugin's own chrome (drawer backdrop, hero menu FAB). Everything
 * it installs is removed by dispose(), and every rule it depends on is
 * scoped under the [data-dsh-mobile] attribute it sets on <html>.
 *
 * The drawer open state is read off the AppFrame's own DOM (the
 * data-sidebar-collapsed attribute flips when the frame's sidebar collapses
 * or expands), so the controller never reaches into the layout store — it
 * observes the frame and mirrors the state on <html> for the stylesheet.
 */

/** The narrow breakpoint the layout restructure keys off (PiUI's 768px). */
export const MOBILE_BREAKPOINT = '(max-width: 768px)'

/** The <html> attribute that mirrors the drawer's open state (CSS reads it). */
export const DRAWER_ATTR = 'data-dshm-drawer'

/** Marker attributes for the plugin-owned chrome elements. */
export const BACKDROP_ATTR = 'data-dshm-backdrop'
export const FAB_ATTR = 'data-dshm-fab-menu'

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

/** Callbacks the controller needs from the apply world. */
export interface MobileControllerOptions {
  /** Toggle the sidebar panel (frame-owned layout action). */
  toggleSidebar: () => void
}

/** Test-facing surface of the controller (the class keeps everything else private). */
export interface MobileControllerHandle {
  /** True while the drawer is mirrored open on <html>. */
  isDrawerOpen(): boolean
  /** Close the drawer when it is open (a session pick from the drawer). */
  closeDrawer(): void
  /** Install the controller; idempotent. */
  mount(): void
  /** Remove every DOM effect; idempotent. */
  dispose(): void
}

/** The DOM-side controller (see module doc). */
export class MobileController implements MobileControllerHandle {
  readonly #options: MobileControllerOptions
  #html: HTMLElement | null = null
  #backdrop: HTMLDivElement | null = null
  #fab: HTMLButtonElement | null = null
  #mql: MediaQueryList | null = null
  #frameObserver: MutationObserver | null = null
  #rootObserver: MutationObserver | null = null
  #viewportMeta: HTMLMetaElement | null = null
  #viewportOriginal: string | null = null
  #keyboardFrame: number | null = null
  #mounted = false
  #disposed = false

  /** @param options - apply-world callbacks. */
  constructor(options: MobileControllerOptions) {
    this.#options = options
  }

  /** True while the drawer is mirrored open on <html>. */
  isDrawerOpen(): boolean {
    return this.#html?.hasAttribute(DRAWER_ATTR) ?? false
  }

  /** Close the drawer when it is open (a session pick from the drawer). */
  closeDrawer(): void {
    if (this.isDrawerOpen()) this.#options.toggleSidebar()
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
    this.#backdrop = this.#makeBackdrop()
    this.#fab = this.#makeFab()
    document.body.append(this.#backdrop, this.#fab)

    this.#mql = window.matchMedia(MOBILE_BREAKPOINT)
    this.#mql.addEventListener('change', this.#syncDrawer)

    // Keyboard inset: the visual viewport shrinks when the OS keyboard opens;
    // the composer seat pads itself by the difference (rAF-throttled — the
    // resize fires every frame of the keyboard animation).
    const vv = window.visualViewport
    vv?.addEventListener('resize', this.#requestKeyboard)
    vv?.addEventListener('scroll', this.#requestKeyboard)

    // Drawer open state tracks the frame's own collapsed attribute.
    const root = document.getElementById('root')
    if (root !== null) {
      this.#rootObserver = new MutationObserver(() => { this.#ensureFrameObserver() })
      this.#rootObserver.observe(root, { childList: true })
    }
    this.#ensureFrameObserver()

    // Picking a session from the drawer closes it after the native row
    // handler opens the session (capture runs before, microtask after).
    document.addEventListener('click', this.#onDocumentClickCapture, true)

    this.#syncDrawer()
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
    this.#mql?.removeEventListener('change', this.#syncDrawer)
    this.#mql = null
    window.visualViewport?.removeEventListener('resize', this.#requestKeyboard)
    window.visualViewport?.removeEventListener('scroll', this.#requestKeyboard)
    if (this.#keyboardFrame !== null) {
      cancelAnimationFrame(this.#keyboardFrame)
      this.#keyboardFrame = null
    }
    document.removeEventListener('click', this.#onDocumentClickCapture, true)
    this.#backdrop?.remove()
    this.#backdrop = null
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
      html.removeAttribute(DRAWER_ATTR)
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

  #makeBackdrop(): HTMLDivElement {
    const backdrop = document.createElement('div')
    backdrop.dataset.dshmBackdrop = ''
    backdrop.setAttribute('aria-hidden', 'true')
    backdrop.addEventListener('click', this.#options.toggleSidebar)
    return backdrop
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

  readonly #syncDrawer = (): void => {
    const html = this.#html
    if (html === null) return
    const mobile = this.#mql?.matches ?? false
    const frame = findFrame()
    const open = mobile && frame !== null && !frame.hasAttribute('data-sidebar-collapsed')
    if (open) html.setAttribute(DRAWER_ATTR, 'open')
    else html.removeAttribute(DRAWER_ATTR)
    this.#fab?.setAttribute('aria-expanded', String(open))
  }

  readonly #ensureFrameObserver = (): void => {
    if (this.#frameObserver !== null) return
    const frame = findFrame()
    if (frame === null) return
    this.#frameObserver = new MutationObserver(this.#syncDrawer)
    this.#frameObserver.observe(frame, {
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed'],
    })
    this.#syncDrawer()
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

  readonly #onDocumentClickCapture = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest(`[${BACKDROP_ATTR}], [${FAB_ATTR}]`) !== null) return
    if (!this.isDrawerOpen()) return
    // A session row picked from the drawer closes it; the native row handler
    // opens the session on the same gesture, and the microtask runs after it.
    if (target.closest('[role="treeitem"]') !== null) {
      queueMicrotask(() => { this.closeDrawer() })
    }
  }
}
