/** Pure pager flip math. DOM synchronization stays in MobileController. */

export interface PagerFlipState {
  /** Whether the card needs the temporary 3D layer. */
  active: boolean
  /** Complete transform for the chat card. `none` means the pager is resting. */
  transform: string
  /** Complete transform origin for the chat card. */
  origin: string
}

export const IDLE_FLIP_STATE: PagerFlipState = Object.freeze({
  active: false,
  transform: 'none',
  origin: '50% 50%',
})

/**
 * Convert the pager position into one complete visual state.
 *
 * `scrollLeft === chatLeft` is the chat-page rest position. Negative progress
 * exposes the sidebar; positive progress is the guarded overscroll side that
 * receives the horizontal offset.
 */
export function calculatePagerFlip(scrollLeft: number, chatLeft: number): PagerFlipState {
  if (chatLeft <= 0) return IDLE_FLIP_STATE

  const progress = Math.max(-1, Math.min(1, (scrollLeft - chatLeft) / chatLeft))
  if (progress === 0) return IDLE_FLIP_STATE

  const absolute = Math.abs(progress)
  const offsetX = Math.max(0, progress) ** 2 * -48
  const rotate = progress * 10
  const scale = 1 - absolute * 0.06
  const originX = 50 - progress * 50
  return {
    active: true,
    transform: `translate3d(${offsetX}px, 0, 0) rotateY(${rotate}deg) scale(${scale})`,
    origin: `${originX}% 50%`,
  }
}

/** Compare only the values that affect the rendered flip. */
export function samePagerFlip(a: PagerFlipState | null, b: PagerFlipState): boolean {
  return a !== null
    && a.active === b.active
    && a.transform === b.transform
    && a.origin === b.origin
}
