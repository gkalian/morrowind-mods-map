/** What the pipeline writes to `data/manifest.json`. */
export interface Manifest {
  /** Changes with every build of the map data. */
  build: number
  /** Side of a Cell in game units. */
  cellSize: number
  minZoom: number
  maxNativeZoom: number
  water: string
  sets: PluginSet[]
}

export interface PluginSet {
  id: string
  name: string
  /** Release of the mod, when it has one. */
  version?: string
  defaultOn: boolean
  locked: boolean
  /**
   * Set on a Backdrop Set: the Plugin Sets it lies under. It is shown while any of them is on,
   * has no Locations and is not listed in the legend.
   */
  backdropFor?: string[]
  /** Tile folder, relative to `data/`. */
  tiles: string
  /** Deepest zoom level this set has tiles for. */
  maxNativeZoom: number
  /** Locations file, relative to `data/`. */
  locations?: string
  cells: number
  /** Cell grid extent, inclusive: west, south, east, north. */
  bounds: [number, number, number, number]
  /** The Cells this set has tiles for, as x, y, x, y, ... */
  land: number[]
}

export async function loadManifest(): Promise<Manifest> {
  // The manifest names the build the tiles belong to, so it alone is never taken from the cache.
  const response = await fetch('data/manifest.json', { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`Could not load the map data (${response.status}). Run the pipeline first.`)
  }
  return response.json()
}
