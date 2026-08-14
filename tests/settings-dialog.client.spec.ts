// @vitest-environment jsdom
/**
 * dsh-mobile settings-dialog contract: the mobile sheet must restructure the
 * stock 800px two-column settings modal into a full-screen column with a top
 * horizontal tab strip, keyed only off stable role/data-slot hooks and scoped
 * under [data-dsh-mobile] so desktop and uninstalled runs stay byte-identical.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/client/mobile.css'), 'utf8')

describe('mobile.css settings-dialog contract', () => {
  it('targets the dialog through stable hooks only', () => {
    // The panel is the [role=dialog] element; the nav rail is its <nav>
    // child; the content column is the dialog's last child. No hashed class.
    expect(css).toContain(`[role='dialog']`)
    expect(css).toContain(`[role='dialog'] > nav`)
    expect(css).toContain(`[role='dialog'] > div:last-child`)
    expect(css).toContain(`[role='dialog'] > div:last-child > div:last-child`)
    // The modal layer itself is pinned to the viewport.
    expect(css).toContain(`div[aria-modal='true']`)
  })

  it('restructures the panel into a full-screen column', () => {
    // Panel: column direction, flush width/height, no radius (full screen).
    expect(css).toContain(`flex-direction: column`)
    expect(css).toContain(`width: 100%`)
    expect(css).toContain(`height: 100%`)
    expect(css).toContain(`max-width: 100%`)
    expect(css).toContain(`border-radius: 0`)
  })

  it('turns the nav rail into a top horizontal tab strip', () => {
    // The rail loses its fixed 188px width, the cell list flows horizontally
    // and scrolls, and cells become pill tabs.
    expect(css).toContain(`[role='dialog'] > nav > div:nth-child(2)`)
    expect(css).toContain(`flex-direction: row`)
    expect(css).toContain(`overflow-x: auto`)
    expect(css).toContain(`border-radius: 999px`)
    expect(css).toContain(`width: auto`)
  })

  it('keeps the content column full width and internally scrollable', () => {
    expect(css).toContain(`flex: 1`)
    expect(css).toContain(`min-height: 0`)
    expect(css).toContain(`overflow-y: auto`)
  })

  it('scopes every rule under the mobile attribute', () => {
    // Pull the rule bodies and ensure each starts with a [data-dsh-mobile]
    // scoped selector chain. At-rules (@media/@supports/@keyframes) are
    // skipped — their nested declarations carry their own selectors.
    const bodies = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\n\s*}/)
      .map(part => part.trim())
      .filter(part => part.length > 0)
    for (const body of bodies) {
      const selector = body.split(/\{/)[0]?.trim() ?? ''
      if (selector === '' || /^@(media|supports|keyframes|font-face)/.test(selector)) continue
      expect(selector, `unscoped selector: ${selector}`).toContain(`[data-dsh-mobile]`)
    }
  })
})
