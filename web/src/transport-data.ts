import type { Manifest } from './manifest'
import type { Location } from './locations'

/** Version of the transport files this viewer reads; the pipeline writes it into the index. */
export const TRANSPORT_SCHEMA = 2

export type TransportMode = 'land' | 'water' | 'air' | 'guild' | 'magic' | 'propylon'
/** A name in English, and in Russian where the Russian release has one. */
export interface Named { name: string; ru?: string }
export interface Destination { position: [number, number, number]; cell: string }
export interface Actor extends Named { id: string; mode: TransportMode | null; script: string; deleted: boolean; destinations: Destination[] }
export interface TransportReference { key: string; actor: string; cell: string; position: [number, number, number]; deleted: boolean; destination: Destination | null; location?: string }
export interface ActivatorRecord { id: string; script: string; deleted: boolean }
export interface Gate { to: Destination; items: string[]; mode: TransportMode }
export interface ScriptRecord { id: string; deleted: boolean; requires?: string[]; excludedBy?: string[]; conditional?: boolean; moves?: { actor: string; set: string; to: Destination }[]; gates?: Gate[] }
export interface DialogueRoute { actor: string; topic: string; mode: TransportMode; to: Destination; items?: string[] }
export interface TransportChanges { actors: Actor[]; references: TransportReference[]; activators: ActivatorRecord[]; scripts: ScriptRecord[]; dialogue: DialogueRoute[]; interventionReferences: TransportReference[] }
/** A place that exists only as interiors, shown at one point. Position in Cells. */
export interface Anchor extends Named { cells: string; x: number; y: number }
export interface TransportData { sets: Map<string, TransportChanges>; anchors: Anchor[]; items: Map<string, Named> }
export interface TransportStop {
  id: string
  x: number
  y: number
  interior: string
  modes: Set<TransportMode>
  provider?: Named
  /** The place without an exterior that the stop stands for. */
  anchor?: Anchor
  /** Its position is the anchor's, not a real one: no walking to or from it. */
  approximate?: boolean
}
export interface TransportRoute {
  from: string
  to: string
  mode: TransportMode
  provider?: Named
  providerId: string
  /** Items the player has to carry. */
  items?: Named[]
  /** The carrier comes and goes with the game, such as the stage of a quest. */
  conditional?: boolean
  /** Offered in conversation rather than as a travel service. */
  dialogue?: boolean
}
export interface TransportNetwork { stops: Map<string, TransportStop>; routes: TransportRoute[] }

type Point = [number, number, number]

export async function loadTransport(manifest: Manifest): Promise<TransportData | null> {
  if (!manifest.transport) return null
  const response = await fetch(`data/${manifest.transport}`)
  if (!response.ok) throw new Error(`Transport index: ${response.status}`)
  const index = await response.json() as { schemaVersion: number; sets: string[]; anchors?: Anchor[]; items?: Record<string, Named> }
  if (index.schemaVersion !== TRANSPORT_SCHEMA || !Array.isArray(index.sets)) throw new Error('Transport data is from another version; regenerate it')
  const root = manifest.transport.slice(0, manifest.transport.lastIndexOf('/') + 1)
  const groups = await Promise.all(manifest.sets.filter((set) => index.sets.includes(set.id)).map(async (set) => {
    const file = await fetch(`data/${root}${encodeURIComponent(set.id)}.json`)
    if (!file.ok) throw new Error(`Transport data: ${file.status}`)
    const changes = await file.json() as TransportChanges
    if (!Array.isArray(changes.actors) || !Array.isArray(changes.references)) throw new Error('Invalid transport data')
    return [set.id, changes] as const
  }))
  return { sets: new Map(groups), anchors: index.anchors ?? [], items: new Map(Object.entries(index.items ?? {})) }
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Follows doors from an interior, nearest first, to where they come out in the exterior. */
function exterior(cell: string, position: Point, doors: Map<string, TransportReference[]>): Point | null {
  const queue = [{ cell, position }]
  const seen = new Set<string>()
  while (queue.length) {
    const next = queue.shift()!
    if (seen.has(next.cell)) continue
    seen.add(next.cell)
    const options = [...(doors.get(next.cell) ?? [])].sort((a, b) => distance(a.position, next.position) - distance(b.position, next.position))
    for (const door of options) {
      if (!door.destination) continue
      if (!door.destination.cell) return door.destination.position
      if (!seen.has(door.destination.cell)) queue.push({ cell: door.destination.cell, position: door.destination.position })
    }
  }
  return null
}

/** Applies the enabled Plugin Sets in load order, as the game does, and builds the routes. */
export function buildTransport(data: TransportData, manifest: Manifest, enabled: Set<string>): TransportNetwork {
  const actors = new Map<string, Actor>()
  const references = new Map<string, TransportReference>()
  const activators = new Map<string, ActivatorRecord>()
  const scripts = new Map<string, ScriptRecord>()
  const dialogue: DialogueRoute[] = []
  const apply = <T>(target: Map<string, T>, items: T[] | undefined, key: (item: T) => string, deleted: (item: T) => boolean) => {
    for (const item of items ?? []) {
      if (deleted(item)) target.delete(key(item))
      else target.set(key(item), item)
    }
  }
  for (const set of manifest.sets) {
    if (!enabled.has(set.id)) continue
    const changes = data.sets.get(set.id)
    if (!changes) continue
    apply(actors, changes.actors, (item) => item.id, (item) => item.deleted)
    apply(references, changes.references, (item) => item.key, (item) => item.deleted)
    apply(activators, changes.activators, (item) => item.id, (item) => item.deleted)
    apply(scripts, changes.scripts, (item) => item.id, (item) => item.deleted)
    dialogue.push(...(changes.dialogue ?? []))
  }
  const cellSize = manifest.cellSize
  const doors = new Map<string, TransportReference[]>()
  const placed = new Map<string, TransportReference[]>()
  for (const ref of references.values()) {
    if (ref.destination && ref.cell) {
      const list = doors.get(ref.cell)
      if (list) list.push(ref)
      else doors.set(ref.cell, [ref])
    }
    const list = placed.get(ref.actor)
    if (list) list.push(ref)
    else placed.set(ref.actor, [ref])
  }
  /** Where a point inside or outside shows on the Map, and the anchor it belongs to. */
  const place = (cell: string, position: Point): { position: Point; anchor?: Anchor } | null => {
    if (!cell) return { position }
    const anchor = data.anchors.find((item) => cell.startsWith(item.cells))
    if (anchor) return { position: [anchor.x * cellSize, anchor.y * cellSize, 0], anchor }
    const found = exterior(cell, position, doors)
    return found ? { position: found } : null
  }
  const script = (actor: Actor) => (actor.script ? scripts.get(actor.script) : undefined)
  const available = (actor: Actor) => {
    const facts = script(actor)
    return !facts?.requires?.some((set) => !enabled.has(set)) && !facts?.excludedBy?.some((set) => enabled.has(set))
  }
  const named = (actor: Actor): Named => ({ name: actor.name, ru: actor.ru })
  const items = (ids: string[] | undefined) => ids?.length ? ids.map((id) => data.items.get(id) ?? { name: id }) : undefined
  const relocations = new Map<string, Destination>()
  for (const facts of scripts.values()) {
    for (const move of facts.moves ?? []) {
      if (enabled.has(move.set)) relocations.set(move.actor, move.to)
    }
  }

  const stops = new Map<string, TransportStop>()
  const addStop = (id: string, position: Point, interior: string, mode: TransportMode, extra: Partial<TransportStop> = {}): TransportStop => {
    const existing = stops.get(id)
    if (existing) {
      existing.modes.add(mode)
      return existing
    }
    const stop: TransportStop = { id, x: position[0] / cellSize, y: position[1] / cellSize, interior, modes: new Set([mode]), ...extra, approximate: extra.anchor ? true : undefined }
    stops.set(id, stop)
    return stop
  }
  const routes: TransportRoute[] = []
  const seen = new Set<string>()
  const addRoute = (route: TransportRoute) => {
    const key = `${route.mode}|${route.from}|${route.to}|${route.providerId}`
    if (route.from === route.to || seen.has(key)) return
    seen.add(key)
    routes.push(route)
  }

  // Carriers with travel destinations.
  interface Provider { actor: Actor; ref: TransportReference; stop: TransportStop; mode: TransportMode }
  const providers: Provider[] = []
  for (const original of references.values()) {
    const actor = actors.get(original.actor)
    if (!actor?.mode || !actor.destinations.length || !available(actor)) continue
    const relocated = relocations.get(actor.id)
    const ref = relocated ? { ...original, position: relocated.position, cell: relocated.cell } : original
    const at = place(ref.cell, ref.position)
    if (!at) continue
    const id = actor.mode === 'guild' && ref.cell ? `guild:${ref.cell}` : ref.key
    const stop = addStop(id, at.position, ref.cell, actor.mode, { provider: named(actor), anchor: at.anchor })
    providers.push({ actor, ref, stop, mode: actor.mode })
  }
  const byMode = new Map<TransportMode, Provider[]>()
  for (const provider of providers) {
    const list = byMode.get(provider.mode)
    if (list) list.push(provider)
    else byMode.set(provider.mode, [provider])
  }
  for (const source of providers) {
    for (const destination of source.actor.destinations) {
      const at = place(destination.cell, destination.position)
      if (!at) continue
      // The carrier waiting at the other end, so that both directions meet at one stop.
      let target: Provider | undefined
      let best = Infinity
      for (const candidate of byMode.get(source.mode) ?? []) {
        if (candidate.stop.id === source.stop.id) continue
        const matches = destination.cell ? candidate.ref.cell === destination.cell : !candidate.ref.cell && distance(candidate.ref.position, destination.position) <= cellSize / 4
        const away = distance(candidate.ref.position, destination.position)
        if (matches && away < best) {
          best = away
          target = candidate
        }
      }
      const x = at.position[0] / cellSize
      const y = at.position[1] / cellSize
      const id = target?.stop.id ?? `arrival:${source.mode}:${Math.round(x * 1000)}:${Math.round(y * 1000)}`
      addStop(id, at.position, destination.cell, source.mode, { anchor: at.anchor })
      addRoute({ from: source.stop.id, to: id, mode: source.mode, provider: named(source.actor), providerId: source.actor.id, conditional: script(source.actor)?.conditional || undefined })
    }
  }

  // Activators that move the player who carries an item, such as propylons.
  const pointId = (mode: TransportMode, cell: string, at: { position: Point; anchor?: Anchor }) =>
    at.anchor ? `anchor:${at.anchor.cells}` : cell ? `${mode}:${cell}` : `${mode}:${Math.round(at.position[0])}:${Math.round(at.position[1])}`
  for (const ref of references.values()) {
    const activator = activators.get(ref.actor)
    const facts = activator ? scripts.get(activator.script) : undefined
    if (!facts?.gates?.length) continue
    const from = place(ref.cell, ref.position)
    if (!from) continue
    for (const gate of facts.gates) {
      if (ref.cell && gate.to.cell === ref.cell) continue
      const to = place(gate.to.cell, gate.to.position)
      if (!to) continue
      const fromId = pointId(gate.mode, ref.cell, from)
      const toId = pointId(gate.mode, gate.to.cell, to)
      addStop(fromId, from.position, ref.cell, gate.mode, { anchor: from.anchor })
      addStop(toId, to.position, gate.to.cell, gate.mode, { anchor: to.anchor })
      addRoute({ from: fromId, to: toId, mode: gate.mode, providerId: '', items: items(gate.items) })
    }
  }

  // Transport offered in configured dialogue topics, from where the character stands.
  for (const route of dialogue) {
    const actor = actors.get(route.actor)
    const ref = placed.get(route.actor)?.[0]
    if (!actor || !ref || !available(actor)) continue
    const from = place(ref.cell, ref.position)
    const to = place(route.to.cell, route.to.position)
    if (!from || !to) continue
    const fromId = pointId(route.mode, ref.cell, from)
    const toId = pointId(route.mode, route.to.cell, to)
    addStop(fromId, from.position, ref.cell, route.mode, { provider: named(actor), anchor: from.anchor })
    addStop(toId, to.position, route.to.cell, route.mode, { anchor: to.anchor })
    addRoute({ from: fromId, to: toId, mode: route.mode, provider: named(actor), providerId: actor.id, items: items(route.items), dialogue: true, conditional: script(actor)?.conditional || undefined })
  }
  return { stops, routes }
}

/**
 * Names stops after the Location they are at: the Interior Entrance of their interior, or the
 * Settlement around them, falling back to the carrier and the Cell. Build it once per list.
 */
export function createStopNamer(locations: Location[], localName: (named: Named) => string = (named) => named.name): (stop: Pick<TransportStop, 'x' | 'y' | 'interior' | 'id' | 'provider'>) => string {
  const entrances = new Map<string, Location[]>()
  const settlements = new Map<string, Location[]>()
  const bucket = (map: Map<string, Location[]>, key: string, location: Location) => {
    const list = map.get(key)
    if (list) list.push(location)
    else map.set(key, [location])
  }
  for (const location of locations) {
    if (location.kind === 'entrance') bucket(entrances, location.en.toLowerCase(), location)
    else if (location.kind === 'settlement') {
      const cells = new Set([`${Math.floor(location.x)},${Math.floor(location.y)}`, ...(location.cells ?? []).map(([x, y]) => `${x},${y}`)])
      for (const cell of cells) bucket(settlements, cell, location)
    }
  }
  return (stop) => {
    if (stop.interior) {
      const entrance = entrances.get(stop.interior)?.find((location) => Math.hypot(location.x - stop.x, location.y - stop.y) <= 1)
      if (entrance) return entrance.name
      if (stop.id?.startsWith('propylon:')) return stop.interior.split(',')[0].replace(/\b\w/g, (letter) => letter.toUpperCase())
    }
    const x = Math.floor(stop.x)
    const y = Math.floor(stop.y)
    const nearby = new Set<Location>()
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const location of settlements.get(`${x + dx},${y + dy}`) ?? []) nearby.add(location)
    const candidates = [...nearby].filter((location) =>
      location.cells?.some(([cx, cy]) => cx === x && cy === y) || Math.hypot(location.x - stop.x, location.y - stop.y) <= 0.75)
    candidates.sort((a, b) => Math.hypot(a.x - stop.x, a.y - stop.y) - Math.hypot(b.x - stop.x, b.y - stop.y))
    return candidates[0]?.name ?? (stop.provider ? `${localName(stop.provider)} (${x}, ${y})` : `${x}, ${y}`)
  }
}

export function stopName(stop: Pick<TransportStop, 'x' | 'y' | 'interior' | 'id' | 'provider'>, locations: Location[], localName?: (named: Named) => string): string {
  return createStopNamer(locations, localName)(stop)
}
