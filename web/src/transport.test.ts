import L from 'leaflet'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLang } from './i18n'
import { location, manifest, pluginSet, testMap } from './test-helpers'
import { anchorName, createTransportControls, createTransportLayer, transportName, transportNotes, TRANSPORT_MODES } from './transport'
import type { Actor, Destination, TransportData, TransportMode, TransportReference, TransportRoute, TransportStop } from './transport-data'

afterEach(() => setLang('en'))

const route = (extra: Partial<TransportRoute> = {}): TransportRoute => ({ from: 'a', to: 'b', mode: 'magic', providerId: 'carrier', ...extra })
const stop = (id: string, extra: Partial<TransportStop> = {}): TransportStop => ({ id, x: 0, y: 0, interior: '', modes: new Set(), ...extra })
const mournhold = { cells: 'mournhold', x: 23.5, y: -27.5, name: 'Mournhold', ru: 'Морнхолд' }

describe('names and notes', () => {
  it('names the modes and the stops of places without exterior in the current language', () => {
    expect(transportName('propylon')).toBe('Propylons')
    expect(anchorName(stop('m', { anchor: mournhold }))).toBe('Mournhold (approximate)')
    expect(anchorName(stop('plain'))).toBeNull()
    setLang('ru')
    expect([transportName('propylon'), transportName('guild')]).toEqual(['Пропильоны', 'Проводники Гильдии Магов'])
    expect(anchorName(stop('m', { anchor: mournhold }))).toBe('Морнхолд (примерно)')
  })

  it('has no notes for a plain route', () => {
    expect(transportNotes(route())).toEqual([])
  })

  it('tells the items, the dialogue, the conditions and the approximate end of a route', () => {
    const stops = new Map([['b', stop('b', { anchor: mournhold })]])
    setLang('ru')
    expect(transportNotes(route({ items: [{ name: 'Andasreth Propylon Index', ru: 'Метка пропильона Андасрета' }], dialogue: true, conditional: true }), stops)).toEqual([
      'Нужно: Метка пропильона Андасрета.',
      'Предлагается в разговоре с перевозчиком.',
      'Доступность может зависеть от заданий и других условий.',
      'У места «Морнхолд» нет своей внешней карты; положение здесь примерное.',
    ])
  })
})

describe('transport filters', () => {
  const data: TransportData = { sets: new Map(), anchors: [], items: new Map() }

  function open(initial: TransportMode[] = []) {
    const modes = new Set<TransportMode>(initial)
    const onChange = vi.fn()
    const element = createTransportControls(modes, onChange, [pluginSet('morrowind')], data)
    const boxes = [...element.querySelectorAll<HTMLInputElement>('.transport-option input')]
    const all = element.querySelector<HTMLInputElement>('.transport-actions input')!
    const reset = element.querySelector<HTMLButtonElement>('.transport-reset')!
    return { element, modes, onChange, boxes, all, reset }
  }
  const toggle = (input: HTMLInputElement) => {
    input.checked = !input.checked
    input.dispatchEvent(new Event('change'))
  }

  it('lists every mode, checked as the link says', () => {
    const { element, boxes, all, reset } = open(['water'])
    expect([...element.querySelectorAll('.transport-option')].map((label) => label.textContent)).toEqual(
      ['Land transport', 'Water transport', 'Skylamps', 'Guild guides', 'Magical travel', 'Propylons'])
    expect(boxes.map((box) => box.checked)).toEqual(TRANSPORT_MODES.map((mode) => mode === 'water'))
    expect([all.checked, reset.disabled]).toEqual([false, false])
  })

  it('switches one mode, all of them, and clears them', () => {
    const { modes, onChange, boxes, all, reset } = open()
    expect(reset.disabled).toBe(true)
    toggle(boxes[0])
    expect([...modes]).toEqual(['land'])
    toggle(all)
    expect([modes.size, boxes.every((box) => box.checked)]).toEqual([TRANSPORT_MODES.length, true])
    toggle(boxes[1])
    expect(all.checked, 'no longer all').toBe(false)
    reset.click()
    expect([modes.size, boxes.some((box) => box.checked), reset.disabled]).toEqual([0, false, true])
    toggle(all)
    toggle(all)
    expect(modes.size).toBe(0)
    expect(onChange).toHaveBeenCalledTimes(6)
  })
})

describe('the transport layer', () => {
  const tamriel = pluginSet('tamriel', { backdropFor: ['tr'], land: [23, -28] })
  const sets = manifest([pluginSet('base', { land: [0, 0, 10, 0] }), pluginSet('tr', { name: 'Tamriel Rebuilt', land: [] }), tamriel])
  const at = (x: number, cell = ''): Destination => ({ position: [x * 8192 + 4096, 4096, 0], cell })
  const carrier = (id: string, destinations: Destination[], mode: TransportMode = 'land'): Actor => ({ id, name: id, mode, script: '', deleted: false, destinations })
  const placed = (key: string, actor: string, x: number): TransportReference => ({ key, actor, cell: '', position: at(x).position, deleted: false, destination: null })
  const data: TransportData = {
    sets: new Map([['base', {
      actors: [carrier('strider', [at(10)]), carrier('back', [at(0)]), carrier('boat', [at(40)], 'water'), carrier('mage', [at(0, 'mournhold, palace')], 'magic')],
      references: [placed('s', 'strider', 0), placed('b', 'back', 10), placed('w', 'boat', 0), placed('m', 'mage', 10)],
      activators: [], scripts: [], dialogue: [], interventionReferences: [],
    }]]),
    anchors: [{ cells: 'mournhold', x: 23.5, y: -27.5, name: 'Mournhold' }],
    items: new Map(),
  }
  const places = [location('settlement', 'Seyda Neen', 0.5, 0.5), location('settlement', 'Balmora', 10.5, 0.5)]

  function open(onPickStop: (stop: TransportStop) => boolean = () => false) {
    const map = testMap()
    const layer = createTransportLayer(map, data, sets, places, onPickStop)
    const layers = <T extends L.Layer>(type: new (...args: never[]) => T) => {
      const found: T[] = []
      map.eachLayer((item) => { if (item instanceof type) found.push(item) })
      return found
    }
    const stopAt = (x: number) => layers(L.CircleMarker).find((item) => Math.floor(item.getLatLng().lng) === x)!
    const popup = () => map.getContainer().querySelector('.transport-card')
    return { map, layer, layers, stopAt, popup }
  }

  afterEach(() => document.body.replaceChildren())

  it('draws the routes of the modes that are switched on, with an arrow where there is no way back', () => {
    const { layer, layers } = open()
    layer.update(new Set(['base']), new Set(['land']))
    expect([layers(L.Polyline).filter((item) => !(item instanceof L.CircleMarker)).length, layers(L.CircleMarker).length, layers(L.Marker).length]).toEqual([1, 2, 0])
    layer.update(new Set(['base']), new Set(['land', 'water', 'magic']))
    // The magic stop needs the backdrop of Tamriel Rebuilt; the boat goes off the enabled land.
    expect(layers(L.Marker), 'arrows').toHaveLength(0)
    layer.update(new Set(['base', 'tr']), new Set(['magic']))
    expect([layers(L.Polyline).filter((item) => !(item instanceof L.CircleMarker)).length, layers(L.Marker).length]).toEqual([1, 1])
  })

  it('opens a card with the departures of a stop, and goes to the stop at the other end', () => {
    const { layer, layers, stopAt, popup, map } = open()
    layer.update(new Set(['base']), new Set(['land', 'water', 'magic']))
    stopAt(0).fire('click')
    expect(popup()!.querySelector('strong')!.textContent).toBe('Seyda Neen')
    expect([...popup()!.querySelectorAll('.transport-destination')].map((item) => item.textContent)).toEqual(['Land transport → BalmoraCarrier: strider'])
    // The boat waits at the same place, as a stop of its own.
    const departures = layers(L.CircleMarker).filter((item) => Math.floor(item.getLatLng().lng) === 0).map((item) => {
      item.fire('click')
      return popup()!.querySelector('.transport-destination')!.textContent
    })
    expect(departures).toContain('Water transport → 40, 0Carrier: boatOutside the enabled map areas')
    stopAt(0).fire('click')
    popup()!.querySelector<HTMLButtonElement>('.transport-destination button')!.click()
    expect(popup()!.querySelector('strong')!.textContent).toBe('Balmora')
    expect(map.getZoom()).toBeGreaterThanOrEqual(6)
    expect([...popup()!.querySelectorAll('.transport-destination')].map((item) => item.textContent)).toEqual(['Land transport → Seyda NeenCarrier: back'])
    const atBalmora = layers(L.CircleMarker).filter((item) => Math.floor(item.getLatLng().lng) === 10).map((item) => {
      item.fire('click')
      return popup()!.querySelector('.transport-destination')!.textContent
    })
    expect(atBalmora).toContain('Magical travel → Mournhold (approximate)Carrier: mageMournhold has no exterior map of its own; its position here is approximate.Enable Tamriel Rebuilt to show this point.')
  })

  it('hands a clicked stop to the route planner while it is picking', () => {
    const onPickStop = vi.fn(() => true)
    const { layer, stopAt, popup } = open(onPickStop)
    layer.update(new Set(['base']), new Set(['land']))
    stopAt(0).fire('click')
    expect([onPickStop.mock.calls.length, popup()]).toEqual([1, null])
  })

  it('gives the route planner only what is on the enabled land and switched on', () => {
    const { layer } = open()
    layer.update(new Set(['base']), new Set(['land', 'water']))
    const network = layer.routingNetwork()
    expect(network.routes.map((route) => route.mode)).toEqual(['land', 'land'])
    layer.update(new Set(['base', 'tr']), new Set(['magic']))
    expect(layer.routingNetwork().routes.map((route) => route.mode)).toEqual(['magic'])
  })

  it('dims the network while a planned route is shown', () => {
    const { layer, layers } = open()
    layer.update(new Set(['base', 'tr']), new Set(['land', 'magic']))
    layer.setRouteFocus(true)
    layer.setRouteFocus(true)
    const lines = layers(L.Polyline).filter((item) => !(item instanceof L.CircleMarker))
    expect(lines.every((line) => line.options.opacity === 0.4)).toBe(true)
    expect(layers(L.Marker).every((arrow) => arrow.options.opacity === 0.4)).toBe(true)
    layer.setRouteFocus(false)
    layer.refresh()
    expect(layers(L.Polyline).filter((item) => !(item instanceof L.CircleMarker)).every((line) => line.options.opacity === 0.8)).toBe(true)
  })
})
