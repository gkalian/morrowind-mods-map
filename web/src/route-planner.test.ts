import L from 'leaflet'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLang } from './i18n'
import { createRoutePlanner } from './route-planner'
import { location, pluginSet, testMap } from './test-helpers'
import type { TransportMode, TransportNetwork, TransportRoute, TransportStop } from './transport-data'

afterEach(() => {
  setLang('en')
  document.body.replaceChildren()
})

const base = pluginSet('base', { name: 'Morrowind' })
const seydaNeen = location('settlement', 'Seyda Neen', 0.5, 0.5, { set: base })
const balmora = location('settlement', 'Balmora', 20.5, 0.5, { set: base })
const mournhold = { cells: 'mournhold', x: 23.5, y: -27.5, name: 'Mournhold', ru: 'Морнхолд' }
const stops: TransportStop[] = [
  { id: 'a', x: 0.5, y: 0.5, interior: '', modes: new Set(['land']), provider: { name: 'Darvame Hleran' } },
  { id: 'b', x: 20.5, y: 0.5, interior: '', modes: new Set(['land', 'magic']) },
  { id: 'anchor:mournhold', x: 23.5, y: -27.5, interior: 'mournhold', modes: new Set(['magic']), anchor: mournhold, approximate: true },
]
const routes: TransportRoute[] = [
  { from: 'a', to: 'b', mode: 'land', provider: { name: 'Darvame Hleran' }, providerId: 'darvame' },
  { from: 'anchor:mournhold', to: 'b', mode: 'magic', provider: { name: 'Effe-Tei' }, providerId: 'effe', dialogue: true },
]

function open(options: { network?: TransportNetwork; sets?: string[]; modes?: TransportMode[]; width?: number } = {}) {
  // The light browser lays nothing out: the legend gets a box, and every field in it a place inside.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('legend') ? new DOMRect(0, 0, 320, 800) : new DOMRect(10, 100, 200, 30)
  })
  const map = testMap(options.width)
  const network = options.network ?? { stops: new Map(stops.map((stop) => [stop.id, stop])), routes }
  const setRouteFocus = vi.fn()
  const onStartPicking = vi.fn()
  const planner = createRoutePlanner(map, [seydaNeen, balmora], () => network, () => new Set(options.sets ?? ['base']),
    () => new Set(options.modes ?? ['land', 'magic']), setRouteFocus, onStartPicking)
  const legend = document.createElement('div')
  legend.className = 'legend'
  legend.append(planner.element)
  document.body.append(legend)
  ;(planner.element as HTMLDetailsElement).open = true
  const input = (end: 'from' | 'to') => planner.element.querySelector<HTMLInputElement>(`#route-${end}`)!
  const type = (end: 'from' | 'to', text: string) => {
    input(end).value = text
    input(end).dispatchEvent(new Event('input'))
  }
  const choose = (end: 'from' | 'to', text: string) => {
    type(end, text)
    input(end).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  }
  const suggestions = (end: 'from' | 'to') => [...document.querySelectorAll(`#route-${end}-suggestions li`)].map((item) => item.textContent)
  const button = (text: string) => [...planner.element.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
  const find = () => button('Find route').click()
  const steps = () => [...planner.element.querySelectorAll('.route-steps li')].map((item) => [...item.children].map((child) => child.textContent))
  const message = () => planner.element.querySelector('.route-message')?.textContent
  return { map, planner, legend, input, type, choose, suggestions, button, find, steps, message, setRouteFocus, onStartPicking }
}

describe('the route planner', () => {
  it('suggests places and the places without exterior, and takes the first on Enter', () => {
    const { input, type, choose, suggestions } = open()
    type('from', 'seyda')
    expect(suggestions('from')).toEqual(['Seyda NeenSettlement · Morrowind'])
    type('from', 'mournh')
    expect(suggestions('from')).toEqual(['Mournhold (approximate)Approximate map location'])
    choose('from', 'seyda')
    expect([input('from').value, suggestions('from')]).toEqual(['Seyda Neen', []])
  })

  it('finds a route and lists its rides with their carriers', () => {
    const { choose, find, steps, setRouteFocus, planner } = open()
    choose('from', 'seyda')
    choose('to', 'balm')
    find()
    expect(steps()).toEqual([['Land transport: Seyda Neen → Balmora', 'Carrier: Darvame Hleran']])
    expect(planner.element.querySelector('.route-option')!.textContent).toBe('Option 1 · walk ≈ 0.0 cells · rides: 1')
    expect(setRouteFocus).toHaveBeenLastCalledWith(true)
  })

  it('starts at a place without exterior and tells what is known about the ride', () => {
    const { choose, find, steps } = open()
    choose('from', 'mournh')
    choose('to', 'balm')
    find()
    expect(steps()[0]).toEqual([
      'Magical travel: Mournhold (approximate) → Balmora',
      'Carrier: Effe-Tei',
      'Offered in conversation with the carrier.',
      'Mournhold has no exterior map of its own; its position here is approximate.',
    ])
  })

  it('says what is missing when no route can be found', () => {
    expect((() => { const p = open(); p.find(); return p.message() })()).toBe('Choose a starting point and a destination.')
    const same = open()
    same.choose('from', 'seyda')
    same.choose('to', 'seyda')
    same.find()
    expect(same.message()).toBe('Choose two different points.')
    // Places clicked on the Map, of a Plugin Set that is switched off.
    const off = open({ sets: [] })
    off.button('On map').click()
    off.planner.pickLocation(seydaNeen)
    ;[...off.planner.element.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'On map')[1].click()
    off.planner.pickLocation(balmora)
    off.find()
    expect(off.message()).toBe('A selected place belongs to a disabled mod. Enable it or choose another place.')
    const noModes = open({ network: { stops: new Map(), routes: [] }, modes: [] })
    noModes.choose('from', 'seyda')
    noModes.choose('to', 'balm')
    noModes.find()
    expect(noModes.message()).toBe('Enable at least one transport type in the filters.')
  })

  it('picks a point or a place on the map, and cancels picking with Escape', () => {
    const { map, planner, button, input, onStartPicking } = open()
    expect(planner.pickLocation(balmora), 'not picking').toBe(false)
    button('On map').click()
    expect([onStartPicking.mock.calls.length, map.getContainer().classList.contains('route-picking')]).toEqual([1, true])
    expect(document.querySelector('.route-pick-banner')!.textContent).toBe('Click the map to choose your starting point.Cancel')
    map.fire('click', { latlng: L.latLng(5.5, 7.2) })
    expect([input('from').value, document.querySelector('.route-pick-banner')]).toEqual(['Cell 7, 5', null])
    button('On map').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(map.getContainer().classList.contains('route-picking')).toBe(false)
    button('On map').click()
    // A click next to a place without exterior picks that place.
    map.fire('click', { latlng: L.latLng(-27.45, 23.55) })
    expect(input('from').value).toBe('Mournhold (approximate)')
  })

  it('takes a stop or a Location clicked while picking', () => {
    const { planner, button, input } = open()
    button('On map').click()
    expect(planner.pickStop(stops[0])).toBe(true)
    expect(input('from').value).toBe('Seyda Neen')
    expect(planner.pickStop(stops[1]), 'not picking any more').toBe(false)
    const to = [...planner.element.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'On map')[1]
    to.click()
    expect(planner.pickLocation(balmora)).toBe(true)
    expect(input('to').value).toBe('Balmora')
  })

  it('hides the legend while picking on a narrow screen', () => {
    const { legend, button, planner } = open({ width: 400 })
    button('On map').click()
    expect(legend.hidden).toBe(true)
    planner.cancelPicking()
    expect(legend.hidden).toBe(false)
  })

  it('clears everything and recalculates when the filters change', () => {
    const { choose, find, steps, button, input, planner, setRouteFocus } = open()
    choose('from', 'seyda')
    choose('to', 'balm')
    find()
    planner.refresh()
    expect(steps()).toHaveLength(1)
    button('Clear').click()
    expect([input('from').value, input('to').value, steps()]).toEqual(['', '', []])
    expect(setRouteFocus).toHaveBeenLastCalledWith(false)
  })

  it('speaks the new language after a switch', () => {
    const { choose, find, planner, steps } = open()
    choose('from', 'seyda')
    choose('to', 'balm')
    find()
    setLang('ru')
    planner.localize()
    expect(planner.element.querySelector('summary')!.textContent).toBe('Построить маршрут')
    expect(steps()[0][0]).toBe('Наземный транспорт: Seyda Neen → Balmora')
  })

  it('moves through suggestions with the arrow keys', () => {
    const { type, input, suggestions } = open()
    type('from', 'a')
    expect(suggestions('from').length).toBeGreaterThan(1)
    input('from').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    input('from').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    input('from').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    expect(input('from').getAttribute('aria-activedescendant')).toBe('route-from-option-0')
    input('from').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(suggestions('from')).toEqual([])
  })
})
