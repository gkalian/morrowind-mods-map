import { afterEach, describe, expect, it } from 'vitest'
import { closeLegendInfoWithin, createLegendInfo } from './legend-info'
import { pluginSet } from './test-helpers'
import type { TransportChanges, TransportData } from './transport-data'

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  document.body.replaceChildren()
})

const empty: TransportChanges = { actors: [], references: [], activators: [], scripts: [], dialogue: [], interventionReferences: [] }
const sets = [pluginSet('morrowind', { name: 'Morrowind' }), pluginSet('tr', { name: 'Tamriel Rebuilt' }), pluginSet('tamriel', { backdropFor: ['tr'] })]
const data: TransportData = { sets: new Map([['morrowind', empty]]), anchors: [], items: new Map() }

function open(kind: 'transport' | 'intervention' = 'transport', transport = data) {
  const legend = document.createElement('div')
  legend.className = 'legend'
  const button = createLegendInfo(kind, sets, transport)
  // The light browser lays nothing out: the button stands inside the legend's box by hand.
  legend.getBoundingClientRect = () => new DOMRect(0, 0, 300, 500)
  button.getBoundingClientRect = () => new DOMRect(10, 100, 26, 26)
  legend.append(button)
  document.body.append(legend)
  return { legend, button, tooltip: () => document.querySelector('.legend-info-tooltip') }
}

describe('the data information button', () => {
  it('lists the Plugin Sets without data on click, and closes on a second click', () => {
    const { button, tooltip } = open()
    button.click()
    expect(tooltip()!.textContent).toBe('Transport data is unavailable for:Tamriel Rebuilt')
    expect([button.getAttribute('aria-expanded'), button.getAttribute('aria-describedby')]).toEqual(['true', 'legend-info-tooltip'])
    button.click()
    expect([tooltip(), button.getAttribute('aria-expanded')]).toEqual([null, 'false'])
  })

  it('says when every set has its data', () => {
    const { button, tooltip } = open('intervention', { ...data, sets: new Map([['morrowind', empty], ['tr', empty]]) })
    button.click()
    expect(tooltip()!.textContent).toBe('Data is available for all map modules.')
  })

  it('shows on hover with a mouse and hides when the pointer leaves', () => {
    const { button, tooltip } = open()
    button.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' }))
    expect(tooltip()).toBeNull()
    button.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))
    expect(tooltip()).not.toBeNull()
    button.dispatchEvent(new PointerEvent('pointerleave'))
    expect(tooltip()).toBeNull()
  })

  it('closes on Escape, on a click elsewhere and with the block it is in', () => {
    const { legend, button, tooltip } = open()
    button.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(tooltip()).toBeNull()
    button.click()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(tooltip()).toBeNull()
    button.click()
    closeLegendInfoWithin(document.createElement('div'))
    expect(tooltip()).not.toBeNull()
    closeLegendInfoWithin(legend)
    expect(tooltip()).toBeNull()
  })

  it('closes when the legend is hidden or scrolled away', () => {
    const { legend, button, tooltip } = open()
    button.click()
    legend.hidden = true
    window.dispatchEvent(new Event('resize'))
    expect(tooltip()).toBeNull()
  })
})
