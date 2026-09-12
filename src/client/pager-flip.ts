/** Pure pager flip math. DOM synchronization stays in MobileController. */

export interface PagerFlipState {
  /** Whether the card needs the temporary 3D layer. */
  active: boolean
  /** Complete transform for the chat card. `none` means the pager is resting. */
  transform: string
  /** Complete transform origin for the chat card. */
  origin: string
  /** Card chrome interpolated with the sidebar-side progress: the rounded
   *  "distinct card" look follows the gesture continuously instead of popping
   *  at the page-mirror midpoint. Zero/none values keep the card full-bleed. */
  radius: string
  shadow: string
}

/** Full card chrome at the sidebar-page rest (the exposed-sliver look). */
const CARD_RADIUS_PX = 16
const SHADOW_OFFSET_PX = 6
const SHADOW_BLUR_PX = 28
const SHADOW_ALPHA_PCT = 16

/** Chrome quantization steps: border-radius/box-shadow invalidate PAINT
 *  (transform does not), so the chrome is written in 1/4-reveal steps —
 *  at most 4 shadow repaints per swipe, still continuous to the eye. */
const CHROME_STEPS = 4

export const IDLE_FLIP_STATE: PagerFlipState = Object.freeze({
  active: false,
  transform: 'none',
  origin: '50% 50%',
  radius: '0px',
  shadow: 'none',
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
  // Chrome follows the SIDEBAR side only: the exposed-sliver look grows with
  // how far the pager moved toward the sidebar and stays full-bleed on the
  // guarded overscroll side (the chat page pulled past its edge). The reveal
  // is quantized so the paint-heavy chrome only re-renders in steps.
  const reveal = Math.max(0, -progress)
  const stepped = Math.round(reveal * CHROME_STEPS) / CHROME_STEPS
  return {
    active: true,
    transform: `translate3d(${offsetX}px, 0, 0) rotateY(${rotate}deg) scale(${scale})`,
    origin: `${originX}% 50%`,
    radius: `${(CARD_RADIUS_PX * stepped).toFixed(2)}px`,
    shadow: `0 ${(SHADOW_OFFSET_PX * stepped).toFixed(2)}px ${(SHADOW_BLUR_PX * stepped).toFixed(2)}px color-mix(in srgb, var(--dsw-static-neutral-1000) ${(SHADOW_ALPHA_PCT * stepped).toFixed(2)}%, transparent)`,
  }
}

/** Compare only the values that affect the rendered flip. */
export function samePagerFlip(a: PagerFlipState | null, b: PagerFlipState): boolean {
  return a !== null
    && a.active === b.active
    && a.transform === b.transform
    && a.origin === b.origin
    && a.radius === b.radius
    && a.shadow === b.shadow
}
