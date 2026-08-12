/**
 * Browser half of the dsh-mobile plugin: mounts the DOM-side mobile
 * controller (viewport meta, safe-area/keyboard insets, sidebar-button
 * chrome) and expands the docked sidebar once below the breakpoint. The
 * global mobile sheet (mobile.css) is injected with this bundle as a
 * <style data-plugin> tag and removed on unload — the stock GUI stays
 * byte-identical without the plugin row.
 *
 * Mobile layout is the desktop layout resized and carded: the stock frame
 * keeps its docked sidebar open as a half-open card beside the chat card —
 * no paging, no drawer, no slot changes.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the layout plugin's Context merge (ctx.layout) into this
// compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { MobileController } from './controller.ts'
// Plugin-owned global mobile sheet (injected as a <style data-plugin> tag).
import './mobile.css'

/** Services required by the mobile plugin. */
export const inject = ['layout']

/**
 * Install the mobile surfaces: the DOM controller (one effect).
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const controller = new MobileController({
      toggleSidebar: () => ctx.layout.toggleSidebar(),
    })
    controller.mount()
    return () => { controller.dispose() }
  }, 'dsh-mobile: DOM controller')
}
