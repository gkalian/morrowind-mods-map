import type { Manifest, PluginSet } from './manifest'

export type Kind = 'settlement' | 'entrance' | 'region'

export const KIND_NAMES: Record<Kind, string> = {
  settlement: 'Settlement',
  entrance: 'Interior Entrance',
  region: 'Region',
}

export const KIND_PLURALS: Record<Kind, string> = {
  settlement: 'Settlements',
  entrance: 'Interior Entrances',
  region: 'Regions',
}

export type Grid = [number, number]

/** A named place on the Map. Position is in Cells, east and north. */
export interface Location {
  /** Stable enough to put in a link. */
  id: string
  kind: Kind
  name: string
  set: PluginSet
  x: number
  y: number
  /** Number of Cells covered; decides which names win when they overlap. */
  size: number
  /** The Cells a Settlement or Region covers. */
  cells?: Grid[]
  /** Regions only. */
  color?: string
}

interface LocationsFile {
  settlements: { name: string; x: number; y: number; cells: Grid[] }[]
  entrances: { name: string; x: number; y: number }[]
  regions: { id: string; name: string; color: string; x: number; y: number; cells: Grid[]; continues?: boolean }[]
  renamed: Grid[]
}

export interface MapLocations {
  all: Location[]
  /**
   * Every Region area, for colouring Cells. It includes the areas by which a Plugin Set extends
   * a Region of an earlier set; those are not Locations of their own.
   */
  regionAreas: Location[]
  /** For each Plugin Set, the Cells it renames: Settlements of other sets there give way to it. */
  renamedBy: Map<string, Grid[]>
}

function locationId(set: PluginSet, kind: Kind, name: string, x: number, y: number): string {
  return `${set.id}:${kind[0]}:${Math.floor(x)},${Math.floor(y)}:${name}`
}

/** Loads the Locations of every Plugin Set, including the ones that are switched off. */
export async function loadLocations(manifest: Manifest): Promise<MapLocations> {
  const files = await Promise.all(
    manifest.sets.filter((set) => set.locations).map(async (set) => {
      const response = await fetch(`data/${set.locations}`)
      if (!response.ok) throw new Error(`Could not load the locations of ${set.name} (${response.status}).`)
      return { set, file: (await response.json()) as LocationsFile }
    }),
  )

  const all: Location[] = []
  const regionAreas: Location[] = []
  const renamedBy = new Map<string, Grid[]>()
  for (const { set, file } of files) {
    renamedBy.set(set.id, file.renamed)
    for (const s of file.settlements) {
      all.push({
        id: locationId(set, 'settlement', s.name, s.x, s.y),
        kind: 'settlement',
        set,
        name: s.name,
        x: s.x,
        y: s.y,
        size: s.cells.length,
        cells: s.cells,
      })
    }
    for (const e of file.entrances) {
      all.push({ id: locationId(set, 'entrance', e.name, e.x, e.y), kind: 'entrance', set, size: 0, ...e })
    }
    for (const r of file.regions) {
      const area: Location = {
        id: locationId(set, 'region', r.name, r.x, r.y),
        kind: 'region',
        set,
        name: r.name,
        x: r.x,
        y: r.y,
        size: r.cells.length,
        cells: r.cells,
        color: r.color,
      }
      regionAreas.push(area)
      if (!r.continues) all.push(area)
    }
  }
  return { all, regionAreas, renamedBy }
}
