/**
 * Browser half of the dsh-mobile plugin: mounts the DOM-side mobile
 * controller (viewport meta, safe-area/keyboard insets, pager page mirror)
 * and returns to the chat page when the current session changes (a session
 * picked in the sidebar). The global mobile sheet (mobile.css) is injected
 * with this bundle as a <style data-plugin> tag and removed on unload — the
 * stock GUI stays byte-identical without the plugin row.
 *
 * Mobile layout follows PiUI's chat pager: the stock three-column frame
 * becomes a horizontal scroll-snap pager (sidebar | chat), the chat column
 * renders completely untouched, and the pager starts on the chat page —
 * swiping reveals the always-open sidebar.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationMatch, ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the layout plugin's Context merge (ctx.layout), the
// sessions service, and the conversation event registry into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { MobileController } from './controller.ts'
// Plugin-owned global mobile sheet (injected as a <style data-plugin> tag).
import './mobile.css'

/** Services required by the mobile plugin. */
export const inject = ['layout', 'sessions', 'uiConversation']

/**
 * Probe the live compaction lifecycle (automatic AND /compact) off the
 * conversation event stream. The stock chat renders nothing while a
 * compaction runs — the checkpoints land only at the end — so without this
 * probe the turn-status label would sit stale or vanish for the whole
 * automatic-compaction window. State-only Definition: no view target, no
 * location data, nothing rendered; it just flips the controller's
 * compaction flag (compaction/start → true, compaction/end → false).
 * `compaction/summary` keeps the flag up (it precedes the end event).
 * @param controller - DOM controller driving the status label.
 * @returns the registration disposer for the effect teardown.
 */
function registerCompactionProbe(ctx: Context, controller: MobileController): () => void {
  return ctx.uiConversation.events.register({
    kind: 'dshm-task-compaction',
    match: (event: SessionEventLike): { id: string, role: 'start' | 'update' } | null => {
      const type = event.type
      if (type !== 'compaction/start' && type !== 'compaction/end' && type !== 'compaction/summary') return null
      const data = event.data as { compactionId?: unknown }
      const id = typeof data.compactionId === 'string' ? data.compactionId : ''
      if (id === '') return null
      return { id, role: type === 'compaction/start' ? 'start' : 'update' }
    },
    start: (): Record<string, never> => {
      controller.setTaskCompacting(true)
      return {}
    },
    update: (context: ConversationNodeContext<Record<string, never>>, match: ConversationMatch) => {
      controller.setTaskCompacting(match.event.type !== 'compaction/end')
      return context.state
    },
  } satisfies ConversationNodeDefinition)
}

/**
 * Install the mobile surfaces: the DOM controller (one effect). A
 * current-session change (a session picked from the sidebar page, or a new
 * session started) returns the pager to the chat page — list updates that
 * do not move `current` (running flags, titles) leave it alone.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const controller = new MobileController({
      toggleSidebar: () => ctx.layout.toggleSidebar(),
    })
    controller.mount()
    const offProbe = registerCompactionProbe(ctx, controller)
    let lastCurrent = ctx.sessions.list.getSnapshot().current
    const off = ctx.sessions.list.subscribe(() => {
      const next = ctx.sessions.list.getSnapshot().current
      if (next === lastCurrent) return
      lastCurrent = next
      controller.returnToChat()
    })
    return () => {
      off()
      offProbe()
      controller.dispose()
    }
  }, 'dsh-mobile: DOM controller')
}