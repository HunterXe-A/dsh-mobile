// @vitest-environment jsdom
/** dsh-mobile registration: controller effect + header menu entry; waits for its owner. */
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'

/** A MediaQueryList stub (jsdom has none) so the controller can mount.
 *  Returns a handle that flips `matches` and fires the change listeners. */
function stubMatchMedia(matches: boolean): { fire: (next: boolean) => void } {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches,
    media: '(max-width: 768px)',
    onchange: null,
    addEventListener: (_t: string, fn: () => void) => { listeners.add(fn) },
    removeEventListener: (_t: string, fn: () => void) => { listeners.delete(fn) },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return {
    fire: (next: boolean): void => {
      ;(mql as unknown as { matches: boolean }).matches = next
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent)
    },
  }
}

interface ListCapture {
  getSnapshot: () => { current: string | undefined; byId: Record<string, unknown> }
  subscribe: (fn: () => void) => () => void
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

async function bench(declare = true, list?: ListCapture, layout?: unknown) {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  ctx.provide('locale', new LocaleService(ctx))
  ctx.provide('layout', layout ?? {
    toggleSidebar: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
  })
  ctx.provide('sessions', {
    list: list ?? {
      getSnapshot: () => ({ current: undefined, byId: {} }),
      subscribe: () => () => {},
    },
  })
  const slots = ctx.get('slots') as SlotsService
  if (declare) {
    slots.register(
      {
        name: 'root',
        children: {
          'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        },
      } as never,
      () => null,
    )
  }
  return { ctx, slots }
}

describe('dsh-mobile apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'sessions'])
  })

  it('mounts the controller and registers the header menu entry once declared', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(document.documentElement.dataset.dshMobile).toBe('')
    const entries = b.slots.entries('conversation.session.header.actions' as never)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options.id).toBe('dsh-mobile-menu')
    expect(entries[0]!.options.order).toBe(-10)
    expect(entries[0]!.locale).toBe('mobile')
    // The drawer trigger flips through the frame's layout action.
    const injected = entries[0]!.inject!() as { toggleSidebar: () => void }
    expect(injected.toggleSidebar).toBeTypeOf('function')
  })

  it('waits for the owner — no registration without a live declaration', async () => {
    const b = await bench(false)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('conversation.session.header.actions' as never)).toHaveLength(0)
    // The controller still mounts (it does not depend on the declaration).
    expect(document.documentElement.dataset.dshMobile).toBe('')
  })

  it('returns to the chat page when the current session changes', async () => {
    const listeners: Array<() => void> = []
    let current: string | undefined = undefined
    const list: ListCapture = {
      getSnapshot: () => ({ current, byId: {} }),
      subscribe: (fn) => { listeners.push(fn); return () => { } },
    }
    // The toggle flips the frame's collapsed attribute like the real AppFrame
    // re-render would, so the pager visibly returns to the chat page.
    let frame: HTMLElement | null = null
    const toggle = vi.fn(() => { frame?.setAttribute('data-sidebar-collapsed', '') })
    const b = await bench(true, list, {
      toggleSidebar: toggle,
      openDetails: vi.fn(),
      closeDetails: vi.fn(),
    })
    const mql = stubMatchMedia(false)
    const root = document.createElement('div')
    root.id = 'root'
    document.body.prepend(root)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Narrow viewport with an expanded frame: the pager sits on the sidebar page.
    mql.fire(true)
    const frameEl = document.createElement('div')
    frame = frameEl
    frameEl.setAttribute('data-sidebar-collapsed', '')
    frameEl.setAttribute('data-details-collapsed', '')
    const sidebar = document.createElement('div')
    Object.defineProperty(sidebar, 'offsetWidth', { configurable: true, value: 300 })
    frameEl.append(sidebar)
    frameEl.scrollTo = ((opts: ScrollToOptions): void => { frameEl.scrollLeft = opts.left ?? 0 }) as never
    root.append(frameEl)
    await new Promise(resolve => setTimeout(resolve, 0)) // root observer attaches
    frameEl.removeAttribute('data-sidebar-collapsed')
    await new Promise(resolve => setTimeout(resolve, 0)) // frame observer delivers
    expect(document.documentElement.getAttribute('data-dshm-page')).toBe('sidebar')
    // The user picks a session from the sidebar: apply flips back to chat.
    current = 's1'
    for (const fn of listeners) fn()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(document.documentElement.getAttribute('data-dshm-page')).toBe('chat')
  })
})
