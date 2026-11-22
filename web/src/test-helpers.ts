// Builders of test data, so that a test spells out only what it is about. Used by tests only.
import L from 'leaflet'
import type { Kind, Location } from './locations'
import type { Manifest, PluginSet } from './manifest'

export function pluginSet(id: string, extra: Partial<PluginSet> = {}): PluginSet {
  return { id, name: id, defaultOn: false, locked: false, tiles: `tiles/${id}`, maxNativeZoom: 10, cells: 0, bounds: [0, 0, 0, 0], land: [], ...extra }
}

export function manifest(sets: (string | PluginSet)[], extra: Partial<Manifest> = {}): Manifest {
  return {
    build: 1,
    cellSize: 8192,
    minZoom: 2,
    maxNativeZoom: 10,
    water: '#344e6e',
    sets: sets.map((set) => (typeof set === 'string' ? pluginSet(set) : set)),
    ...extra,
  }
}

export function location(kind: Kind, en: string, x: number, y: number, extra: Partial<Location> = {}): Location {
  return { id: `${kind}:${en}`, kind, name: en, en, set: pluginSet('base'), x, y, size: 1, ...extra }
}

/** A `fetch` that answers each address from the table, and 404 for the rest. */
export function fakeFetch(answers: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const found = Object.entries(answers).find(([end]) => address.endsWith(end))
    return found
      ? new Response(JSON.stringify(found[1]), { status: 200 })
      : new Response('not found', { status: 404 })
  }) as typeof fetch
}

/**
 * A Leaflet map on the page, in Cells as the site has it. The light browser of the tests lays
 * nothing out, so the map is given its size by hand.
 */
export function testMap(width = 800, height = 600): L.Map {
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { value: width })
  Object.defineProperty(container, 'clientHeight', { value: height })
  document.body.append(container)
  return L.map(container, { crs: L.CRS.Simple, center: [0, 0], zoom: 6, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false })
}
