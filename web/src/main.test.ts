// The whole page, started as the browser starts it, on made-up map data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeFetch, manifest, pluginSet } from './test-helpers'

const morrowind = pluginSet('morrowind', { name: 'Morrowind', locked: true, defaultOn: true, locations: 'locations/morrowind.json', land: [0, 0, 1, 0, 0, 1, 1, 1], bounds: [0, 0, 1, 1] })
const tr = pluginSet('tr', { name: 'Tamriel Rebuilt', locations: 'locations/tr.json', land: [2, 0, 3, 0], bounds: [2, 0, 3, 0] })
const tamriel = pluginSet('tamriel', { name: 'Tamriel', backdropFor: ['tr'], land: [4, 0], bounds: [4, 0, 4, 0] })
const files = {
  'data/manifest.json': manifest([morrowind, tr, tamriel], { transport: 'transport/index.json' }),
  'locations/morrowind.json': {
    settlements: [{ name: 'Balmora', ru: 'Балмора', x: 0.5, y: 0.5, cells: [[0, 0]] }],
    entrances: [{ name: 'Balmora, Temple', x: 0.6, y: 0.4 }],
    regions: [{ id: 'west gash', name: 'West Gash', color: '#aabbcc', x: 1, y: 1, cells: [[0, 0], [1, 1]] }],
    renamed: [],
  },
  'locations/tr.json': {
    settlements: [{ name: 'Old Ebonheart', x: 2.5, y: 0.5, cells: [[2, 0]] }],
    entrances: [],
    regions: [],
    renamed: [[0, 0]],
    cleared: [[0, 0]],
  },
  'transport/index.json': { schemaVersion: 2, sets: ['morrowind'], anchors: [], items: {} },
  'transport/morrowind.json': { actors: [], references: [], activators: [], scripts: [], dialogue: [], interventionReferences: [] },
}

beforeEach(() => {
  localStorage.clear()
  // The light browser has no canvas to draw the Region colours and the Cell grid on.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    { fillRect() {}, fillText() {} } as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  history.replaceState(null, '', '/')
  document.body.replaceChildren()
})

async function boot(url = '/', answers: Record<string, unknown> = files) {
  history.replaceState(null, '', url)
  document.body.innerHTML = '<div id="map"></div><div id="cursor"></div>'
  const container = document.getElementById('map')!
  Object.defineProperty(container, 'clientWidth', { value: 1200 })
  Object.defineProperty(container, 'clientHeight', { value: 800 })
  vi.stubGlobal('fetch', fakeFetch(answers))
  vi.resetModules()
  await import('./main')
  await vi.waitFor(() => {
    if (!document.querySelector('.panel') && !document.body.textContent?.includes('Could not')) throw new Error('not started yet')
  })
  const params = () => new URLSearchParams(window.location.search)
  const tick = (label: string) => {
    const input = [...document.querySelectorAll<HTMLLabelElement>('label')].find((item) => item.textContent === label)!.querySelector('input')!
    input.checked = !input.checked
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const card = () => document.querySelector('.leaflet-popup .card')
  return { container, params, tick, card }
}

describe('the page', () => {
  it('shows the panel, the legend and the footer, and keeps the view in the address once it moves', async () => {
    const { params } = await boot()
    expect(document.querySelector('.panel .search input')).not.toBeNull()
    expect([...document.querySelectorAll('.legend-set > details > summary')].map((item) => item.textContent)).toEqual(['Morrowind', 'Tamriel Rebuilt'])
    expect(document.querySelector('.footer')).not.toBeNull()
    expect(params().has('z'), 'the first framing is not a move of the viewer').toBe(false)
    document.querySelector<HTMLElement>('.leaflet-control-zoom-in')!.click()
    await vi.waitFor(() => expect(['x', 'y', 'z'].every((key) => params().has(key))).toBe(true))
  })

  it('tells what is wrong when there is no map data', async () => {
    await boot('/', {})
    expect(document.body.textContent).toBe('Could not load the map data (404). Run the pipeline first.')
  })

  it('works without transport, and tells when it could not be loaded', async () => {
    const { 'transport/index.json': _index, ...rest } = files
    await boot('/', rest)
    expect(document.querySelector('.transport-notice')!.textContent).toContain('Transport data could not be loaded.')
    expect(document.querySelector('.transport-options')).toBeNull()
  })

  it('starts at the view and the Plugin Sets of a link, and opens the linked Location', async () => {
    const { params, card } = await boot('/?x=4096&y=4096&z=7&sets=tr&colours=1&grid=1&transport=land,bogus&loc=morrowind:s:0,0:Balmora')
    expect([params().get('z'), params().get('loc')]).toEqual(['7', 'morrowind:s:0,0:Balmora'])
    expect(document.querySelectorAll<HTMLInputElement>('.legend-set > input')[1].checked).toBe(true)
    expect(card()!.textContent).toBe('BalmoraSettlement · MorrowindCell 0, 0Copy link')
  })

  it('keeps what is switched on in the address', async () => {
    const { params, tick } = await boot()
    tick('Region colours')
    tick('Cell grid')
    document.querySelectorAll<HTMLInputElement>('.legend-set > input')[1].click()
    tick('Land transport')
    expect([params().get('sets'), params().get('colours'), params().get('grid'), params().get('transport')]).toEqual(['tr', '1', '1', 'land'])
    tick('Region colours')
    tick('Land transport')
    expect([params().has('colours'), params().has('transport')]).toEqual([false, false])
  })

  it('switches on the Plugin Set of a Location picked from the search', async () => {
    const { params, card } = await boot()
    const input = document.querySelector<HTMLInputElement>('.search input')!
    input.value = 'old eb'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect([params().get('sets'), params().get('loc'), card()!.querySelector('strong')!.textContent]).toEqual(['tr', 'tr:s:2,0:Old Ebonheart', 'Old Ebonheart'])
  })

  it('copies the link to a Location, and says when it cannot', async () => {
    const { card } = await boot('/?loc=morrowind:s:0,0:Balmora')
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const copy = card()!.querySelector('button')!
    copy.click()
    await vi.waitFor(() => expect(copy.textContent).toBe('Link copied'))
    copy.click()
    await vi.waitFor(() => expect(copy.textContent).toBe('Could not copy'))
    expect(writeText).toHaveBeenCalledWith(window.location.href)
  })

  it('switches the language, rebuilding the legend as it was', async () => {
    const { params, card } = await boot('/?loc=morrowind:s:0,0:Balmora')
    document.querySelector<HTMLDetailsElement>('.legend-display')!.open = true
    const language = document.querySelector<HTMLButtonElement>('.language')!
    expect(language.textContent).toBe('EN')
    language.click()
    expect([language.textContent, params().get('lang'), document.querySelector('.legend-modules > summary')!.textContent]).toEqual(['RU', 'ru', 'Модули карты'])
    expect(document.querySelector<HTMLDetailsElement>('.legend-display')!.open).toBe(true)
    expect(card()!.querySelector('strong')!.textContent).toBe('Балмора')
  })

  it('hides the legend with the menu button and folds the panel away, remembering it', async () => {
    await boot()
    const menu = document.querySelector<HTMLButtonElement>('.menu')!
    menu.click()
    expect([document.querySelector<HTMLElement>('.legend')!.hidden, menu.getAttribute('aria-expanded')]).toEqual([true, 'false'])
    const fold = document.querySelector<HTMLButtonElement>('.panel-fold')!
    fold.click()
    expect([document.documentElement.dataset.panel, fold.getAttribute('aria-label'), localStorage.getItem('panel')]).toEqual(['folded', 'Show panel', 'folded'])
    await boot()
    expect([document.documentElement.dataset.panel, document.querySelector<HTMLElement>('.panel')!.inert]).toEqual(['folded', true])
    document.querySelector<HTMLButtonElement>('.panel-fold')!.click()
    expect(document.documentElement.dataset.panel).toBe('open')
  })

  it('shows the Cell under the pointer, and frames the land on a middle click', async () => {
    const { container } = await boot()
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 600, clientY: 400 }))
    const cursor = document.getElementById('cursor')!
    expect(cursor.textContent).toMatch(/^Cell -?\d+, -?\d+$/)
    container.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    expect(cursor.textContent).toBe('')
    const middle = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
    container.dispatchEvent(middle)
    expect(middle.defaultPrevented).toBe(true)
  })
})
