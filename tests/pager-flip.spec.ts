import { describe, expect, it } from 'vitest'
import { calculatePagerFlip, IDLE_FLIP_STATE, samePagerFlip } from '../src/client/pager-flip.ts'

describe('pager flip math', () => {
  it('returns the shared idle state at the chat page and with no layout', () => {
    expect(calculatePagerFlip(300, 300)).toBe(IDLE_FLIP_STATE)
    expect(calculatePagerFlip(0, 0)).toBe(IDLE_FLIP_STATE)
    expect(IDLE_FLIP_STATE.radius).toBe('0px')
    expect(IDLE_FLIP_STATE.shadow).toBe('none')
  })

  it('keeps the sidebar-side transform centered horizontally', () => {
    expect(calculatePagerFlip(150, 300)).toEqual({
      active: true,
      transform: 'translate3d(0px, 0, 0) rotateY(-5deg) scale(0.97)',
      origin: '75% 50%',
      radius: '8.00px',
      shadow: '0 3.00px 14.00px color-mix(in srgb, var(--dsw-static-neutral-1000) 8.00%, transparent)',
    })
  })

  it('clamps overscroll before calculating the horizontal retreat', () => {
    expect(calculatePagerFlip(900, 300)).toEqual({
      active: true,
      transform: 'translate3d(-48px, 0, 0) rotateY(10deg) scale(0.94)',
      origin: '0% 50%',
      radius: '0.00px',
      shadow: '0 0.00px 0.00px color-mix(in srgb, var(--dsw-static-neutral-1000) 0.00%, transparent)',
    })
  })

  it('grows the card chrome with the sidebar-side progress only', () => {
    const half = calculatePagerFlip(150, 300)
    const full = calculatePagerFlip(0, 300)
    const overscroll = calculatePagerFlip(450, 300)
    expect(parseFloat(full.radius)).toBeGreaterThan(parseFloat(half.radius))
    expect(full.shadow).toContain('16.00%')
    // The guarded overscroll side keeps the chat page full-bleed.
    expect(overscroll.radius).toBe('0.00px')
    expect(overscroll.shadow).toContain('0.00%')
  })

  it('quantizes the chrome to 1/4-reveal steps to limit paint', () => {
    // reveal 0.1 rounds to the 0 step (full-bleed); 0.3 rounds to 1/4 (4px).
    expect(calculatePagerFlip(270, 300).radius).toBe('0.00px')
    expect(calculatePagerFlip(210, 300).radius).toBe('4.00px')
  })

  it('compares only rendered values', () => {
    const state = calculatePagerFlip(150, 300)
    expect(samePagerFlip(null, state)).toBe(false)
    expect(samePagerFlip(state, { ...state })).toBe(true)
    expect(samePagerFlip(state, IDLE_FLIP_STATE)).toBe(false)
    expect(samePagerFlip(state, { ...state, radius: '0.00px' })).toBe(false)
  })
})
