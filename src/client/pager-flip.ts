/** Pure pager slide math. DOM synchronization stays in MobileController. */

export interface PagerFlipState {
  /** Whether the pager is off its rest page (drives the warm layer + chrome). */
  active: boolean
  /** Card transform. Always `none`: pan mode slides the pager natively and
   *  never transforms the card. */
  transform: string
  /** Transform origin. Constant: nothing rotates, so nothing pivots. */
  origin: string
  /** Card corner radius. Always zero: rounded corners were removed to cut
   *  paint cost (see below). */
  radius: string
  /** Card shadow. Always `none`: the shadow lives on the veil layer (a
   *  frame pseudo-element with a fixed shadow whose opacity follows the
   *  gesture), so the card itself never repaints for chrome. */
  shadow: string
  /** Shadow-veil opacity, stepped with the sidebar-side progress: 0 at the
   *  chat rest, 1 at the sidebar rest. Written as an inherited custom
   *  property (pseudo-elements take no inline styles). */
  veil: number
}

/* The veil's static box-shadow in mobile.css is the full-strength look
 *  (0 6px 28px at 16%); `veil` below only fades that fixed raster in. */

/** Veil-opacity quantization steps: the fallback writes the inherited custom
 *  property in 1/8-reveal steps (cheap recalc, composited opacity — no
 *  repaint). Eight steps read as a smooth fade-in (the first shadow lands
 *  at 1/16 of the swipe at 1/8 strength); four left a visible pop after a
 *  fixed distance. The veil rule consumes these steps through the inherited
 *  custom property. */
const VEIL_STEPS = 8

export const IDLE_FLIP_STATE: PagerFlipState = Object.freeze({
  active: false,
  transform: 'none',
  origin: '50% 50%',
  radius: '0px',
  shadow: 'none',
  veil: 0,
})

/**
 * Convert the pager position into one complete visual state.
 *
 * `scrollLeft === chatLeft` is the chat-page rest position. Negative progress
 * exposes the sidebar; positive progress is the guarded overscroll side that
 * stays full-bleed.
 */
export function calculatePagerFlip(scrollLeft: number, chatLeft: number): PagerFlipState {
  if (chatLeft <= 0) return IDLE_FLIP_STATE

  const progress = Math.max(-1, Math.min(1, (scrollLeft - chatLeft) / chatLeft))
  if (progress === 0) return IDLE_FLIP_STATE

  // Pan mode: the pager slides natively — no offset, rotation, or scale on
  // the card, no radius, no card shadow. Only the veil opacity follows the
  // SIDEBAR side: 0 at the chat rest, full at the sidebar rest, full-bleed
  // (0) on the guarded overscroll side (the chat page pulled past its edge).
  // The reveal is quantized so the fallback writes the inherited custom
  // property in steps.
  const reveal = Math.max(0, -progress)
  const stepped = Math.round(reveal * VEIL_STEPS) / VEIL_STEPS
  return {
    active: true,
    transform: 'none',
    origin: '50% 50%',
    radius: '0px',
    shadow: 'none',
    veil: stepped,
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
    && a.veil === b.veil
}
