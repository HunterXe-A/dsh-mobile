/**
 * Browser half of the dsh-mobile plugin: mounts the DOM-side mobile
 * controller (viewport meta, safe-area/keyboard insets, drawer mirror,
 * backdrop + hero FAB) and contributes the phone-only sidebar menu button to
 * the session header's actions row. The global mobile sheet (mobile.css) is
 * injected with this bundle as a <style data-plugin> tag and removed on
 * unload — the stock GUI stays byte-identical without the plugin row.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the layout plugin's Context merge (ctx.layout) and the
// sessions service surface into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { MobileController } from './controller.ts'
import { MobileMenuButton } from './MobileMenuButton.tsx'
import type { MobileMenuInjected } from './MobileMenuButton.tsx'
import { en, zh, type MobileKey } from './locales.ts'
// Plugin-owned global mobile sheet (injected as a <style data-plugin> tag).
import './mobile.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Mobile chrome copy. */
    mobile: MobileKey
  }
}

/** Dictionary namespace owned by this plugin (mobile chrome copy). */
const NS = 'mobile'

/** Services required by the mobile plugin. */
export const inject = ['slots', 'layout', 'sessions']

/**
 * Install the mobile surfaces: the DOM controller (one effect) and the
 * header menu button (waits on the ui-conversation declaration via
 * slots.inject — absent this plugin the header keeps its stock actions).
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // DOM controller: viewport meta, safe-area/keyboard insets, drawer mirror,
  // backdrop + hero FAB. A current-session change (a session picked from the
  // drawer, or a new session started) closes the drawer so the chat is
  // immediately readable — list updates that do not move `current` (running
  // flags, titles) leave it alone.
  ctx.effect(() => {
    const controller = new MobileController({
      toggleSidebar: () => ctx.layout.toggleSidebar(),
    })
    controller.mount()
    let lastCurrent = ctx.sessions.list.getSnapshot().current
    const off = ctx.sessions.list.subscribe(() => {
      const next = ctx.sessions.list.getSnapshot().current
      if (next === lastCurrent) return
      lastCurrent = next
      controller.closeDrawer()
    })
    return () => {
      off()
      controller.dispose()
    }
  }, 'dsh-mobile: DOM controller')

  // The phone-only drawer trigger, in the header's leading static band.
  ctx.effect(
    () => ctx.slots.inject('conversation.session.header.actions' as never, () => ctx.slots.register(
      // The target slot is declared by ui-conversation, whose types this
      // package must not import (one-way dependency). The erased call keeps
      // the registration correct at runtime — the loader resolves the real
      // spec.
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-mobile-menu',
        order: -10,
        locale: NS,
        inject: (): MobileMenuInjected => ({ toggleSidebar: () => ctx.layout.toggleSidebar() }),
      } as never,
      MobileMenuButton as never,
    )),
    'dsh-mobile: header menu button',
  )
}
