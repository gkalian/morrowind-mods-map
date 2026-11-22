import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLegend, type Shown } from './legend'
import { location, pluginSet } from './test-helpers'
import type { TransportData } from './transport-data'

afterEach(() => document.body.replaceChildren())

const morrowind = pluginSet('morrowind', { name: 'Morrowind', locked: true })
const tr = pluginSet('tr', { name: 'Tamriel Rebuilt', version: '26.09.27' })
const places = [
  location('settlement', 'Pelagiad', 0, 0, { set: morrowind }),
  location('settlement', 'Balmora', 0, 0, { set: morrowind }),
  location('entrance', 'Balmora, Temple', 0, 0, { set: morrowind }),
  location('settlement', 'Old Ebonheart', 0, 0, { set: tr }),
]

function open(extra: { transport?: TransportData | null; failed?: boolean; intervention?: HTMLElement } = {}) {
  const shown: Shown = { sets: new Set(['morrowind']), kinds: { settlement: true, entrance: false, region: true }, regionColours: false, cellGrid: false, transport: new Set() }
  const onChange = vi.fn()
  const onPick = vi.fn()
  const legend = createLegend([morrowind, tr], places, shown, onChange, onPick, extra.transport ?? null, extra.failed ?? false, undefined, extra.intervention)
  document.body.append(legend.element)
  return { legend, shown, onChange, onPick, element: legend.element }
}
const change = (input: HTMLInputElement) => {
  input.checked = !input.checked
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('the legend', () => {
  it('lists the Plugin Sets, with the Base Set always on', () => {
    const { element } = open()
    const toggles = [...element.querySelectorAll<HTMLInputElement>('.legend-set > input')]
    expect(toggles.map((toggle) => [toggle.checked, toggle.disabled, toggle.title])).toEqual([
      [true, true, 'Morrowind is always shown'],
      [false, false, 'Show Tamriel Rebuilt'],
    ])
    expect(element.querySelectorAll('.legend-set > details > summary')[1].textContent).toBe('Tamriel Rebuilt 26.09.27')
  })

  it('switches a Plugin Set on and off', () => {
    const { element, shown, onChange } = open()
    const toggle = element.querySelectorAll<HTMLInputElement>('.legend-set > input')[1]
    change(toggle)
    expect(shown.sets.has('tr')).toBe(true)
    change(toggle)
    expect(shown.sets.has('tr')).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('fills a list of Locations, sorted, the first time it is opened, and picks from it', () => {
    const { element, onPick } = open()
    const lists = element.querySelectorAll<HTMLDetailsElement>('.legend-set details details')
    expect([...lists].map((list) => list.querySelector('summary')!.textContent)).toEqual(['Settlements (2)', 'Interior Entrances (1)', 'Settlements (1)'])
    lists[0].open = true
    lists[0].dispatchEvent(new Event('toggle'))
    lists[0].dispatchEvent(new Event('toggle'))
    expect([...lists[0].querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Balmora', 'Pelagiad'])
    lists[0].querySelector('button')!.click()
    expect(onPick).toHaveBeenCalledWith(places[1])
  })

  it('switches what is drawn and syncs with changes from outside', () => {
    const { legend, element, shown, onChange } = open()
    const options = [...element.querySelectorAll<HTMLInputElement>('.legend-show input')]
    expect(options.map((input) => input.checked)).toEqual([true, false, true, false, false])
    change(options[4])
    expect([shown.cellGrid, onChange.mock.calls.length]).toEqual([true, 1])
    shown.regionColours = true
    shown.sets.add('tr')
    legend.sync()
    expect([options[3].checked, element.querySelectorAll<HTMLInputElement>('.legend-set > input')[1].checked]).toEqual([true, true])
  })

  it('adds the transport filters, the intervention block and a notice when transport failed', () => {
    const intervention = document.createElement('details')
    intervention.className = 'intervention-options'
    const { element } = open({ transport: { sets: new Map(), anchors: [], items: new Map() }, failed: true, intervention })
    expect([element.querySelector('.transport-options') !== null, element.querySelector('.intervention-options') === intervention]).toEqual([true, true])
    expect(element.querySelector('.transport-notice')!.textContent).toBe('Transport data could not be loaded. Retry')
    expect(open().element.querySelector('.transport-options, .transport-notice')).toBeNull()
  })
})
