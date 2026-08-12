// @vitest-environment jsdom
/** dsh-mobile registration: mounts the controller and expands the sidebar on mobile. */
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'

/** A MediaQueryList stub (jsdom has none) so the controller can mount. */
function stubMatchMedia(matches: boolean): void {
  const mql = {
    matches,
    media: '(max-width: 768px)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
}

beforeEach(() => {
  stubMatchMedia(false)
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.unstubAllGlobals()
})

async function bench(layout?: unknown) {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  ctx.provide('locale', new LocaleService(ctx))
  ctx.provide('layout', layout ?? {
    toggleSidebar: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
  })
  return { ctx }
}

describe('dsh-mobile apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['layout'])
  })

  it('mounts the controller and tags <html>', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(document.documentElement.dataset.dshMobile).toBe('')
    expect(document.querySelector('[data-dshm-fab-menu]')).not.toBeNull()
  })

  it('expands the collapsed sidebar when mobile', async () => {
    const toggle = vi.fn()
    const b = await bench({ toggleSidebar: toggle, openDetails: vi.fn(), closeDetails: vi.fn() })
    stubMatchMedia(true)
    const root = document.createElement('div')
    root.id = 'root'
    const frame = document.createElement('div')
    frame.setAttribute('data-sidebar-collapsed', '')
    frame.setAttribute('data-details-collapsed', '')
    root.append(frame)
    document.body.prepend(root)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})
