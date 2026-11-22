import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLang } from './i18n'
import { kindName, kindPlural, loadLocations, localize } from './locations'
import { fakeFetch, location, manifest, pluginSet } from './test-helpers'

afterEach(() => {
  setLang('en')
  vi.unstubAllGlobals()
})

const sets = manifest([
  pluginSet('morrowind', { locations: 'locations/morrowind.json', name: 'Morrowind' }),
  pluginSet('tr', { locations: 'locations/tr.json' }),
  pluginSet('tamriel', { backdropFor: ['tr'] }),
])
const files = {
  'locations/morrowind.json': {
    settlements: [{ name: 'Balmora', ru: 'Балмора', x: -2.6, y: -1.2, cells: [[-3, -2], [-2, -2]] }],
    entrances: [{ name: 'Balmora, Guild of Mages', x: -2.1, y: -1.9 }],
    regions: [{ id: 'west gash', name: 'West Gash', ru: 'Западное Нагорье', color: '#aabbcc', x: -5, y: 3, cells: [[-5, 3]] }],
    renamed: [],
  },
  'locations/tr.json': {
    settlements: [],
    entrances: [],
    regions: [{ id: 'west gash', name: 'West Gash', color: '#aabbcc', x: 9, y: 9, cells: [[9, 9], [9, 10]], continues: true }],
    renamed: [[1, 2]],
    cleared: [[3, 4]],
  },
}

describe('loadLocations', () => {
  it('loads the Locations of every set that has them, with ids stable enough for links', async () => {
    vi.stubGlobal('fetch', fakeFetch(files))
    const { all } = await loadLocations(sets)
    expect(all.map((item) => [item.id, item.kind, item.size])).toEqual([
      ['morrowind:s:-3,-2:Balmora', 'settlement', 2],
      ['morrowind:e:-3,-2:Balmora, Guild of Mages', 'entrance', 0],
      ['morrowind:r:-5,3:West Gash', 'region', 1],
    ])
    expect(all[0].set.name).toBe('Morrowind')
  })

  it('keeps a Region that a later set extends as an area only', async () => {
    vi.stubGlobal('fetch', fakeFetch(files))
    const { all, regionAreas } = await loadLocations(sets)
    expect(regionAreas.map((area) => area.set.id)).toEqual(['morrowind', 'tr'])
    expect(all.filter((item) => item.kind === 'region')).toHaveLength(1)
  })

  it('tells which Cells each set renames and clears', async () => {
    vi.stubGlobal('fetch', fakeFetch(files))
    const { renamedBy, clearedBy } = await loadLocations(sets)
    expect([renamedBy.get('tr'), clearedBy.get('tr'), clearedBy.get('morrowind')]).toEqual([[[1, 2]], [[3, 4]], []])
  })

  it('names them in the current language', async () => {
    setLang('ru')
    vi.stubGlobal('fetch', fakeFetch(files))
    const { all, regionAreas } = await loadLocations(sets)
    expect(all.map((item) => item.name)).toEqual(['Балмора', 'Balmora, Guild of Mages', 'Западное Нагорье'])
    expect(regionAreas[1].name, 'no Russian name').toBe('West Gash')
  })

  it('says which set could not be loaded', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'locations/morrowind.json': files['locations/morrowind.json'] }))
    await expect(loadLocations(sets)).rejects.toThrow('Could not load the locations of tr (404).')
  })
})

describe('names of kinds and Locations', () => {
  it('follow the language', () => {
    expect([kindName('entrance'), kindPlural('region')]).toEqual(['Interior Entrance', 'Regions'])
    setLang('ru')
    expect([kindName('entrance'), kindPlural('region')]).toEqual(['Вход в помещение', 'Регионы'])
    const places = [location('settlement', 'Balmora', 0, 0, { ru: 'Балмора' }), location('settlement', 'Pelagiad', 0, 0)]
    localize(places)
    expect(places.map((place) => place.name)).toEqual(['Балмора', 'Pelagiad'])
  })
})
