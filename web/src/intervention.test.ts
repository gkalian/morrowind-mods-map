import L from 'leaflet'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLang } from './i18n'
import { createIntervention } from './intervention'
import { location, manifest, pluginSet, testMap } from './test-helpers'
import type { TransportChanges, TransportData, TransportReference } from './transport-data'

afterEach(() => {
  setLang('en')
  history.replaceState(null, '', '/')
  document.body.replaceChildren()
})

const base = pluginSet('base', { name: 'Morrowind' })
const balmora = location('settlement', 'Balmora', 0.5, 0.5, { set: base })
const marker = (key: string, actor: string, x: number, y: number, place?: string): TransportReference =>
  ({ key, actor, cell: '', position: [x * 8192, y * 8192, 0], deleted: false, destination: null, location: place })
const changes = (interventionReferences?: TransportReference[]) =>
  ({ actors: [], references: [], activators: [], scripts: [], dialogue: [], interventionReferences }) as TransportChanges
const markers = [marker('t1', 'templemarker', 0.4, 0.6, 'Balmora'), marker('d1', 'divinemarker', 5.5, 5.5)]

function open(options: { references?: TransportReference[]; sets?: string[]; url?: string } = {}) {
  history.replaceState(null, '', options.url ?? '/')
  const data: TransportData = { sets: new Map([['base', changes(options.references ?? markers)], ['tr', changes()]]), anchors: [], items: new Map() }
  const map = testMap()
  const onStartPicking = vi.fn()
  const intervention = createIntervention(map, data, manifest([base, pluginSet('tr', { name: 'Tamriel Rebuilt' })]), [balmora], () => new Set(options.sets ?? ['base']), onStartPicking)
  document.body.append(intervention.element)
  const boxes = () => [...intervention.element.querySelectorAll<HTMLInputElement>('.intervention-option input')]
  const toggle = (index: number) => {
    const box = boxes()[index]
    box.checked = !box.checked
    box.dispatchEvent(new Event('change'))
  }
  const button = (text: string) => [...intervention.element.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
  const results = () => [...intervention.element.querySelectorAll('.intervention-results > div')].map((row) => [...row.children].map((child) => child.textContent))
  const drawn = () => {
    let count = 0
    map.eachLayer((layer) => { if (layer instanceof L.CircleMarker) count++ })
    return count
  }
  const notes = () => [...intervention.element.querySelectorAll('.intervention-note')].map((note) => note.textContent)
  return { map, intervention, boxes, toggle, button, results, drawn, notes, onStartPicking }
}

describe('the intervention block', () => {
  it('draws the kinds of marker that are switched on and keeps the choice in the address', () => {
    const { boxes, toggle, drawn } = open()
    expect([boxes().map((box) => box.checked), drawn()]).toEqual([[false, false], 0])
    toggle(0)
    expect([drawn(), window.location.search]).toEqual([1, '?intervention=temple'])
    toggle(1)
    expect(drawn()).toBe(2)
    toggle(0)
    toggle(1)
    expect(window.location.search, 'nothing left to keep').toBe('')
  })

  it('starts with the kinds the address names', () => {
    const { boxes } = open({ url: '/?intervention=divine,bogus' })
    expect(boxes().map((box) => box.checked)).toEqual([false, true])
  })

  it('tells where each intervention takes the player from a chosen place', () => {
    const { intervention, results, toggle, drawn } = open()
    toggle(0)
    intervention.select(balmora)
    expect(intervention.element.querySelector('.intervention-origin')!.textContent).toBe('From: Balmora')
    expect(results()).toEqual([['Almsivi Intervention', 'Balmora'], ['Divine Intervention', 'Cell 5, 5']])
    // The marker, the point chosen and the line to its destination.
    expect(drawn()).toBe(3)
  })

  it('says when no marker is reachable or several share the destination', () => {
    const { intervention, results } = open({ references: [marker('t1', 'templemarker', 0.2, 0.5), marker('t2', 'templemarker', 0.7, 0.5)] })
    intervention.select(balmora)
    expect(results()).toEqual([
      ['Almsivi Intervention', 'Balmora', 'Several markers share the destination cell; the exact point depends on the game.'],
      ['Divine Intervention', 'No destination in the enabled modules'],
    ])
  })

  it('picks a point on the map, switching every kind on if none was', () => {
    const { map, intervention, button, boxes, onStartPicking } = open()
    expect(intervention.pickPoint({ x: 1, y: 1 }), 'not picking').toBe(false)
    button('Choose on map').click()
    expect([onStartPicking.mock.calls.length, boxes().map((box) => box.checked), window.location.search]).toEqual([1, [true, true], '?intervention=temple%2Cdivine'])
    expect(document.querySelector('.route-pick-banner')!.textContent).toBe('Select a point or location on the mapCancel')
    map.fire('click', { latlng: L.latLng(3.5, 2.5) })
    expect([intervention.element.querySelector('.intervention-origin')!.textContent, document.querySelector('.route-pick-banner')]).toEqual(['From: Cell 2, 3', null])
    button('Choose on map').click()
    expect(intervention.pickLocation(balmora)).toBe(true)
    button('Choose on map').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(map.getContainer().classList.contains('route-picking')).toBe(false)
    button('Clear').click()
    expect(intervention.element.querySelector('.intervention-origin')).toBeNull()
  })

  it('tells which enabled sets have no intervention data', () => {
    const { notes } = open({ references: [], sets: ['base', 'tr'] })
    expect(notes()).toEqual([
      'Intervention data is unavailable. Regenerate the transport data.',
      'Calculated for the selected exterior cell. Interiors, teleport restrictions and other active plugins can change the result.',
      'Intervention data is missing for: Tamriel Rebuilt. The result may differ.',
    ])
  })

  it('follows the enabled sets and the language', () => {
    const { intervention, toggle, drawn, button } = open()
    toggle(0)
    intervention.update()
    expect(drawn()).toBe(1)
    button('Choose on map').click()
    setLang('ru')
    intervention.localize()
    expect([intervention.element.querySelector('summary')!.firstChild!.textContent, document.querySelector('.route-pick-banner')]).toEqual(['Вмешательства', null])
  })
})
