import { lang, t, type StringKey } from './i18n'
import type { Manifest, PluginSet } from './manifest'

export type Kind = 'settlement' | 'entrance' | 'region'

export function kindName(kind: Kind): string {
  return t(kind)
}

const PLURALS: Record<Kind, StringKey> = { settlement: 'settlements', entrance: 'entrances', region: 'regions' }

export function kindPlural(kind: Kind): string {
  return t(PLURALS[kind])
}

export type Grid = [number, number]

/** A named place on the Map. Position is in Cells, east and north. */
export interface Location {
  /** Stable enough to put in a link. */
  id: string
  kind: Kind
  /** The name in the current language: the Russian one falls back to the English. */
  name: string
  en: string
  ru?: string
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
  settlements: { name: string; ru?: string; x: number; y: number; cells: Grid[] }[]
  entrances: { name: string; ru?: string; x: number; y: number }[]
  regions: { id: string; name: string; ru?: string; color: string; x: number; y: number; cells: Grid[]; continues?: boolean }[]
  renamed: Grid[]
  cleared?: Grid[]
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
  /** For each Plugin Set, the Cells where it deletes or moves doors of earlier sets: their Interior Entrances there give way. */
  clearedBy: Map<string, Grid[]>
}

/** Gives every Location its name in the current language. */
export function localize(locations: Location[]): void {
  const russian = lang() === 'ru'
  for (const location of locations) location.name = (russian && location.ru) || location.en
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
  const clearedBy = new Map<string, Grid[]>()
  for (const { set, file } of files) {
    renamedBy.set(set.id, file.renamed)
    clearedBy.set(set.id, file.cleared ?? [])
    for (const s of file.settlements) {
      all.push({
        id: locationId(set, 'settlement', s.name, s.x, s.y),
        kind: 'settlement',
        set,
        name: s.name,
        en: s.name,
        ru: s.ru,
        x: s.x,
        y: s.y,
        size: s.cells.length,
        cells: s.cells,
      })
    }
    for (const e of file.entrances) {
      all.push({ id: locationId(set, 'entrance', e.name, e.x, e.y), kind: 'entrance', set, size: 0, en: e.name, ...e })
    }
    for (const r of file.regions) {
      const area: Location = {
        id: locationId(set, 'region', r.name, r.x, r.y),
        kind: 'region',
        set,
        name: r.name,
        en: r.name,
        ru: r.ru,
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
  localize(regionAreas)
  localize(all)
  return { all, regionAreas, renamedBy, clearedBy }
}
