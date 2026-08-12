/**
 * Session-header menu button: opens the mobile sidebar drawer. A
 * `conversation.session.header.actions` list entry (order -10 — the leading
 * static-context band), shown only on narrow screens by the global sheet
 * ([data-dshm-menu] is display:none from 769px up). The hero phase has no
 * session header; the controller's fixed FAB covers that screen instead.
 */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { MENU_ICON } from './controller.ts'

/** Injected share: the frame-owned sidebar toggle. */
export interface MobileMenuInjected {
  toggleSidebar: () => void
}

/**
 * Full props: the injected toggle plus the locale seat. The runtime share of
 * the 'conversation.session.header.actions' seat is deliberately not re-typed
 * here — ui-conversation's SlotMap merge stays out of this package's program
 * (one-way dependency), and the registration is erased (`as never`) anyway.
 */
export type MobileMenuButtonProps = InjectFace<MobileMenuInjected> & PropsLocale<'mobile'>

/** The phone-only sidebar drawer trigger. */
export function MobileMenuButton({ toggleSidebar, t }: MobileMenuButtonProps) {
  return (
    <button
      type="button"
      data-dshm-menu
      aria-label={t('menu.open')}
      title={t('menu.open')}
      onClick={toggleSidebar}
      dangerouslySetInnerHTML={{ __html: MENU_ICON }}
    />
  )
}
