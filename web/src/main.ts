import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'
import { createFooter } from './footer'
import { LabelLayer } from './labels'
import { createLegend, type Shown } from './legend'
import { KIND_NAMES, loadLocations, type Kind, type Location } from './locations'
import { loadManifest, type Manifest, type PluginSet } from './manifest'
import { cellGrid, regionTint } from './overlays'
import { createSearch } from './search'

/** How far past the deepest rendered zoom the Map may be magnified. */
const EXTRA_ZOOM = 1

/** Room the panel takes on the left, kept clear when the Map first frames the land. */
const PANEL_WIDTH = 340

/** Zoom the Map moves to when a Location of each kind is picked from far away. */
const PICK_ZOOM: Record<Kind, number> = { region: 4, settlement: 6, entrance: 8 }

// Map coordinates are in Cells: longitude is the Cell column, latitude the Cell row.
function setBounds(set: PluginSet): L.LatLngBounds {
  const [west, south, east, north] = set.bounds
  return L.latLngBounds([south, west], [north + 1, east + 1])
}

/** Zoom level at which one Cell is exactly one tile. */
const CELL_ZOOM = 8

type TerrainLayerClass = new (url: string, options: L.TileLayerOptions) => L.TileLayer

/**
 * The tiles of one Plugin Set. It asks only for tiles the set has: most of a set's bounding box
 * is sea or another set's land, and those requests would all fail. With `isCovered` given, it
 * also leaves out the tiles whose every Cell that function reports as hidden under other land.
 */
function terrainLayer(manifest: Manifest, set: PluginSet, isCovered?: (x: number, y: number) => boolean): L.TileLayer {
  // Tiles that exist at each zoom level, filled in when a level is first shown.
  const levels = new Map<number, Set<string>>()
  function tilesAt(zoom: number): Set<string> {
    let tiles = levels.get(zoom)
    if (!tiles) {
      tiles = new Set()
      const scale = 2 ** (zoom - CELL_ZOOM)
      for (let i = 0; i < set.land.length; i += 2) {
        // Rows grow southwards on screen and northwards in the game.
        tiles.add(`${Math.floor(set.land[i] * scale)},${Math.floor(-(set.land[i + 1] + 1) * scale)}`)
      }
      levels.set(zoom, tiles)
    }
    return tiles
  }

  const base = L.TileLayer.prototype as unknown as { _isValidTile(coords: L.Coords): boolean }
  const Layer = L.TileLayer.extend({
    _isValidTile(coords: L.Coords): boolean {
      if (!base._isValidTile.call(this, coords)) return false
      // Past the Cell's own zoom every tile inside a Cell with land exists.
      const scale = 2 ** Math.max(0, coords.z - CELL_ZOOM)
      const [x, y] = [Math.floor(coords.x / scale), Math.floor(coords.y / scale)]
      if (!tilesAt(Math.min(coords.z, CELL_ZOOM)).has(`${x},${y}`)) return false
      if (!isCovered) return true

      // The Cells under the tile: one from the Cell's own zoom on, a square block of them before.
      const across = 2 ** Math.max(0, CELL_ZOOM - coords.z)
      const cells = tilesAt(CELL_ZOOM)
      for (let row = y * across; row < (y + 1) * across; row++) {
        for (let column = x * across; column < (x + 1) * across; column++) {
          if (cells.has(`${column},${row}`) && !isCovered(column, -row - 1)) return true
        }
      }
      return false
    },
  }) as unknown as TerrainLayerClass

  return new Layer(`data/${set.tiles}/{z}/{x}/{y}.webp?v=${manifest.build}`, {
    tileSize: 256,
    minNativeZoom: manifest.minZoom,
    maxNativeZoom: set.maxNativeZoom,
    maxZoom: manifest.maxNativeZoom + EXTRA_ZOOM,
    bounds: setBounds(set),
    noWrap: true,
    // Tiles of the levels passed through on the way to another zoom are not asked for.
    updateWhenZooming: false,
    // Tiles this far outside the view stay loaded, so panning back shows them at once.
    keepBuffer: 4,
    // Later Plugin Sets cover earlier ones where both define a Cell, whatever order they are switched on in.
    zIndex: manifest.sets.indexOf(set) + 1,
  })
}

/** Reads the view from the URL: position in game units and zoom. */
function viewFromUrl(manifest: Manifest): { center: L.LatLngExpression; zoom: number } | null {
  const params = new URLSearchParams(location.search)
  const [x, y, z] = ['x', 'y', 'z'].map((key) => Number.parseFloat(params.get(key) ?? ''))
  if ([x, y, z].some(Number.isNaN)) return null
  return { center: [y / manifest.cellSize, x / manifest.cellSize], zoom: z }
}

/** Reads which Plugin Sets are on from the URL; without it, each set's own default applies. */
function setsFromUrl(manifest: Manifest): Set<string> {
  const listed = new URLSearchParams(location.search).get('sets')
  const wanted = listed === null ? null : new Set(listed.split(',').filter(Boolean))
  return new Set(
    manifest.sets
      .filter((set) => !set.backdropFor && (set.locked || (wanted ? wanted.has(set.id) : set.defaultOn)))
      .map((set) => set.id),
  )
}

function updateUrl(change: (params: URLSearchParams) => void): void {
  const params = new URLSearchParams(location.search)
  change(params)
  history.replaceState(null, '', `?${params}`)
}

function locationCard(place: Location): HTMLElement {
  const card = document.createElement('div')
  card.className = 'card'

  const name = document.createElement('strong')
  name.textContent = place.name
  const kind = document.createElement('div')
  kind.textContent = `${KIND_NAMES[place.kind]} · ${place.set.name}`
  const cell = document.createElement('div')
  cell.textContent = `Cell ${Math.floor(place.x)}, ${Math.floor(place.y)}`

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = 'Copy link'
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      copy.textContent = 'Link copied'
    } catch {
      copy.textContent = 'Could not copy'
    }
  })

  card.append(name, kind, cell, copy)
  return card
}

async function start(): Promise<void> {
  const manifest = await loadManifest()
  const { all: locations, regionAreas, renamedBy } = await loadLocations(manifest)
  document.documentElement.style.setProperty('--water', manifest.water)

  const map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: manifest.minZoom,
    maxZoom: manifest.maxNativeZoom + EXTRA_ZOOM,
    zoomSnap: 0.5,
    // Tiles are shown the moment they arrive.
    fadeAnimation: false,
    attributionControl: false,
  })
  map.zoomControl.setPosition('bottomleft')

  const shown: Shown = {
    sets: setsFromUrl(manifest),
    kinds: { settlement: true, entrance: true, region: true },
    regionColours: new URLSearchParams(location.search).has('colours'),
    cellGrid: new URLSearchParams(location.search).has('grid'),
  }

  // Cells that each Plugin Set covers completely: its own, away from the faded edge of its land.
  const alwaysShown = new Set<string>()
  for (const set of manifest.sets) {
    if (set.locked) for (let i = 0; i < set.land.length; i += 2) alwaysShown.add(`${set.land[i]},${set.land[i + 1]}`)
  }
  const solid = new Map<string, Set<string>>()
  for (const set of manifest.sets) {
    if (set.backdropFor) continue
    const own = new Set<string>()
    for (let i = 0; i < set.land.length; i += 2) own.add(`${set.land[i]},${set.land[i + 1]}`)
    const inside = new Set<string>()
    for (let i = 0; i < set.land.length; i += 2) {
      const [x, y] = [set.land[i], set.land[i + 1]]
      let surrounded = true
      for (let dy = -1; dy <= 1 && surrounded; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = `${x + dx},${y + dy}`
          if (!own.has(key) && !alwaysShown.has(key)) surrounded = false
        }
      }
      if (surrounded) inside.add(`${x},${y}`)
    }
    solid.set(set.id, inside)
  }
  /** Whether a Cell lies wholly under the land of a Plugin Set that is on: a Backdrop Set is not seen there. */
  function isCovered(x: number, y: number): boolean {
    for (const id of shown.sets) if (solid.get(id)?.has(`${x},${y}`)) return true
    return false
  }

  const terrain = new Map(
    manifest.sets.map((set) => [set.id, terrainLayer(manifest, set, set.backdropFor ? isCovered : undefined)]),
  )
  /** The Plugin Sets that were on when the Backdrop Sets were last drawn. */
  let drawnOver = [...shown.sets].sort().join(',')
  const grid = cellGrid(manifest.maxNativeZoom + EXTRA_ZOOM)
  let tint: L.GridLayer | null = null
  /** Cells whose name a shown Plugin Set has changed, with the id of that set. */
  let renamed = new Map<string, string>()

  function isShown(place: Location): boolean {
    if (!shown.sets.has(place.set.id) || !shown.kinds[place.kind]) return false
    if (place.kind !== 'settlement') return true
    // A Settlement gives way where a later Plugin Set has renamed its Cells.
    return !place.cells?.some(([x, y]) => (renamed.get(`${x},${y}`) ?? place.set.id) !== place.set.id)
  }

  /** Brings the Map in line with what is switched on. */
  function apply(): void {
    for (const set of manifest.sets) {
      const layer = terrain.get(set.id)!
      // A Backdrop Set comes and goes with the sets it lies under.
      const on = set.backdropFor ? set.backdropFor.some((id) => shown.sets.has(id)) : shown.sets.has(set.id)
      if (on) layer.addTo(map)
      else layer.remove()
    }
    // Which tiles a Backdrop Set needs depends on the land above it.
    const over = [...shown.sets].sort().join(',')
    if (over !== drawnOver) {
      drawnOver = over
      for (const set of manifest.sets) {
        const layer = terrain.get(set.id)!
        // Taken off and put back rather than redrawn: Leaflet's redraw goes wrong between whole zoom levels.
        if (set.backdropFor && map.hasLayer(layer)) layer.remove().addTo(map)
      }
    }

    renamed = new Map()
    for (const [id, cells] of renamedBy) {
      if (shown.sets.has(id)) for (const [x, y] of cells) renamed.set(`${x},${y}`, id)
    }

    tint?.remove()
    tint = null
    if (shown.regionColours) {
      tint = regionTint(regionAreas.filter((area) => shown.sets.has(area.set.id)), manifest.maxNativeZoom + EXTRA_ZOOM)
      tint.addTo(map)
    }

    if (shown.cellGrid) grid.addTo(map)
    else grid.remove()

    labels?.refresh()
  }

  function onLegendChange(): void {
    apply()
    const optional = manifest.sets.filter((set) => !set.locked && shown.sets.has(set.id)).map((set) => set.id)
    updateUrl((params) => {
      params.set('sets', optional.join(','))
      for (const [key, on] of [['colours', shown.regionColours], ['grid', shown.cellGrid]] as const) {
        if (on) params.set(key, '1')
        else params.delete(key)
      }
    })
  }

  /** Frames the land of the given Plugin Sets, clear of the panel. */
  function frame(sets: PluginSet[]): void {
    const bounds = L.latLngBounds([])
    for (const set of sets) bounds.extend(setBounds(set))
    map.fitBounds(bounds, { paddingTopLeft: [Math.min(PANEL_WIDTH, map.getSize().x / 4), 0] })
  }

  const view = viewFromUrl(manifest)
  if (view) {
    map.setView(view.center, view.zoom)
  } else {
    frame([manifest.sets.find((set) => set.locked) ?? manifest.sets[0]])
  }
  // The middle mouse button brings everything that is switched on back into view.
  map.getContainer().addEventListener('mousedown', (event) => {
    if (event.button !== 1) return
    // Otherwise the browser starts its own scrolling mode.
    event.preventDefault()
    frame(manifest.sets.filter((set) => shown.sets.has(set.id)))
  })
  map.on('moveend', () => {
    const center = map.getCenter()
    updateUrl((params) => {
      params.set('x', Math.round(center.lng * manifest.cellSize).toString())
      params.set('y', Math.round(center.lat * manifest.cellSize).toString())
      params.set('z', map.getZoom().toString())
    })
  })

  let selected: Location | null = null

  function select(place: Location, move: boolean): void {
    // A Location found in a Plugin Set that is off switches that set on.
    if (!shown.sets.has(place.set.id)) {
      shown.sets.add(place.set.id)
      legend.sync()
      onLegendChange()
    }

    const popup = L.popup({ offset: [0, -6], autoPan: !move }).setLatLng([place.y, place.x]).setContent(locationCard(place))
    popup.on('remove', () => {
      if (selected !== place) return
      selected = null
      labels?.select(null)
      updateUrl((params) => params.delete('loc'))
    })
    // Opening the new card closes the previous one, so the selection changes only afterwards.
    popup.openOn(map)
    selected = place
    labels?.select(place)
    updateUrl((params) => params.set('loc', place.id))
    if (move) map.flyTo([place.y, place.x], Math.max(map.getZoom(), PICK_ZOOM[place.kind]))
  }

  let labels: LabelLayer | undefined
  apply()
  labels = new LabelLayer(map, locations, isShown, (place) => select(place, false))

  const legend = createLegend(manifest.sets.filter((set) => !set.backdropFor), locations, shown, onLegendChange, (place) => select(place, true))

  const panel = document.createElement('div')
  panel.className = 'panel'
  const top = document.createElement('div')
  top.className = 'panel-top'
  const menu = document.createElement('button')
  menu.type = 'button'
  menu.className = 'menu'
  menu.textContent = '☰'
  menu.title = 'Legend'
  menu.setAttribute('aria-label', 'Legend')
  menu.setAttribute('aria-expanded', 'true')
  menu.addEventListener('click', () => {
    const hidden = legend.element.toggleAttribute('hidden')
    menu.setAttribute('aria-expanded', String(!hidden))
  })
  top.append(menu, createSearch(locations, (place) => select(place, true)))
  panel.append(top, legend.element)
  document.body.append(panel, createFooter(manifest))

  const linked = new URLSearchParams(location.search).get('loc')
  const place = linked ? locations.find((candidate) => candidate.id === linked) : undefined
  if (place) select(place, view === null)

  const cursor = document.getElementById('cursor')!
  map.on('mousemove', (event: L.LeafletMouseEvent) => {
    const { lat, lng } = event.latlng
    cursor.textContent = `Cell ${Math.floor(lng)}, ${Math.floor(lat)}`
  })
  map.on('mouseout', () => {
    cursor.textContent = ''
  })
}

start().catch((error: unknown) => {
  document.body.textContent = error instanceof Error ? error.message : String(error)
})
