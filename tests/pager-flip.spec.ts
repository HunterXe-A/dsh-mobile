import { describe, expect, it } from 'vitest'
import { calculatePagerFlip, IDLE_FLIP_STATE, samePagerFlip } from '../src/client/pager-flip.ts'

describe('pager flip math', () => {
  it('returns the shared idle state at the chat page and with no layout', () => {
    expect(calculatePagerFlip(300, 300)).toBe(IDLE_FLIP_STATE)
    expect(calculatePagerFlip(0, 0)).toBe(IDLE_FLIP_STATE)
    expect(IDLE_FLIP_STATE.radius).toBe('0px')
    expect(IDLE_FLIP_STATE.shadow).toBe('none')
    expect(IDLE_FLIP_STATE.veil).toBe(0)
  })

  it('leaves the card untransformed and square in pan mode', () => {
    expect(calculatePagerFlip(150, 300)).toEqual({
      active: true,
      transform: 'none',
      origin: '50% 50%',
      radius: '0px',
      shadow: 'none',
      veil: 0.5,
    })
  })

  it('clamps overscroll and keeps the chat page full-bleed', () => {
    expect(calculatePagerFlip(900, 300)).toEqual({
      active: true,
      transform: 'none',
      origin: '50% 50%',
      radius: '0px',
      shadow: 'none',
      veil: 0,
    })
  })

  it('grows the veil opacity with the sidebar-side progress only', () => {
    const half = calculatePagerFlip(150, 300)
    const full = calculatePagerFlip(0, 300)
    const overscroll = calculatePagerFlip(450, 300)
    // The card itself stays square and shadowless; only the veil fades in.
    expect(half.radius).toBe('0px')
    expect(half.shadow).toBe('none')
    expect(half.veil).toBe(0.5)
    expect(full.veil).toBe(1)
    // The guarded overscroll side keeps the chat page full-bleed.
    expect(overscroll.radius).toBe('0px')
    expect(overscroll.shadow).toBe('none')
    expect(overscroll.veil).toBe(0)
  })

  it('quantizes the veil opacity to 1/8-reveal steps', () => {
    // reveal 0.05 rounds to the 0 step; 0.1 rounds to 1/8; 0.3 rounds to 1/4.
    expect(calculatePagerFlip(285, 300).veil).toBe(0)
    expect(calculatePagerFlip(270, 300).veil).toBe(0.125)
    expect(calculatePagerFlip(210, 300).veil).toBe(0.25)
  })

  it('compares only rendered values', () => {
    const state = calculatePagerFlip(150, 300)
    expect(samePagerFlip(null, state)).toBe(false)
    expect(samePagerFlip(state, { ...state })).toBe(true)
    expect(samePagerFlip(state, IDLE_FLIP_STATE)).toBe(false)
    expect(samePagerFlip(state, { ...state, radius: '1px' })).toBe(false)
  })
})
