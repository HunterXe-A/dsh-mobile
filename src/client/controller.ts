/**
 * DOM-side mobile controller: the non-React half of the plugin. Owns the
 * pieces the frame itself cannot express — the viewport meta upgrade, the
 * safe-area CSS variables, and the pager's live state (page mirror,
 * 3D pager state, click-to-return). Everything it installs is removed by
 * dispose(), and every rule it depends on is scoped under the
 * [data-dsh-mobile] attribute it sets on <html>.
 *
 * Mobile layout follows PiUI's chat pager: the STOCK AppFrame becomes a
 * horizontal scroll-snap pager whose columns are two pages — an always-open
 * sidebar page and a full-width chat page. The frame's own state is only
 * touched to expand the auto-collapsed sidebar ONCE below the breakpoint
 * (AppFrame collapses it to the rail on narrow viewports); from then on the
 * pager position is fully user-driven: the app starts on the chat page,
 * a click on the exposed chat card flips back to it, and picking a session
 * in the sidebar returns to it. The sidebar column keeps its full content
 * rendered at all times (a swipe is never state-synced, so it never
 * re-renders).
 */

import { calculatePagerFlip, samePagerFlip, type PagerFlipState } from './pager-flip.ts'

/** The narrow breakpoint the pager keys off (PiUI's 768px). */
const MOBILE_BREAKPOINT = '(max-width: 768px)'

/** The <html> attribute that mirrors the pager page the frame is resting on. */
export const PAGE_ATTR = 'data-dshm-page'

/** Pager page names (the mirror values of PAGE_ATTR). */
type MobilePage = 'sidebar' | 'chat'


/** Wait after the last scroll event before the pager settles. */
const SCROLL_SETTLE_MS = 200

/** Poll interval for the return-to-chat smoother. The smooth scroll is only
 *  re-issued when it is actually STALLED (scrollLeft stopped advancing),
 *  never pre-empted while it is in flight — so a retry reads as a natural
 *  continuation, and the pager is never snapped to the chat page. */
const SMOOTH_RETRY_MS = 160

/** Window (ms) after a session pick during which automatic focus into the
 *  composer is bounced back out: picking a session in the sidebar lands
 *  focus on the input, which pops the OS keyboard over the pager's smooth
 *  return-to-chat. On phones the keyboard must not open until the user
 *  actually taps the input — the focus is suppressed (blurred) during this
 *  window, so the return scroll runs undisturbed. */
const FOCUS_SUPPRESS_MS = 600

/** A focusin is judged "the user's own tap" only when a pointerdown landed
 *  on the same element within this recent window (a real tap intent).
 *  Older pointerdowns (e.g. the session row the user just tapped) must not
 *  count. */
const POINTER_ALLOW_MS = 500

/** The sidebar shell's collapse toggle labels (zh / en) — clicking it while
 *  the sidebar is expanded must NOT collapse it to the rail (which would
 *  unload its content); it flips back to the chat page instead. */
const SIDEBAR_COLLAPSE_LABELS = new Set(['收起侧边栏', 'Collapse sidebar'])

/**
 * Viewport meta content: maximum-scale blocks the iOS focus zoom that would
 * otherwise fight the fixed-height mobile layout; viewport-fit=cover exposes
 * the safe-area insets to env().
 */
const VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content'

/**
 * 识别 AppFrame 元素的属性名（控制器会在首次发现时打上 dshm-frame 标记）。
 * 新版 DSH (rc.1) 移除了 data-details-collapsed，且 data-sidebar-collapsed
 * 仅在侧边栏收起时存在；手机端侧边栏展开后两个属性都不在。改用
 * data-rightbar-collapsed（手机端 rightbar 始终为 0，该属性始终存在）+ 已打
 * 标记的 data-dshm-frame 来定位。
 */
const FRAME_MARKER = 'data-dshm-frame'
const FIND_FRAME_SELECTOR = `[${FRAME_MARKER}], [data-rightbar-collapsed], [data-sidebar-collapsed]`

/** The AppFrame element, or null before the layout entry mounts it. */
function findFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FIND_FRAME_SELECTOR)
}

/**
 * The composer's model-name label (the first span of the model TRIGGER
 * button — pinned via aria-haspopup='menu' so the open picker's option
 * rows, whose first span is a flex-column optionCopy, are never mistaken
 * for it). Its overflow drives the marquee: the controller measures
 * scrollWidth - clientWidth, wraps a double copy of the text (each in its
 * own item span) and tags the label with data-dshm-marquee + duration —
 * mobile.css's dshm-marquee keyframes slide the runner by -50% (one text
 * width + one gap) on the compositor, so the tail exits, a gap passes,
 * then the head re-enters: a classic spaced ticker, clipped inside the
 * label so it can never overlap the effort badge or the context ring.
 */
const MODEL_LABEL_SELECTOR =
  "[data-composer-card] [data-slot='conversation.input.model'] button[aria-haspopup='menu'] > span:first-child"

/**
 * The gap between marquee repetitions (px): one copy slides out, this
 * blank space passes, then the head re-enters. Must match the item span's
 * padding-right in mobile.css.
 */
const MARQUEE_GAP_PX = 32

/**
 * The stock chat view shows a shimmering "Deep diving..." turn-status label
 * while a turn is running. The controller rewrites it to the actual task:
 * the model thinking with no tool in flight (思考中), an in-flight file/web
 * read or search (读取中), a file write/edit (写入中), and any other tool
 * execution (执行中). The status element is the only role=status with
 * aria-live=polite in the conversation scroll area. Tool names follow the
 * wire tool names (dsh-tool-* registrations); bash/pwsh rows carry no
 * data-tool, so data-sample="bash" is matched separately. A live compaction
 * (automatic or /compact) wins over every tool label (压缩中): the live flag
 * is driven by the conversationEvents compaction probe (registerCompactionProbe
 * in index.ts), with the running /compact card in the DOM as a fallback while
 * the event stream is not connected. The card's OWN stock summary (正在压缩…)
 * is rewritten to the same cute label, animating with the same trailing
 * dots even when no turn-status element exists (a /compact-only run).
 */
const TASK_STATUS_SELECTOR = '[role="status"][aria-live="polite"]'
const TASK_LABEL_THINKING = '小鲸鱼在想事情呢'
const TASK_LABEL_READING = '小鲸鱼在翻资料呢'
const TASK_LABEL_WRITING = '小鲸鱼在写笔记呢'
const TASK_LABEL_EXECUTING = '小鲸鱼在干活呢'
const TASK_LABEL_COMPACTING = '小鲸鱼在打包记忆呢'
const TASK_RUNNING_TOOL_SELECTOR =
  '[data-tool][data-state="running"], [data-sample="bash"][data-state="running"]'
/** A running /compact command card (GenericCommandCard, data-variant=others,
 *  data-state=running, title "compact") — the manual compaction in flight. */
const TASK_COMPACTING_SELECTOR = '[data-variant="others"][data-state="running"]'
/** Stock summaries a running /compact card renders while compaction is in
 *  flight (message.compaction.running in the zh/en locales); a text node
 *  starting with one of these gets rewritten to the cute label. */
const TASK_COMPACT_STOCK_PREFIXES = ['正在压缩', 'Compacting context']
/** Wire tool names whose in-flight call is a read/search task. */
const TASK_READ_TOOLS = new Set([
  'read',
  'read_image',
  'web_fetch',
  'web_search',
  'glob',
  'grep',
  'cordis_package_inspect',
  'cordis_runtime_inspect',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'get_goal',
  'job_list',
  'job_output',
])
/** Wire tool names whose in-flight call is a write/edit task. */
const TASK_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'todo_write',
  'create_goal',
  'update_goal',
  'str_replace_editor',
])
/** Step interval of the animated trailing dots after the task label
 *  (思考中 → 思考中. → 思考中.. → 思考中... → 思考中 → …). */
const TASK_DOTS_STEP_MS = 400


/** The rendered width of the sidebar page column (0 before first layout). */
function sidebarPageLeft(frame: HTMLElement): number {
  const sidebar = frame.firstElementChild
  return sidebar instanceof HTMLElement ? sidebar.offsetWidth : 0
}

/**
 * The pager's chat-page snap position: the rendered width of the sidebar
 * page column (the always-open card). Falls back to the frame's own width
 * while the layout has not settled (offsetWidth is 0 before first layout).
 */
function chatPageLeft(frame: HTMLElement): number {
  const sidebar = sidebarPageLeft(frame)
  if (sidebar > 0) return sidebar
  return frame.clientWidth
}

function chatPageCard(frame: HTMLElement): HTMLElement | null {
  const card = frame.children[1]
  return card instanceof HTMLElement ? card : null
}

/** Legacy custom properties left by pre-refactor package versions. */
const LEGACY_FLIP_PROPERTIES = [
  '--dshm-rotate',
  '--dshm-scale',
  '--dshm-offset-x',
  '--dshm-origin-x',
] as const

/** Callbacks the controller needs from the apply world. */
export interface MobileControllerOptions {
  /** Toggle the sidebar panel (frame-owned layout action). */
  toggleSidebar: () => void
  /** Force scroll-driven flip animations on/off (tests). Undefined = detect. */
  scrollAnimations?: boolean
}

/** Feature-detect scroll-driven animations (Chrome/WebView 115+, Safari 26+).
 *  The flip rides the frame's own scroll timeline on the compositor — in
 *  lockstep with native scrolling, immune to main-thread latency. */
const supportsScrollAnimations = (): boolean => {
  return typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
    && CSS.supports('animation-timeline', 'scroll(nearest inline)')
}

/** Test-facing surface of the controller (the class keeps everything else private). */
interface MobileControllerHandle {
  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean
  /** Return to the chat page (a session picked in the sidebar). */
  returnToChat(): void
  /** Drive the live compaction flag (from the conversationEvents probe). */
  setTaskCompacting(active: boolean): void
  /** Install the controller; idempotent. */
  mount(): void
  /** Remove every DOM effect; idempotent. */
  dispose(): void
}

/** The DOM-side controller (see module doc). */
export class MobileController implements MobileControllerHandle {
  readonly #options: MobileControllerOptions
  /** Whether the flip is delegated to scroll-driven CSS animations. */
  readonly #scrollAnimations: boolean
  #html: HTMLElement | null = null
  #mql: MediaQueryList | null = null
  #frameObserver: MutationObserver | null = null
  #frameResizeObserver: ResizeObserver | null = null
  #rootObserver: MutationObserver | null = null
  #composerObserver: MutationObserver | null = null
  #marqueeLabel: HTMLElement | null = null
  #marqueeRO: ResizeObserver | null = null
  #marqueeFrame: number | null = null
  #taskStatusFrame: number | null = null
  #taskStatusElement: HTMLElement | null = null
  #taskStatusOriginal: string | null = null
  #taskStatusDotTimer: number | null = null
  #taskStatusDotCount = 0
  #taskCompacting = false
  /** The floating "compacting" pill (fixed toast), present only while the
   *  live compaction flag is on and NO running /compact card supplies the
   *  DOM — the stock chat renders nothing during an automatic compaction,
   *  so this is the only visible cue (text + animated dots). */
  #compactingIndicator: HTMLDivElement | null = null
  #viewportMeta: HTMLMetaElement | null = null
  #viewportOriginal: string | null = null
  #mountFrame: number | null = null
  #resizeTimer: number | null = null
  #settleTimer: number | null = null
  #flipFrame: number | null = null
  #returnTimer: number | null = null
  /** Last seen window.innerWidth — the resize handler only re-anchors the
   *  pager when the WIDTH changed (rotation / split-screen reflows the page
   *  tracks). A height-only resize (OS keyboard pop, URL bar collapse) must
   *  never touch scrollLeft: re-anchoring there can cancel the smooth
   *  return-to-chat that a session pick just started. */
  #lastInnerWidth = -1
  /** Timestamp until which automatic focus into the composer is kicked back
   *  out (see FOCUS_SUPPRESS_MS). */
  #focusSuppressUntil = -1
  /** The most recent pointerdown target + time, used to tell the user's own
   *  tap on the composer from the app's automatic focus. */
  #lastPointerTarget: Element | null = null
  #lastPointerAt = -1
  #expandPending = false
  #mounted = false
  #disposed = false
  #conversationObserver: MutationObserver | null = null
  #conversationTarget: Element | null = null
  #lastActivityAt = 0
  /** Original parent of the mode button before relocation, used to restore
   *  on dispose. When null the button has not been relocated. */
  #modeButtonHome: Element | null = null
  #modeRelocateFrame: number | null = null
  /** Last applied visual state of the chat-page flip. */
  #flipState: PagerFlipState | null = null
  /** Cached chat-page left edge. Invalidated on width and collapse changes. */
  #cachedChatLeft = -1

  /** @param options - apply-world callbacks. */
  constructor(options: MobileControllerOptions) {
    this.#options = options
    this.#scrollAnimations = options.scrollAnimations ?? supportsScrollAnimations()
  }

  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean {
    const frame = findFrame()
    return frame !== null && !frame.hasAttribute('data-sidebar-collapsed')
  }

  /** Return to the chat page (a session picked in the sidebar). Pure scroll —
   *  the sidebar state is untouched, so its content stays rendered. */
  returnToChat(): void {
    // On phones, picking a session must NOT pop the OS keyboard: the app
    // auto-focuses the composer, and that keyboard would cover the pager's
    // smooth return-to-chat (and usually stalls it). Enter the focus
    // suppression window on mobile only — the desktop behavior (focus the
    // input after a session pick) stays untouched because the desktop
    // still wants to type straight away.
    if (this.#mql?.matches ?? false) {
      this.#focusSuppressUntil = Date.now() + FOCUS_SUPPRESS_MS
    }
    this.#redirectToChat()
  }

  /** Drive the live compaction flag: the conversationEvents probe calls this
   *  when a compaction lifecycle event lands (compaction/start → true;
   *  compaction/end → false). Ranks above every tool label in the status. */
  setTaskCompacting(active: boolean): void {
    if (this.#disposed || this.#taskCompacting === active) return
    this.#taskCompacting = active
    this.#syncCompactingIndicator()
    this.#requestTaskStatusSync()
  }

  /** Smoothly scroll the pager back to the chat page. The smooth scroll is
   *  re-issued ONLY when it is genuinely stalled (scrollLeft stops
   *  advancing across a poll) — the rare browser/OS cancellation case —
   *  and every re-issue is also smooth, so the retry never reads as an
   *  instant jump: the user always sees a natural slide back to the
   *  session. While the animation is in flight (or has landed) the poll is
   *  a no-op. */
  readonly #redirectToChat = (): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    this.#placeOnChat('smooth')
    if (this.#returnTimer !== null) window.clearTimeout(this.#returnTimer)
    let last = frame.scrollLeft
    const poll = (): void => {
      this.#returnTimer = null
      const f = findFrame()
      const mm = this.#mql?.matches ?? false
      if (f === null || !mm) return
      const cl = chatPageLeft(f)
      if (cl <= 0) return
      if (f.scrollLeft >= cl - 4) return // landed on the chat page
      if (f.scrollLeft <= last) {
        // Stalled (not advancing): nudge it along, smoothly — never snap.
        this.#placeOnChat('smooth')
      }
      last = f.scrollLeft
      this.#returnTimer = window.setTimeout(poll, SMOOTH_RETRY_MS)
    }
    this.#returnTimer = window.setTimeout(poll, SMOOTH_RETRY_MS)
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

    // Keep the active page in place when the viewport width changes within
    // a breakpoint side (rotation / split-screen reflows the page tracks).
    this.#lastInnerWidth = window.innerWidth
    window.addEventListener('resize', this.#onWindowResize)

    // A tap on the exposed chat card (while the pager rests on the sidebar
    // page) returns to the chat page — PiUI's overlay behavior.
    document.addEventListener('click', this.#onDocClickCapture, true)

    // After a session pick the app auto-focuses the composer textarea; on a
    // phone that pops the OS keyboard over the pager's return-to-chat.
    // Record real pointer-downs (the user's own taps) and, during the
    // post-pick window, blur any focus into the composer that does NOT stem
    // from one — the user's own tap still focuses (they want to type), the
    // automatic focus is bounced.
    document.addEventListener('pointerdown', this.#onPointerDownCapture, true)
    document.addEventListener('focusin', this.#onFocusInCapture, true)
    document.addEventListener('keydown', this.#onComposerKeyDown, true)

    // Toggle data-dshm-hidden so CSS can pause animations when tab is backgrounded.
    document.addEventListener('visibilitychange', this.#onVisibilityChange)

    const root = document.getElementById('root')
    if (root !== null) {
      this.#rootObserver = new MutationObserver(() => { this.#ensureFrameObserver(); this.#ensureConversationActivityObserver() })
      // subtree: the session view is mounted deep inside #root (the start
      // screen and an opened session swap the conversation scroll body), so
      // a top-level childList watch alone would miss the remount and leave
      // the activity/status observers attached to a detached node.
      this.#rootObserver.observe(root, { childList: true, subtree: true })
      // The composer mounts/unmounts with the session skeleton and the
      // model name swaps in place: any subtree change can move the label's
      // overflow state, so re-measure on every mutation (rAF-throttled —
      // the check is one querySelector + two reads, cheap even while
      // streaming tokens mutate the tree every frame).
      this.#composerObserver = new MutationObserver(() => { this.#requestMarqueeSync(); this.#requestModeRelocate() })
      this.#composerObserver.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }
    this.#ensureFrameObserver()
    // Layout-only overflow changes (row squeeze, font load) do not mutate
    // the tree: watch the label's box too. jsdom has no ResizeObserver, so
    // the guard keeps tests running on the mutation path alone.
    if (typeof ResizeObserver !== 'undefined') {
      this.#marqueeRO = new ResizeObserver(() => { this.#requestMarqueeSync() })
    }
    this.#requestMarqueeSync()

    // The always-open phone layout: expand the sidebar once (AppFrame
    // auto-collapses it to the rail on narrow viewports) so its content
    // stays fully rendered, then start on the CHAT page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
    this.#mountFrame = requestAnimationFrame(() => {
      this.#mountFrame = null
      this.#ensureSidebarOpen()
      this.#placeOnChat('auto')
    })
  }

  /** Remove every DOM effect; safe to call twice. */
  dispose(): void {
    if (!this.#mounted || this.#disposed) return
    this.#disposed = true
    this.#mounted = false
    this.#frameObserver?.disconnect()
    this.#frameObserver = null
    this.#frameResizeObserver?.disconnect()
    this.#frameResizeObserver = null
    this.#conversationObserver?.disconnect()
    this.#conversationObserver = null
    this.#conversationTarget = null
    this.#rootObserver?.disconnect()
    this.#rootObserver = null
    this.#composerObserver?.disconnect()
    this.#composerObserver = null
    this.#marqueeRO?.disconnect()
    this.#marqueeRO = null
    // Leave the model label as the stock ellipsis render (no marquee trail).
    if (this.#marqueeLabel !== null) {
      const label = this.#marqueeLabel
      label.removeAttribute('data-dshm-marquee')
      label.style.removeProperty('--dshm-marquee-duration')
      const runner = label.firstElementChild
      if (runner !== null && runner.hasAttribute('data-dshm-marquee-runner')) {
        // Unwrap keeping the FIRST item's text (the original nodes — the
        // second item is the seamless-loop clone).
        const original = runner.firstElementChild?.firstChild ?? null
        runner.remove()
        if (original !== null) label.append(original)
      }
    }
    this.#marqueeLabel = null
    // Return the rewritten turn-status label to its stock text.
    if (this.#taskStatusElement !== null) {
      const first = this.#taskStatusElement.firstChild
      if (first !== null && first.nodeType === Node.TEXT_NODE && this.#taskStatusOriginal !== null && first.nodeValue !== this.#taskStatusOriginal) {
        first.nodeValue = this.#taskStatusOriginal
      }
      this.#taskStatusElement = null
      this.#taskStatusOriginal = null
    }
    if (this.#taskStatusDotTimer !== null) {
      window.clearInterval(this.#taskStatusDotTimer)
      this.#taskStatusDotTimer = null
    }
    this.#taskStatusDotCount = 0
    if (this.#compactingIndicator !== null) {
      this.#compactingIndicator.remove()
      this.#compactingIndicator = null
    }
    this.#mql?.removeEventListener('change', this.#onBreakpointChange)
    this.#mql = null
    window.removeEventListener('resize', this.#onWindowResize)
    document.removeEventListener('click', this.#onDocClickCapture, true)
    document.removeEventListener('pointerdown', this.#onPointerDownCapture, true)
    document.removeEventListener('focusin', this.#onFocusInCapture, true)
    document.removeEventListener('visibilitychange', this.#onVisibilityChange)
    document.removeEventListener('keydown', this.#onComposerKeyDown, true)
    for (const timer of [this.#mountFrame, this.#resizeTimer, this.#settleTimer, this.#flipFrame, this.#marqueeFrame, this.#returnTimer, this.#taskStatusFrame, this.#modeRelocateFrame]) {
      if (timer !== null) (timer === this.#mountFrame || timer === this.#flipFrame || timer === this.#marqueeFrame || timer === this.#taskStatusFrame || timer === this.#modeRelocateFrame ? cancelAnimationFrame : window.clearTimeout)(timer)
    }
    this.#mountFrame = null
    this.#resizeTimer = null
    this.#settleTimer = null
    this.#flipFrame = null
    this.#marqueeFrame = null
    this.#returnTimer = null
    this.#taskStatusFrame = null
    this.#modeRelocateFrame = null
    const frame = findFrame()
    if (frame !== null) {
      frame.removeEventListener('scroll', this.#onPagerScroll)
      frame.removeAttribute(FRAME_MARKER)
      const card = chatPageCard(frame)
      card?.removeAttribute('data-dshm-flipping')
      card?.removeAttribute('data-dshm-scrollanim')
    }
    if (this.#viewportMeta !== null) {
      if (this.#viewportOriginal !== null) this.#viewportMeta.content = this.#viewportOriginal
      else this.#viewportMeta.remove()
      this.#viewportMeta = null
      this.#viewportOriginal = null
    }
    const html = this.#html
    this.#clearFlipStyles(frame)
    if (html !== null) {
      html.removeAttribute('data-dsh-mobile')
      html.removeAttribute(PAGE_ATTR)
    }
    this.#restoreModeButton()
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

  readonly #onFrameResize = (): void => {
    this.#cachedChatLeft = -1
  }

  /** Read the cached chat-page edge, refreshing only after a layout change. */
  readonly #getChatLeft = (frame: HTMLElement): number => {
    let chatLeft = this.#cachedChatLeft
    if (chatLeft < 0) {
      chatLeft = chatPageLeft(frame)
      this.#cachedChatLeft = chatLeft > 0 ? chatLeft : -1
    }
    return chatLeft
  }

  /** Remove all flip styles, including values from older plugin versions. */
  readonly #clearFlipStyles = (frame: HTMLElement | null): void => {
    const card = frame === null ? null : chatPageCard(frame)
    for (const property of LEGACY_FLIP_PROPERTIES) {
      frame?.style.removeProperty(property)
      card?.style.removeProperty(property)
    }
    frame?.style.removeProperty('--dshm-flip-transform')
    frame?.style.removeProperty('--dshm-flip-origin')
    card?.style.removeProperty('--dshm-flip-transform')
    card?.style.removeProperty('--dshm-flip-origin')
    card?.style.removeProperty('transform')
    card?.style.removeProperty('transform-origin')
    card?.style.removeProperty('border-radius')
    card?.style.removeProperty('box-shadow')
    // The card's flipping marker is the warm-layer grant: it lives for the
    // whole mobile session (bind → dispose / breakpoint leave) and is NOT
    // removed here — only the html-level legacy attr is.
    this.#html?.removeAttribute('data-dshm-flipping')
    this.#flipState = null
  }

  /** Apply a flip state only when its visual output changed. */
  readonly #syncFlip = (frame: HTMLElement, chatLeft: number): void => {
    // Scroll-driven animations drive the flip on the compositor in lockstep
    // with the scroll; inline styles here would only fight them.
    if (this.#scrollAnimations) return
    const next = calculatePagerFlip(frame.scrollLeft, chatLeft)
    if (samePagerFlip(this.#flipState, next)) return

    const card = chatPageCard(frame)
    if (next.active && card !== null) {
      card.style.setProperty('transform', next.transform)
      card.style.setProperty('transform-origin', next.origin)
      // Chrome invalidates paint (transform does not): only rewrite it when
      // the quantized value actually stepped.
      if (this.#flipState?.radius !== next.radius) card.style.setProperty('border-radius', next.radius)
      if (this.#flipState?.shadow !== next.shadow) card.style.setProperty('box-shadow', next.shadow)
      this.#flipState = next
      return
    }
    this.#clearFlipStyles(frame)
    this.#flipState = next
  }

  /** Mirror the resting page and update its live visual flip from one measure. */
  readonly #syncPager = (frame: HTMLElement, hint?: MobilePage): void => {
    const chatLeft = this.#getChatLeft(frame)
    const page: MobilePage = chatLeft <= 0
      ? (hint ?? 'chat')
      : frame.scrollLeft < chatLeft / 2 ? 'sidebar' : 'chat'
    const html = this.#html
    if (html !== null && html.getAttribute(PAGE_ATTR) !== page) {
      html.setAttribute(PAGE_ATTR, page)
    }
    this.#syncFlip(frame, chatLeft)
  }

  /** Scroll the pager to the chat page and mirror the resting page. */
  readonly #placeOnChat = (behavior: ScrollBehavior): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    if (Math.abs(frame.scrollLeft - chatLeft) > 2) {
      frame.scrollTo({ left: chatLeft, behavior })
    }
    this.#cachedChatLeft = chatLeft
    this.#syncPager(frame, 'chat')
  }

  /** State flips no longer drive the pager (the page is user-driven):
   *  - expand landed → clear the pending always-open request
   *  - re-collapse (e.g. right sidebar open resets narrowExpanded) →
   *    re-expand to maintain the always-open phone layout */
  readonly #onFrameCollapseChange = (): void => {
    // The rail/expanded transition changes the rendered sidebar width, so the
    // cached chat-page edge must be measured again before the next scroll.
    this.#cachedChatLeft = -1
    if (!findFrame()?.hasAttribute('data-sidebar-collapsed')) {
      this.#expandPending = false
    } else {
      this.#ensureSidebarOpen()
    }
  }

  readonly #ensureFrameObserver = (): void => {
    if (this.#frameObserver !== null) return
    const frame = findFrame()
    if (frame === null) return
    // 给 frame 打标记，供 CSS 和后续查询使用。
    frame.setAttribute(FRAME_MARKER, '')
    // The chat card keeps ONE composited layer for the whole mobile session:
    // granting it at bind time avoids re-rasterizing the full-screen card
    // twice per gesture (create at swipe start, destroy at rest) — the
    // heaviest remaining per-swipe cost. preserve-3d is long gone, so no
    // sticky/fixed descendant is ever trapped in a 3D context.
    if (this.#mql?.matches ?? false) {
      const card = chatPageCard(frame)
      card?.setAttribute('data-dshm-flipping', '')
      if (this.#scrollAnimations) card?.setAttribute('data-dshm-scrollanim', '')
    }
    // A stale inline transform-origin from an older fallback session would
    // break the keyframe geometry (animations do not touch transform-origin).
    this.#clearFlipStyles(frame)
    this.#frameObserver = new MutationObserver(this.#onFrameCollapseChange)
    this.#frameObserver.observe(frame, {
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed'],
    })
    if (typeof ResizeObserver !== 'undefined') {
      this.#frameResizeObserver = new ResizeObserver(this.#onFrameResize)
      this.#frameResizeObserver.observe(frame)
      const sidebar = frame.firstElementChild
      if (sidebar instanceof HTMLElement) this.#frameResizeObserver.observe(sidebar)
    }
    // Live pager driving (3D flip + settle re-snap) rides the frame's own
    // scroll.
    frame.addEventListener('scroll', this.#onPagerScroll, { passive: true })
    // A frame that appears after mount (the layout entry loads later) still
    // gets the always-open treatment and starts on the chat page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
    this.#ensureConversationActivityObserver()
  }

  /** Crossing the breakpoint: entering mobile re-expands the sidebar and
   *  places the pager on the chat page; leaving clears the 3D flip vars so
   *  the desktop layout renders flat. */
  readonly #onBreakpointChange = (): void => {
    const mobile = this.#mql?.matches ?? false
    const frame = findFrame()
    const card = frame === null ? null : chatPageCard(frame)
    if (!mobile) {
      this.#clearFlipStyles(frame)
      card?.removeAttribute('data-dshm-flipping')
      card?.removeAttribute('data-dshm-scrollanim')
      this.#html?.removeAttribute(PAGE_ATTR)
      return
    }
    card?.setAttribute('data-dshm-flipping', '')
    if (this.#scrollAnimations) card?.setAttribute('data-dshm-scrollanim', '')
    this.#cachedChatLeft = -1
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
  }

  /** Width reflow within one breakpoint side: keep the active page put and
   *  re-measure the model-name overflow (the row width drives it). Only a
   *  WIDTH change re-anchors — a height-only resize (OS keyboard pop, URL
   *  bar) must never scroll the pager, or it would cancel the smooth
   *  return-to-chat a session pick just started (the composer's focus
   *  landing pops the keyboard exactly then). */
  readonly #onWindowResize = (): void => {
    if (this.#resizeTimer !== null) return
    this.#resizeTimer = window.setTimeout(() => {
      this.#resizeTimer = null
      const frame = findFrame()
      const mobile = this.#mql?.matches ?? false
      if (frame === null || !mobile) return
      const widthChanged = window.innerWidth !== this.#lastInnerWidth
      this.#lastInnerWidth = window.innerWidth
      this.#requestMarqueeSync()
      if (widthChanged) {
        // The sidebar width (and thus the chat-page left edge) may have
        // changed with the viewport width — drop the cached measure so the
        // next scroll re-measures it.
        this.#cachedChatLeft = -1
      } else {
        return
      }
      const chatLeft = chatPageLeft(frame)
      if (chatLeft <= 0) return
      const onChat = frame.scrollLeft >= chatLeft / 2
      frame.scrollTo({ left: onChat ? chatLeft : 0, behavior: 'auto' })
      this.#syncPager(frame)
    }, 120)
  }

  /** Live pager driver: PiUI's 3D flip vars follow the scroll, and once the
   *  scroll settles the pager re-snaps to the nearest whole page. Scroll events
   *  can arrive more than once per display frame, so the visual sync is coalesced
   *  to one rAF while the settle timer still follows the latest input. */
  readonly #onPagerScroll = (): void => {
    if (this.#flipFrame === null) {
      let waiting = true
      const handle = requestAnimationFrame(() => {
        waiting = false
        this.#flipFrame = null
        const frame = findFrame()
        const mobile = this.#mql?.matches ?? false
        if (frame === null || !mobile) return
        this.#syncPager(frame)
      })
      if (waiting) this.#flipFrame = handle
    }
    if (this.#settleTimer !== null) window.clearTimeout(this.#settleTimer)
    this.#settleTimer = window.setTimeout(() => {
      this.#settleTimer = null
      this.#settlePager()
    }, SCROLL_SETTLE_MS)
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
    this.#cachedChatLeft = chatLeft
    this.#syncPager(frame)
  }

  /** Record every pointerdown (capture, passive) so the focus-in suppressor
   *  can distinguish the user's own tap on the composer from the app's
   *  automatic focus. The down also re-measures the chat-page edge once per
   *  gesture — a cheap self-heal for a stale cache the resize/attribute
   *  observers missed. It writes NO visual state: the compositing layer is
   *  granted once at bind time, so nothing here can race gesture arbitration. */
  readonly #onPointerDownCapture = (event: PointerEvent): void => {
    const target = event.target
    this.#lastPointerTarget = target instanceof Element ? target : null
    this.#lastPointerAt = Date.now()
    const frame = findFrame()
    if (frame === null || !this.#mql?.matches || !(target instanceof Element) || !frame.contains(target)) return
    const measured = sidebarPageLeft(frame)
    if (measured > 0 && measured !== this.#cachedChatLeft) this.#cachedChatLeft = measured
  }

  /** During the post-pick window, bounce automatic focus out of the
   *  composer (the OS keyboard must not cover the return-to-chat). The
   *  user's OWN tap still focuses: a recent pointerdown on the same element
   *  (or inside it) means a real intent to type. */
  readonly #onFocusInCapture = (event: FocusEvent): void => {
    if (Date.now() > this.#focusSuppressUntil) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('[data-composer-card]') === null) return
    const pointer = this.#lastPointerTarget
    const ownTap = pointer !== null
      && Date.now() - this.#lastPointerAt < POINTER_ALLOW_MS
      && (pointer === target || target.contains(pointer))
    if (ownTap) return
    target.blur()
  }

  /** Touch Enter inserts a newline while preserving the stock modifier and
   *  slash-menu paths. The composer surface differs by dsh generation:
   *  <= 0.1.1 renders a <textarea>, >= 0.1.2 a Lexical contenteditable
   *  ([data-composer-input]). On the contenteditable, stopping the keydown
   *  keeps Lexical's KEY_ENTER_COMMAND (submit) from firing while the OS
   *  keyboard's own beforeinput insertParagraph still lands the line break
   *  through Lexical's model — no editor desync. */
  readonly #onComposerKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    if (event.key !== 'Enter') return
    const isTextarea = target instanceof HTMLTextAreaElement
    const isComposerEditable = target instanceof Element
      && target.closest('[data-composer-input]') !== null
    if (!isTextarea && !isComposerEditable) return
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (!this.#mql?.matches || target.closest('[data-composer-card]') === null) return
    if (document.querySelector('[role="listbox"][aria-activedescendant]') !== null) return
    event.stopImmediatePropagation()
  }

  /** A tap on the exposed chat card returns to the chat page (PiUI's
   *  overlay behavior: the exposed chat is not interactive while the
   *  sidebar page is showing). The sidebar's own collapse toggle is
   *  intercepted the same way: collapsing to the rail would unload the
   *  sidebar content, so it flips back to the chat page instead — the
   *  state (expanded) is never touched. */
  readonly #onDocClickCapture = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    const sidebarCol = frame.firstElementChild
    // The sidebar's collapse toggle: stop the rail collapse, return to chat.
    if (sidebarCol instanceof Element && sidebarCol.contains(target)) {
      const btn = target.closest('button')
      if (btn !== null && SIDEBAR_COLLAPSE_LABELS.has(btn.getAttribute('aria-label') ?? '')) {
        event.preventDefault()
        event.stopPropagation()
        this.returnToChat()
        return
      }
    }
    // The exposed chat card: return to chat (only while on the sidebar page).
    if (frame.scrollLeft >= chatLeft / 2) return
    const chatCard = frame.children[1]
    if (chatCard instanceof Element && chatCard.contains(target)) {
      this.returnToChat()
    }
  }

  /** Relocate the mode-button (agent preset / "Standard mode") from the
   *  header title-row into the tabs row, right-aligned. This saves one
   *  row of vertical header space on mobile. Called rAF-throttled from
   *  the composer observer. */
  readonly #requestModeRelocate = (): void => {
    if (this.#modeRelocateFrame !== null) return
    this.#modeRelocateFrame = requestAnimationFrame(() => {
      this.#modeRelocateFrame = null
      this.#syncModeRelocate()
    })
  }

  #syncModeRelocate(): void {
    if (this.#disposed) return
    const header = document.querySelector('header[aria-hidden]') ? null
      : document.querySelector('header')
    if (header === null) return

    const tablist = header.querySelector<HTMLElement>('[role="tablist"]')
    const actionsSlot = header.querySelector(
      '[data-slot="conversation.session.header.actions"]',
    )
    if (tablist === null || actionsSlot === null) {
      // Header has no tabs (hero phase) — restore button if relocated
      this.#restoreModeButton()
      return
    }

    // The mode button is a <span class="…_label"> inside the actions slot.
    const modeBtn = actionsSlot.querySelector<HTMLElement>(
      'span[title], button[title]',
    )
    if (modeBtn === null || tablist.contains(modeBtn)) return

    // Save original parent for restore on dispose / phase switch.
    this.#modeButtonHome = modeBtn.parentElement

    // Move to tablist, right-aligned.
    modeBtn.style.marginLeft = 'auto'
    modeBtn.style.flexShrink = '0'
    modeBtn.style.alignSelf = 'center'
    tablist.appendChild(modeBtn)

    // Hide the now-empty title-row actions cluster.
    if (this.#modeButtonHome !== null) {
      ;(this.#modeButtonHome as HTMLElement).style.display = 'none'
    }
  }

  #restoreModeButton(): void {
    if (this.#modeButtonHome === null) return
    const header = document.querySelector('header')
    const tablist = header?.querySelector('[role="tablist"]')
    const modeBtn = tablist?.querySelector<HTMLElement>(
      'span[title], button[title]',
    )
    if (modeBtn != null && this.#modeButtonHome !== null) {
      modeBtn.style.removeProperty('margin-left')
      modeBtn.style.removeProperty('flex-shrink')
      modeBtn.style.removeProperty('align-self')
      this.#modeButtonHome.appendChild(modeBtn)
      ;(this.#modeButtonHome as HTMLElement).style.removeProperty('display')
    }
    this.#modeButtonHome = null
  }

  /** Model-name marquee: re-measure on the next frame (mutation streams
   *  can fire every frame while tokens stream). */
  readonly #requestMarqueeSync = (): void => {
    if (this.#marqueeFrame !== null) return
    this.#marqueeFrame = requestAnimationFrame(() => {
      this.#marqueeFrame = null
      if (this.#html?.hasAttribute('data-dshm-hidden')) return
      this.#syncMarquee()
    })
  }

  /** Measure the model-name label: when the name overflows its capped
   *  width, wrap a DOUBLE copy of the text in a transform layer
   *  (data-dshm-marquee-runner) and tag the label with data-dshm-marquee
   *  + --dshm-marquee-duration — the CSS slides the runner by -50% (one
   *  text width + one MARQUEE_GAP) on the compositor and loops in ONE
   *  direction: the tail exits, a gap passes, then the head re-enters
   *  (classic spaced ticker; no alternate bounce). When the name fits —
   *  or motion is reduced — the runner is unwrapped (original nodes
   *  restored, clone dropped) and the stock ellipsis render returns. The
   *  label is re-resolved every time (the composer remounts with the
   *  session skeleton), and the ResizeObserver is re-hooked when it
   *  changes so pure layout squeezes (row width, font loads) re-trigger
   *  the measure. */
  readonly #syncMarquee = (): void => {
    const label = document.querySelector<HTMLElement>(MODEL_LABEL_SELECTOR)
    if (label !== this.#marqueeLabel) {
      this.#marqueeRO?.disconnect()
      this.#marqueeLabel = label
      if (label !== null) this.#marqueeRO?.observe(label)
    }
    if (label === null) return
    const runner = label.firstElementChild !== null
        && label.firstElementChild.hasAttribute('data-dshm-marquee-runner')
      ? label.firstElementChild
      : null
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const overflow = label.scrollWidth - label.clientWidth
    if (overflow > 0 && !reduceMotion) {
      if (runner === null) {
        // Two item spans, each holding one copy of the text; the CSS gives
        // every item a trailing gap, so -50% = text + gap exactly and the
        // loop is seamless WITH breathing room between repetitions.
        const nodes = Array.from(label.childNodes)
        const layer = document.createElement('span')
        layer.setAttribute('data-dshm-marquee-runner', '')
        for (const node of nodes) {
          const item = document.createElement('span')
          item.setAttribute('data-dshm-marquee-item', '')
          item.append(node)
          layer.append(item)
        }
        for (const node of nodes) {
          const item = document.createElement('span')
          item.setAttribute('data-dshm-marquee-item', '')
          item.append(node.cloneNode(true))
          layer.append(item)
        }
        label.append(layer)
      }
      label.dataset.dshmMarquee = ''
      // After the wrap, scrollWidth = 2 text widths + 2 gaps; one text
      // width + gap at ~50px/s paces the ticker (~200px names -> 5s).
      const textWidth = (label.scrollWidth - MARQUEE_GAP_PX * 2) / 2
      label.style.setProperty('--dshm-marquee-duration', `${Math.max(5, Math.round((textWidth + MARQUEE_GAP_PX) / 50))}s`)
    } else {
      delete label.dataset.dshmMarquee
      label.style.removeProperty('--dshm-marquee-duration')
      if (runner !== null) {
        // Keep the FIRST item's text (the original nodes), drop the rest.
        const original = runner.firstElementChild?.firstChild ?? null
        runner.remove()
        if (original !== null) label.append(original)
      }
    }
  }

  /** Toggle data-dshm-hidden so CSS can pause animations when tab is backgrounded. */
  readonly #onVisibilityChange = (): void => {
    this.#html?.toggleAttribute('data-dshm-hidden', document.visibilityState !== 'visible')
  }

  /**
   * Attach the foreground-recovery liveness clock to the MESSAGE AREA only.
   * Streaming token deltas, new blocks and status flips all mutate the
   * conversation scroll body; sidebar housekeeping and composer chrome do
   * not. The target is re-resolved whenever the root mutates (session
   * switches rebuild the scroll body), so the clock always watches the
   * visible conversation.
   */
  readonly #ensureConversationActivityObserver = (): void => {
    const target = document.querySelector('[data-conversation-scroll]')
    if (target === null || target === this.#conversationTarget) return
    this.#conversationObserver?.disconnect()
    this.#conversationTarget = target
    this.#conversationObserver = new MutationObserver(() => {
      this.#lastActivityAt = Date.now()
      this.#requestTaskStatusSync()
    })
    this.#lastActivityAt = Date.now()
    this.#conversationObserver.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-state', 'data-tool', 'data-sample'],
    })
    this.#syncTaskStatus()
  }

  /** The first running /compact card in the target, or null. The card title
   *  is the command name ("compact"); the summary ("正在压缩…") carries it
   *  too, so the guard is on textContent — a future rename of the title
   *  still matches the summary. */
  readonly #findRunningCompactingCard = (target: Element): Element | null => {
    const cards = target.querySelectorAll(TASK_COMPACTING_SELECTOR)
    for (const card of cards) {
      if (card.textContent !== null && card.textContent.includes('compact')) {
        return card
      }
    }
    return null
  }

  /** Rewrite the stock summary text of every running /compact card (zh
   *  "正在压缩…" / en "Compacting context…") to the cute label, sharing the
   *  same trailing-dot counter as the turn-status label. Idempotent — the
   *  observer re-syncs on every mutation; React replaces the text itself
   *  when the card settles and re-renders. */
  readonly #rewriteCompactingCards = (target: Element): void => {
    const cards = target.querySelectorAll(TASK_COMPACTING_SELECTOR)
    for (const card of cards) {
      if (card.textContent === null || !card.textContent.includes('compact')) continue
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node !== null) {
        const value = node.nodeValue ?? ''
        // Stock summary (zh/en) OR the controller's own label already
        // applied (so the animated dots keep updating on later syncs).
        const rewritable = TASK_COMPACT_STOCK_PREFIXES.some((prefix) => value.startsWith(prefix))
          || value.startsWith(TASK_LABEL_COMPACTING)
        if (rewritable) {
          node.nodeValue = `${TASK_LABEL_COMPACTING}${'.'.repeat(this.#taskStatusDotCount)}`
        }
        node = walker.nextNode()
      }
    }
  }

  /** The concrete task label for the newest running tool row (or 思考中 while
   *  the model is generating with no tool in flight); a live compaction event
   *  flag outranks everything (压缩中), with the running /compact card in the
   *  DOM as a fallback. */
  readonly #currentTaskLabel = (target: Element): string => {
    if (this.#taskCompacting) return TASK_LABEL_COMPACTING
    if (this.#findRunningCompactingCard(target) !== null) return TASK_LABEL_COMPACTING
    const rows = target.querySelectorAll(TASK_RUNNING_TOOL_SELECTOR)
    const row = rows[rows.length - 1] ?? null
    if (row === null) return TASK_LABEL_THINKING
    if (row.hasAttribute('data-sample')) return TASK_LABEL_EXECUTING
    const tool = row.getAttribute('data-tool') ?? ''
    if (TASK_READ_TOOLS.has(tool)) return TASK_LABEL_READING
    if (TASK_WRITE_TOOLS.has(tool)) return TASK_LABEL_WRITING
    return TASK_LABEL_EXECUTING
  }

  /** Coalesce task-status syncs to one per frame (mutation streams can fire
   *  every frame while tokens stream). Skip when backgrounded — the dots
   *  animation (setInterval) is the only visible output and it already
   *  checks for the status element. */
  readonly #requestTaskStatusSync = (): void => {
    if (this.#taskStatusFrame !== null) return
    this.#taskStatusFrame = requestAnimationFrame(() => {
      this.#taskStatusFrame = null
      if (this.#html?.hasAttribute('data-dshm-hidden')) return
      this.#syncTaskStatus()
    })
  }

  /** The automatic-compaction visual: the stock chat renders nothing while
   *  a compaction runs (no card, no checkpoint), and the turn-status
   *  element may be absent too (a /compact-only or background run) — so
   *  while the probe flag is on and no running /compact card supplies the
   *  DOM, a fixed toast under the composer speaks the cute label with the
   *  shared animated dots. Removed on compaction end (or dispose); a
   *  running /compact card suppresses it (the card is the DOM there). The
   *  pill is self-contained chrome (inline styles) so it works even before
   *  the conversation body exists and is testable without the stylesheet. */
  readonly #syncCompactingIndicator = (): void => {
    const target = this.#conversationTarget
    const cardVisible = target !== null && this.#findRunningCompactingCard(target) !== null
    const show = this.#taskCompacting && !cardVisible
    let pill = this.#compactingIndicator
    if (!show) {
      if (pill !== null) {
        pill.remove()
        this.#compactingIndicator = null
      }
      return
    }
    if (pill === null) {
      pill = document.createElement('div')
      pill.dataset.dshmIndicator = 'compacting'
      pill.setAttribute('aria-live', 'polite')
      pill.append(document.createTextNode(TASK_LABEL_COMPACTING))
      Object.assign(pill.style, {
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)',
        zIndex: '2147483000',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        maxWidth: 'calc(100vw - 32px)',
        padding: '10px 16px',
        borderRadius: '999px',
        background: 'rgba(2, 6, 23, 0.86)',
        color: '#fff',
        fontSize: '13px',
        fontWeight: '600',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.28)',
      })
      document.body.append(pill)
      this.#compactingIndicator = pill
    }
    // The dots keep ticking on the pill even with no turn-status element
    // and no card (the pure automatic-compaction run).
    this.#ensureTaskStatusDots()
    const first = pill.firstChild
    if (first !== null && first.nodeType === Node.TEXT_NODE) {
      const next = `${TASK_LABEL_COMPACTING}${'.'.repeat(this.#taskStatusDotCount)}`
      if (first.nodeValue !== next) first.nodeValue = next
    }
  }

  /** Rewrite the stock "Deep diving..." turn-status label to the actual task
   *  (思考中/读取中/写入中/执行中). React re-renders the element every second
   *  (its elapsed clock) but leaves the constant text child alone, so a
   *  direct nodeValue write survives; the observer re-syncs whenever the
   *  conversation mutates (new tool rows, data-state flips, remounts). The
   *  original text is recorded for dispose(). */
  readonly #syncTaskStatus = (): void => {
    // The compaction pill is independent of the conversation target (the
    // stock chat renders nothing during an automatic compaction), so sync
    // it first — its dots tick even when no target exists at all.
    this.#syncCompactingIndicator()
    const target = this.#conversationTarget
    if (target === null) return
    // A running /compact card carries its own stock "正在压缩…" summary —
    // rewrite it to the cute label (animated with the same dots) so the
    // whole card speaks whale, not just the turn-status label.
    this.#rewriteCompactingCards(target)
    const status = target.querySelector<HTMLElement>(TASK_STATUS_SELECTOR)
    if (status === null) {
      this.#taskStatusElement = null
      this.#taskStatusOriginal = null
      // No turn-status element (a /compact-only run has no live turn): the
      // dots keep animating on the compact card summary instead.
      this.#ensureTaskStatusDots()
      return
    }
    if (status !== this.#taskStatusElement) {
      this.#taskStatusElement = status
      this.#taskStatusDotCount = 0
      const first = status.firstChild
      this.#taskStatusOriginal = first !== null && first.nodeType === Node.TEXT_NODE ? first.nodeValue : null
    }
    this.#ensureTaskStatusDots()
    const first = status.firstChild
    if (first === null || first.nodeType !== Node.TEXT_NODE) return
    const label = `${this.#currentTaskLabel(target)}${'.'.repeat(this.#taskStatusDotCount)}`
    if (first.nodeValue !== label) first.nodeValue = label
  }

  /** Drive the animated trailing dots (0 → 1 → 2 → 3 → 0 → …) after the task
   *  label while the status element stays mounted — or, when there is no
   *  status element (a /compact-only run), while a running /compact card is
   *  in the conversation; the timer stops itself once both are gone. */
  readonly #ensureTaskStatusDots = (): void => {
    if (this.#taskStatusDotTimer !== null) return
    this.#taskStatusDotTimer = window.setInterval(() => {
      // Skip rendering when backgrounded — CSS animations are paused and the
      // DOM work is wasted.
      if (this.#html?.hasAttribute('data-dshm-hidden')) return
      const status = this.#taskStatusElement
      const target = this.#conversationTarget
      const alive = (status !== null && status.isConnected)
        || (target !== null && this.#findRunningCompactingCard(target) !== null)
        || this.#compactingIndicator !== null
      if (!alive) {
        const timer = this.#taskStatusDotTimer
        if (timer !== null) window.clearInterval(timer)
        this.#taskStatusDotTimer = null
        this.#taskStatusDotCount = 0
        return
      }
      this.#taskStatusDotCount = (this.#taskStatusDotCount + 1) % 4
      this.#syncTaskStatus()
    }, TASK_DOTS_STEP_MS)
  }
}
