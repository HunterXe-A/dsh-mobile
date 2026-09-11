import { describe, expect, it } from 'vitest'
import { calculatePagerFlip, IDLE_FLIP_STATE, samePagerFlip } from '../src/client/pager-flip.ts'

describe('pager flip math', () => {
  it('returns the shared idle state at the chat page and with no layout', () => {
    expect(calculatePagerFlip(300, 300)).toBe(IDLE_FLIP_STATE)
    expect(calculatePagerFlip(0, 0)).toBe(IDLE_FLIP_STATE)
  })

  it('keeps the sidebar-side transform centered horizontally', () => {
    expect(calculatePagerFlip(150, 300)).toEqual({
      active: true,
      transform: 'translate3d(0px, 0, 0) rotateY(-5deg) scale(0.97)',
      origin: '75% 50%',
    })
  })

  it('clamps overscroll before calculating the horizontal retreat', () => {
    expect(calculatePagerFlip(900, 300)).toEqual({
      active: true,
      transform: 'translate3d(-48px, 0, 0) rotateY(10deg) scale(0.94)',
      origin: '0% 50%',
    })
  })

  it('compares only rendered values', () => {
    const state = calculatePagerFlip(150, 300)
    expect(samePagerFlip(null, state)).toBe(false)
    expect(samePagerFlip(state, { ...state })).toBe(true)
    expect(samePagerFlip(state, IDLE_FLIP_STATE)).toBe(false)
  })
})
