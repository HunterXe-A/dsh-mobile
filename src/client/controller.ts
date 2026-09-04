/**
 * DOM-side mobile controller: the non-React half of the plugin. Owns the
 * pieces the frame itself cannot express — the viewport meta upgrade, the
 * safe-area/keyboard CSS variables, and the pager's live state (page mirror,
 * 3D flip vars, click-to-return). Everything it installs is removed by
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

/** The narrow breakpoint the pager keys off (PiUI's 768px). */
export const MOBILE_BREAKPOINT = '(max-width: 768px)'

/** The <html> attribute that mirrors the pager page the frame is resting on. */
export const PAGE_ATTR = 'data-dshm-page'

/** Pager page names (the mirror values of PAGE_ATTR). */
export type MobilePage = 'sidebar' | 'chat'

/** Wait after the last scroll event before the pager settles. */
const SCROLL_SETTLE_MS = 200

/**
 * Mobile browsers suspend the page's streaming fetch while the tab is in the
 * background (iOS Safari and Android Chrome both throttle/hold SSE reads).
 * The connection layer only reconnects when the stream actually fails, so a
 * suspended-but-alive stream never recovers by itself: frames emitted while
 * hidden are lost, pending approvals can be settled server-side (cancelled)
 * with the panel still mounted or the panel never replayed, and the UI stays
 * stale after returning. DSH exposes no reconnect hook, so the controller
 * performs a guarded foreground recovery: when a running session shows no
 * DOM activity shortly after returning to the foreground, it reloads the
 * page — a fresh boot replays history and the server replays unanswered
 * pending approvals on mux open (dsh-host-apiproxy mux-open replay).
 */
/** How long after returning to the foreground to wait before judging the stream (lets buffered frames / auto-reconnect settle first). */
const FOREGROUND_CHECK_DELAY_MS = 1800
/** A running session with no DOM activity for this long is judged dead (no streaming frames, no status changes). */
const FOREGROUND_QUIET_MS = 1500
/** sessionStorage key remembering that the current page load already did a recovery reload (stops reload loops). */
const RECOVERY_STAMP_KEY = 'dshm:recovered-load'

/** The sidebar shell's collapse toggle labels (zh / en) — clicking it while
 *  the sidebar is expanded must NOT collapse it to the rail (which would
 *  unload its content); it flips back to the chat page instead. */
const SIDEBAR_COLLAPSE_LABELS = new Set(['收起侧边栏', 'Collapse sidebar'])

/**
 * Viewport meta content: maximum-scale blocks the iOS focus zoom that would
 * otherwise fight the fixed-height mobile layout; viewport-fit=cover exposes
 * the safe-area insets to env(). interactive-widget=resizes-content makes
 * Android-WebView/Chrome shrink the layout viewport when the OS keyboard
 * opens, so the sticky composer seat re-anchors to the keyboard top instead
 * of staying behind it (iOS ignores this property; there the visualViewport
 * math in #updateKeyboardInset handles the lift).
 */
const VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content'

/**
 * The AppFrame keeps at least one of its two data attributes in every state
 * (a closed sidebar renders the rail, a closed details column renders zero
 * width), so the union always selects the frame and never a descendant. The
 * attributes identify the frame wherever it sits in the tree — rc.5 wraps
 * the frame in an extra shell div, so no `#root >` child prefix is assumed.
 */
const FRAME_SELECTOR = 'div[data-sidebar-collapsed], div[data-details-collapsed]'

/** The AppFrame element, or null before the layout entry mounts it. */
function findFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FRAME_SELECTOR)
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
 * the event stream is not connected. The card's OWN stock summary (正在压
 * 缩…) is rewritten to the same cute label, animating with the same trailing
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

/**
 * The pager's chat-page snap position: the rendered width of the sidebar
 * page column (the always-open card). Falls back to the frame's own width
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
  #html: HTMLElement | null = null
  #mql: MediaQueryList | null = null
  #frameObserver: MutationObserver | null = null
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
  #keyboardFrame: number | null = null
  #mountFrame: number | null = null
  #resizeTimer: number | null = null
  #settleTimer: number | null = null
  #foregroundTimer: number | null = null
  #lastActivityAt = 0
  #foregroundReloaded = false
  #conversationObserver: MutationObserver | null = null
  #conversationTarget: Element | null = null
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

  /** Return to the chat page (a session picked in the sidebar). Pure scroll —
   *  the sidebar state is untouched, so its content stays rendered. */
  returnToChat(): void {
    this.#placeOnChat('smooth')
  }

  /** Drive the live compaction flag: the conversationEvents probe calls this
   *  when a compaction lifecycle event lands (compaction/start → true;
   *  compaction/end → false). Ranks above every tool label in the status. */
  setTaskCompacting(active: boolean): void {
    if (this.#disposed || this.#taskCompacting === active) return
    this.#taskCompacting = active
    // Immediate: the pill must exist/ vanish with the flag, not a frame
    // later (the probe is the only authority on automatic compaction).
    this.#syncCompactingIndicator()
    this.#requestTaskStatusSync()
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

    // A tap on the exposed chat card (while the pager rests on the sidebar
    // page) returns to the chat page — PiUI's overlay behavior.
    document.addEventListener('click', this.#onDocClickCapture, true)

    // Foreground recovery: mobile browsers suspend the streaming fetch while
    // the tab is hidden and the connection layer never notices, so returning
    // to the tab can leave the conversation stale and pending approvals lost.
    // Watch visibility and judge stream liveness shortly after returning.
    document.addEventListener('visibilitychange', this.#onVisibilityChange)

    const root = document.getElementById('root')
    if (root !== null) {
      this.#rootObserver = new MutationObserver(() => {
        this.#ensureFrameObserver()
        this.#ensureConversationActivityObserver()
      })
      // subtree: the session view is mounted deep inside #root (the start
      // screen and an opened session swap the conversation scroll body), so
      // a top-level childList watch alone would miss the remount and leave
      // the activity/status observers attached to a detached node.
      this.#rootObserver.observe(root, { childList: true, subtree: true })
      // The composer mounts/unmounts with the session skeleton and the
      // model name swaps in place: re-measure on mutations (rAF-throttled).
      this.#composerObserver = new MutationObserver(() => { this.#requestMarqueeSync() })
      this.#composerObserver.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      this.#requestMarqueeSync()
    }
    // Layout-only overflow changes (row squeeze, font load) do not mutate
    // the tree: watch the label's box too. jsdom has no ResizeObserver, so
    // the guard keeps tests running on the mutation path alone.
    if (typeof ResizeObserver !== 'undefined') {
      this.#marqueeRO = new ResizeObserver(() => { this.#requestMarqueeSync() })
    }
    this.#ensureFrameObserver()
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
    window.visualViewport?.removeEventListener('resize', this.#requestKeyboard)
    window.visualViewport?.removeEventListener('scroll', this.#requestKeyboard)
    document.removeEventListener('click', this.#onDocClickCapture, true)
    document.removeEventListener('visibilitychange', this.#onVisibilityChange)
    for (const timer of [this.#keyboardFrame, this.#mountFrame, this.#resizeTimer, this.#settleTimer, this.#foregroundTimer, this.#marqueeFrame, this.#taskStatusFrame]) {
      if (timer !== null) (timer === this.#keyboardFrame || timer === this.#mountFrame || timer === this.#marqueeFrame || timer === this.#taskStatusFrame ? cancelAnimationFrame : window.clearTimeout)(timer)
    }
    this.#keyboardFrame = null
    this.#mountFrame = null
    this.#resizeTimer = null
    this.#settleTimer = null
    this.#foregroundTimer = null
    this.#marqueeFrame = null
    this.#taskStatusFrame = null
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

  /**
   * Foreground recovery entry: a mobile browser suspends the streaming
   * fetch while hidden, and the connection layer only reconnects when the
   * stream actually fails — a suspended-but-alive stream never resumes on
   * its own. Returning to the tab therefore needs a liveness check: if a
   * session is still running but nothing has mutated the DOM recently, the
   * stream is dead and the only reliable recovery DSH offers is a fresh
   * boot (history backfill + server-side pending-approval replay on mux
   * open). Guard rails keep the reload rare and safe: it never fires while
   * the user is composing, and only once per page load.
   */
  readonly #onVisibilityChange = (): void => {
    // Toggle data-dshm-hidden so CSS can pause animations when tab is backgrounded.
    const hidden = document.visibilityState !== 'visible'
    this.#html?.toggleAttribute('data-dshm-hidden', hidden)
    if (hidden) return
    if (this.#foregroundTimer !== null) return
    this.#foregroundTimer = window.setTimeout(() => {
      this.#foregroundTimer = null
      this.#checkForegroundRecovery()
    }, FOREGROUND_CHECK_DELAY_MS)
  }

  /** The recovery judge — everything must line up or nothing happens.
   *  Two failure modes are repaired:
   *  1. Suspended stream: a running session with no DOM activity for
   *     FOREGROUND_QUIET_MS is judged dead (frames emitted while hidden
   *     were lost and the connection layer never reconnects a suspended
   *     stream). Reload backfills history.
   *  2. Lost approval panel: on reconnect the server replays pending
   *     approvals on mux open, but the client's resync() clears its
   *     pending map AFTER those replay frames arrive — the panel is
   *     rendered (flash) then dropped, and no second replay ever comes.
   *     If history still shows an unanswered approval/asked while no
   *     panel is mounted, the panel was lost: reload replays it.
   */
  readonly #checkForegroundRecovery = (): void => {
    // Phone layout only; the desktop shell has no suspended-stream problem.
    if (!(this.#mql?.matches ?? false)) return
    // One recovery per page load (sessionStorage survives the reload, so
    // the freshly booted page never immediately reloads itself again).
    if (sessionStorage.getItem(RECOVERY_STAMP_KEY) === '1') return
    // Never reload over the user's draft: if the composer holds text or
    // focus, the stream may be fine and we would destroy work.
    if (this.#composerHoldsInput()) return
    void this.#probeAndRecover()
  }

  /** Async recovery probe: pending-approval lookup and the DOM-clock stream
   *  check, then the reload decision. Never throws into the UI (fetch
   *  failures just abort the probe — the stream check below still runs on
   *  the DOM clock). */
  readonly #probeAndRecover = async (): Promise<void> => {
    try {
      const list = await this.#rpc('session.list', {})
      const sessions: Array<{ sessionId?: unknown; running?: boolean }> = list?.items ?? []
      if (sessions.length === 0) return
      // Approval-loss repair: a running session holding an unanswered
      // approval whose panel is NOT mounted lost its panel to the reconnect
      // replay race (mux re-open replays approval/requested, then the
      // client's resync clears its pending map — the panel flashes and
      // drops, and no second replay ever comes). Note a session waiting on
      // approval does NOT show the sidebar ongoing marker, so this check
      // must not depend on the selected row's data-state. The only way back
      // is a fresh boot (mux open replays the pending approval again).
      for (const session of sessions) {
        if (session.running !== true) continue
        const sessionId = typeof session.sessionId === 'string' ? session.sessionId : ''
        if (sessionId === '') continue
        const history = await this.#rpc('session.history', { sessionId, maxMessages: 200 })
        const events: Array<{ event?: { type?: string; data?: { id?: string } } }> = history?.events ?? []
        const decidedIds = new Set(
          events.filter((e) => e.event?.type === 'approval/decided').map((e) => e.event?.data?.id),
        )
        const unanswered = events.some(
          (e) => e.event?.type === 'approval/asked' && !decidedIds.has(e.event?.data?.id),
        )
        if (!unanswered) continue
        if (document.querySelector('[data-approval-key]') === null) {
          this.#recoverReload()
          return
        }
        return // panel is mounted — the approval is live, nothing to repair
      }
      // Suspended-stream repair: the SELECTED sidebar row's activity svg
      // (data-state="ongoing") proves the user is watching a running
      // session. Only the selected row counts: a background running session
      // elsewhere in the tree must never trigger a reload while the user is
      // looking at another session. Silence for FOREGROUND_QUIET_MS while
      // running means the stream is not delivering (token deltas/status
      // flips mutate the DOM constantly while it is).
      const selectedRow = document.querySelector('[role="treeitem"][aria-selected="true"]')
      if (selectedRow === null) return
      if (selectedRow.querySelector('[data-state="ongoing"]') === null) return
      if (Date.now() - this.#lastActivityAt < FOREGROUND_QUIET_MS) return
      this.#recoverReload()
    } catch {
      // Probe failed (network hiccup); no repair attempt this time.
    }
  }

  /** One-shot RPC against the same-origin harness API (probe only). */
  readonly #rpc = async (method: string, payload: Record<string, unknown>): Promise<any> => {
    const res = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `dshm-probe-${Math.random().toString(36).slice(2)}`,
        method,
        payload,
      }),
    })
    const json = (await res.json()) as { result?: { value?: unknown } }
    return json?.result?.value ?? null
  }

  /** The actual recovery: stamp the loop guard and reload. */
  readonly #recoverReload = (): void => {
    try {
      sessionStorage.setItem(RECOVERY_STAMP_KEY, '1')
    } catch {
      // Storage unavailable: still recover once (the in-memory flag below
      // stops the loop for this load).
    }
    this.#foregroundReloaded = true
    location.reload()
  }

  /** True while the user is actually composing (never reload over a draft
   *  or an open keyboard). Mere focus does NOT count — the app auto-focuses
   *  the input on session open, so focus alone would block recovery every
   *  time. Real composition signals: non-empty draft text, or the OS
   *  keyboard visibly occupying the layout (visualViewport compressed on
   *  iOS; layout viewport compressed under interactive-widget=resizes-content
   *  on Android). */
  readonly #composerHoldsInput = (): boolean => {
    const card = document.querySelector('[data-composer-card]')
    if (card === null) return false
    const editable = card.querySelector<HTMLElement | HTMLTextAreaElement>(
      '[contenteditable="true"], textarea',
    )
    if (editable !== null) {
      const text = editable instanceof HTMLTextAreaElement ? editable.value : editable.textContent ?? ''
      if (text.trim() !== '') return true
    }
    // Keyboard detection: a visual viewport at least ~120px shorter than the
    // layout viewport means the OS keyboard is up (iOS); on Android with
    // interactive-widget=resizes-content the LAYOUT viewport itself shrinks
    // by the keyboard inset. Both are far larger than any anti-bounce
    // address-bar jitter.
    const vv = window.visualViewport
    if (vv !== null && vv.height < window.innerHeight - 120) return true
    if (window.innerHeight < (window.screen.availHeight ?? window.innerHeight) - 120) return true
    return false
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

  /** Scroll the pager to the chat page and mirror the resting page. */
  readonly #placeOnChat = (behavior: ScrollBehavior): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = chatPageLeft(frame)
    if (chatLeft <= 0) return
    // Cancel any pending settle that could fight this scroll (e.g. user
    // taps a session while the pager is still mid-swipe: settle would
    // re-snap to the sidebar because the smooth scroll hasn't crossed
    // the midpoint yet).
    if (this.#settleTimer !== null) {
      window.clearTimeout(this.#settleTimer)
      this.#settleTimer = null
    }
    if (Math.abs(frame.scrollLeft - chatLeft) > 2) {
      frame.scrollTo({ left: chatLeft, behavior })
    }
    this.#mirrorPage(frame, 'chat')
    this.#updateFlipVars(frame)
  }

  /** Mirror the page the pager is resting on (scroll position decides). */
  readonly #mirrorPage = (frame: HTMLElement, hint?: MobilePage): void => {
    const html = this.#html
    if (html === null) return
    const chatLeft = chatPageLeft(frame)
    const page: MobilePage = chatLeft <= 0
      ? (hint ?? 'chat')
      : frame.scrollLeft < chatLeft / 2 ? 'sidebar' : 'chat'
    html.setAttribute(PAGE_ATTR, page)
  }

  /** State flips no longer drive the pager (the page is user-driven); an
   *  expand that landed just clears the pending always-open request. */
  readonly #onFrameCollapseChange = (): void => {
    if (!findFrame()?.hasAttribute('data-sidebar-collapsed')) this.#expandPending = false
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
    // Live pager driving (3D flip + settle re-snap) rides the frame's own
    // scroll.
    frame.addEventListener('scroll', this.#onPagerScroll, { passive: true })
    // A frame that appears after mount (the layout entry loads later) still
    // gets the always-open treatment and starts on the chat page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
    this.#ensureConversationActivityObserver()
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

  /** Crossing the breakpoint: entering mobile re-expands the sidebar and
   *  places the pager on the chat page; leaving clears the 3D flip vars so
   *  the desktop layout renders flat. */
  readonly #onBreakpointChange = (): void => {
    const mobile = this.#mql?.matches ?? false
    const frame = findFrame()
    if (!mobile) {
      for (const prop of ['--dshm-rotate', '--dshm-scale', '--dshm-offset-x', '--dshm-origin-x']) {
        frame?.style.removeProperty(prop)
      }
      this.#html?.removeAttribute(PAGE_ATTR)
      this.#html?.removeAttribute('data-dshm-flipping')
      return
    }
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
  }

  /** Width reflow within one breakpoint side: keep the active page put and
   *  re-measure the model-name overflow (the row width drives it). */
  readonly #onWindowResize = (): void => {
    if (this.#resizeTimer !== null) return
    this.#resizeTimer = window.setTimeout(() => {
      this.#resizeTimer = null
      const frame = findFrame()
      const mobile = this.#mql?.matches ?? false
      if (frame === null || !mobile) return
      const chatLeft = chatPageLeft(frame)
      if (chatLeft <= 0) return
      const onChat = frame.scrollLeft >= chatLeft / 2
      frame.scrollTo({ left: onChat ? chatLeft : 0, behavior: 'auto' })
      this.#mirrorPage(frame)
      this.#updateFlipVars(frame)
      this.#requestMarqueeSync()
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
    this.#mirrorPage(frame)
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
    // Gate the card's 3D context behind [data-dshm-flipping]: at rest the
    // card must not pin a preserve-3d layer — some mobile engines clip or
    // fail to paint sticky panels that mount inside it (the approval
    // "等待审批" / question cards in the composer seat), and a pinned 3D
    // layer janks the conversation column's scroll. Only a live flip needs
    // the 3D context for the rotateY/scale to render.
    if (abs > 0.001) this.#html?.setAttribute('data-dshm-flipping', '')
    else this.#html?.removeAttribute('data-dshm-flipping')
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
    this.#mirrorPage(frame)
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
        this.#placeOnChat('smooth')
        return
      }
    }
    // The exposed chat card: return to chat (only while on the sidebar page).
    if (frame.scrollLeft >= chatLeft / 2) return
    const chatCard = frame.children[1]
    if (chatCard instanceof Element && chatCard.contains(target)) {
      this.#placeOnChat('smooth')
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
    // Adaptive inset: pad only the composer seat's ACTUAL deficit below the
    // visual viewport bottom, never the full keyboard height. At the old
    // formula (innerHeight - vv.height - vv.offsetTop) the assumption was
    // "the sticky seat stays at the layout bottom behind the keyboard", and
    // the full-keyboard padding lifted the card up from behind it. Browsers
    // that ALREADY keep the sticky seat above the keyboard (iOS Safari
    // pushes position:fixed/sticky bottom bars up; Android with
    // interactive-widget=resizes-content re-anchors the layout) then got
    // that full-height padding on TOP of the browser's own lift — the card
    // ended up above the keyboard with a blank gap under it. Measuring the
    // seat's real bottom vs. the visual viewport bottom yields ~0 on those
    // platforms (no double lift, no gap) and exactly the keyboard height
    // where the seat is still stuck behind the keyboard.
    let inset = 0
    if (vv !== null && vv.height < window.innerHeight) {
      const seat = document.querySelector('[data-composer-seat]')
      const seatBottom = seat !== null
        ? seat.getBoundingClientRect().bottom + window.scrollY
        : window.innerHeight
      const vvBottom = vv.offsetTop + vv.height
      inset = Math.max(0, seatBottom - vvBottom)
    }
    html.style.setProperty('--dshm-keyboard-inset', `${inset}px`)
  }

  /** Model-name marquee: re-measure on the next frame (mutation streams
   *  can fire every frame while tokens stream). Skip when the tab is
   *  backgrounded — the CSS animation is paused and measuring is wasted. */
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
