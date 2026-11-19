import type { Manifest } from './manifest'
import type { Location } from './locations'

export type TransportMode = 'land' | 'water' | 'air' | 'guild' | 'magic' | 'propylon'
export interface Destination { position: [number, number, number]; cell: string }
export interface Actor { id: string; name: string; class: string; script: string; deleted: boolean; destinations: Destination[] }
export interface TransportReference { key: string; actor: string; cell: string; position: [number, number, number]; deleted: boolean; destination: Destination | null; location?: string }
export interface PropylonActivator { id: string; script: string; deleted: boolean }
export interface PropylonScript { id: string; destination: Destination | null; masterDestination?: Destination | null; requiredIndex: string | null; deleted: boolean }
export type SpecialLabel = 'transportMournhold'
export interface SpecialRoute { actor: string; from: Destination | null; to: Destination; mode: 'magic' | 'propylon'; condition: 'folmsMaster' | 'folms' | 'mournhold' | 'mournholdReturn'; fromLabel?: SpecialLabel | null; toLabel?: SpecialLabel | null }
export interface TransportChanges { actors: Actor[]; references: TransportReference[]; activators?: PropylonActivator[]; propylonScripts?: PropylonScript[]; specialRoutes?: SpecialRoute[]; interventionReferences?: TransportReference[]; interventionAddons?: { name: string; references: TransportReference[] }[]; conditionalRelocations?: { actor: string; requiredSet: string; position: [number, number, number] }[] }
export interface TransportData { sets: Map<string, TransportChanges> }
export interface TransportStop { id: string; x: number; y: number; interior: string; modes: Set<TransportMode>; provider: string; script: string; label?: SpecialLabel | null; approximate?: boolean }
export interface TransportRoute { from: string; to: string; mode: TransportMode; provider: string; providerId: string; script: string; requiredIndex?: string; condition?: SpecialRoute['condition'] }
export interface TransportNetwork { stops: Map<string, TransportStop>; routes: TransportRoute[] }

const REQUIRED_SETS: Record<string, string> = { pc_m1_annineshotn: 'shotn', pc_m1_kaltandoralistr: 'tr', sky_xre_kw_cascus: 'pc' }
const EXCLUDED_SETS: Record<string, string> = { pc_m1_kaltandoralis: 'tr' }

export async function loadTransport(manifest: Manifest): Promise<TransportData | null> {
  if (!manifest.transport) return null
  const response = await fetch(`data/${manifest.transport}`)
  if (!response.ok) throw new Error(`Transport index: ${response.status}`)
  const index = await response.json() as { schemaVersion: number; sets: string[] }
  if (index.schemaVersion !== 1 || !Array.isArray(index.sets)) throw new Error('Invalid transport index')
  const root = manifest.transport.slice(0, manifest.transport.lastIndexOf('/') + 1)
  const groups = await Promise.all(manifest.sets.filter((set) => index.sets.includes(set.id)).map(async (set) => {
    const file = await fetch(`data/${root}${encodeURIComponent(set.id)}.json`)
    if (!file.ok) throw new Error(`Transport data: ${file.status}`)
    const changes = await file.json() as TransportChanges
    if (!Array.isArray(changes.actors) || !Array.isArray(changes.references)) throw new Error('Invalid transport data')
    return [set.id, changes] as const
  }))
  return { sets: new Map(groups) }
}

export function modeOf(actor: Actor): TransportMode | null {
  const value = actor.class.toLowerCase()
  const id = actor.id.toLowerCase()
  if (['tr_m7_relenu drolan', 'tr_m7_ulath-bael'].includes(id)) return 'air'
  if (id === 'tr_m4_nassuran omoril') return 'land'
  if (value === 'guild guide' || id === 'tr_m1_daedrothgindaman') return 'guild'
  if (value === 'shipmaster' || value === 'gondolier' || value === 't_mw_riverstriderservice' || value === 't_glb_fisherman' || ['blatta hateria', 'vevrana aryon', 'rindral dralor', 'tr_m3_torosi moren'].includes(id)) return 'water'
  if (value === 'caravaner') return /skylamp/i.test(actor.name + ' ' + actor.id + ' ' + actor.script) ? null : 'land'
  if (value === 'slave' && /fasttravelslave/i.test(actor.script)) return 'land'
  return null
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function exterior(cell: string, position: [number, number, number], doors: Map<string, TransportReference[]>): [number, number, number] | null {
  if (!cell) return position
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

export function buildTransport(data: TransportData, manifest: Manifest, enabled: Set<string>): TransportNetwork {
  const actors = new Map<string, Actor>()
  const references = new Map<string, TransportReference>()
  const activators = new Map<string, PropylonActivator>()
  const scripts = new Map<string, PropylonScript>()
  const specialRoutes: SpecialRoute[] = []
  const relocations = new Map<string, [number, number, number]>()
  for (const set of manifest.sets) {
    if (!enabled.has(set.id)) continue
    const changes = data.sets.get(set.id)
    if (!changes) continue
    for (const actor of changes.actors) {
      if (actor.deleted) actors.delete(actor.id)
      else actors.set(actor.id, actor)
    }
    for (const reference of changes.references) {
      if (reference.deleted) references.delete(reference.key)
      else references.set(reference.key, reference)
    }
    for (const item of changes.activators ?? []) {
      if (item.deleted) activators.delete(item.id)
      else activators.set(item.id, item)
    }
    for (const script of changes.propylonScripts ?? []) {
      if (script.deleted) scripts.delete(script.id)
      else scripts.set(script.id, script)
    }
    specialRoutes.push(...(changes.specialRoutes ?? []).filter((route) => ['folmsMaster', 'folms', 'mournhold', 'mournholdReturn'].includes(route.condition)))
    for (const relocation of changes.conditionalRelocations ?? []) {
      if (enabled.has(relocation.requiredSet)) relocations.set(relocation.actor, relocation.position)
    }
  }
  const doors = new Map<string, TransportReference[]>()
  for (const ref of references.values()) {
    if (ref.destination && ref.cell) doors.set(ref.cell, [...(doors.get(ref.cell) ?? []), ref])
  }
  const stops = new Map<string, TransportStop>()
  const providers: { actor: Actor; ref: TransportReference; stop: TransportStop; mode: TransportMode }[] = []
  for (const original of references.values()) {
    const actor = actors.get(original.actor)
    if (!actor || !actor.destinations.length) continue
    if (REQUIRED_SETS[actor.id] && !enabled.has(REQUIRED_SETS[actor.id])) continue
    if (EXCLUDED_SETS[actor.id] && enabled.has(EXCLUDED_SETS[actor.id])) continue
    const relocated = relocations.get(actor.id)
    const ref = relocated ? { ...original, position: relocated, cell: '' } : original
    const mode = modeOf(actor)
    if (!mode) continue
    const position = exterior(ref.cell, ref.position, doors)
    if (!position) continue
    const id = mode === 'guild' && ref.cell ? `guild:${ref.cell}` : ref.key
    const stop: TransportStop = stops.get(id) ?? { id, x: position[0] / manifest.cellSize, y: position[1] / manifest.cellSize, interior: ref.cell, modes: new Set([mode]), provider: actor.name, script: actor.script }
    stops.set(id, stop)
    providers.push({ actor, ref, stop, mode })
  }
  const routes: TransportRoute[] = []
  for (const source of providers) {
    for (const destination of source.actor.destinations) {
      const position = exterior(destination.cell, destination.position, doors)
      if (!position) continue
      const candidates = providers.filter((target) => target.mode === source.mode && target.stop.id !== source.stop.id &&
        (destination.cell ? target.ref.cell === destination.cell : !target.ref.cell && distance(target.ref.position, destination.position) <= manifest.cellSize / 4))
      candidates.sort((a, b) => distance(a.ref.position, destination.position) - distance(b.ref.position, destination.position))
      const x = position[0] / manifest.cellSize
      const y = position[1] / manifest.cellSize
      const id = candidates[0]?.stop.id ?? `arrival:${source.mode}:${Math.round(x * 1000)}:${Math.round(y * 1000)}`
      if (!stops.has(id)) stops.set(id, { id, x, y, interior: destination.cell, modes: new Set([source.mode]), provider: '', script: '' })
      if (id !== source.stop.id) routes.push({ from: source.stop.id, to: id, mode: source.mode, provider: source.actor.name, providerId: source.actor.id, script: source.actor.script })
    }
  }
  const masterRoutes = new Set<string>()
  for (const reference of references.values()) {
    const item = activators.get(reference.actor)
    const script = item ? scripts.get(item.script) : undefined
    if (!script?.destination || !script.requiredIndex || !reference.cell || !script.destination.cell) continue
    const fromPosition = exterior(reference.cell, reference.position, doors)
    const toPosition = exterior(script.destination.cell, script.destination.position, doors)
    if (!fromPosition || !toPosition || reference.cell === script.destination.cell) continue
    const from = `propylon:${reference.cell}`
    const to = `propylon:${script.destination.cell}`
    if (!stops.has(from)) stops.set(from, { id: from, x: fromPosition[0] / manifest.cellSize, y: fromPosition[1] / manifest.cellSize, interior: reference.cell, modes: new Set(['propylon']), provider: '', script: '' })
    if (!stops.has(to)) stops.set(to, { id: to, x: toPosition[0] / manifest.cellSize, y: toPosition[1] / manifest.cellSize, interior: script.destination.cell, modes: new Set(['propylon']), provider: '', script: '' })
    routes.push({ from, to, mode: 'propylon', provider: '', providerId: '', script: '', requiredIndex: script.requiredIndex })
    if (script.masterDestination?.cell) {
      const masterPosition = exterior(script.masterDestination.cell, script.masterDestination.position, doors)
      const masterStop = `propylon:${script.masterDestination.cell}`
      if (masterPosition && !masterRoutes.has(`${from}|${masterStop}`)) {
        if (!stops.has(masterStop)) stops.set(masterStop, { id: masterStop, x: masterPosition[0] / manifest.cellSize, y: masterPosition[1] / manifest.cellSize, interior: script.masterDestination.cell, modes: new Set(['propylon']), provider: '', script: '' })
        routes.push({ from, to: masterStop, mode: 'propylon', provider: '', providerId: '', script: '', requiredIndex: 'Index_Master' })
        masterRoutes.add(`${from}|${masterStop}`)
      }
    }
  }
  for (const route of specialRoutes) {
    const actor = actors.get(route.actor)
    const ref = [...references.values()].find((item) => item.actor === route.actor)
    if (!actor || (!route.from && !ref)) continue
    const origin = route.from ?? { cell: ref!.cell, position: ref!.position }
    const fromPosition: [number, number, number] | null = route.condition === 'mournholdReturn' ? [23.5 * manifest.cellSize, -27.5 * manifest.cellSize, 0] : exterior(origin.cell, origin.position, doors)
    const approximate = route.condition === 'mournhold'
    const toPosition: [number, number, number] | null = approximate ? [23.5 * manifest.cellSize, -27.5 * manifest.cellSize, 0] : exterior(route.to.cell, route.to.position, doors)
    if (!fromPosition || !toPosition) continue
    const stopId = (point: Destination, pos: [number, number, number]) => route.mode === 'propylon' && point.cell
      ? `propylon:${point.cell}`
      : `special:${route.mode}:${Math.round(pos[0])}:${Math.round(pos[1])}`
    const from = route.condition === 'mournholdReturn' ? 'special:approximate:mournhold' : stopId(origin, fromPosition)
    const to = approximate ? 'special:approximate:mournhold' : stopId(route.to, toPosition)
    if (from === to || routes.some((item) => item.from === from && item.to === to && item.providerId === route.actor && item.mode === route.mode)) continue
    if (!stops.has(from)) stops.set(from, { id: from, x: fromPosition[0] / manifest.cellSize, y: fromPosition[1] / manifest.cellSize, interior: origin.cell, modes: new Set([route.mode]), provider: actor.name, script: '', label: route.fromLabel, approximate: route.condition === 'mournholdReturn' })
    if (!stops.has(to)) stops.set(to, { id: to, x: toPosition[0] / manifest.cellSize, y: toPosition[1] / manifest.cellSize, interior: route.to.cell, modes: new Set([route.mode]), provider: '', script: '', label: route.toLabel, approximate })
    routes.push({ from, to, mode: route.mode, provider: actor.name, providerId: route.actor, script: '', condition: route.condition })
  }
  return { stops, routes }
}

export function stopName(stop: TransportStop, locations: Location[]): string {
  if (stop.interior) {
    const entrance = locations.find((location) => location.kind === 'entrance' &&
      location.en.toLowerCase() === stop.interior && Math.hypot(location.x - stop.x, location.y - stop.y) <= 1)
    if (entrance) return entrance.name
    if (stop.id?.startsWith('propylon:')) {
      return stop.interior.split(',')[0].replace(/\b\w/g, (letter) => letter.toUpperCase())
    }
  }
  const candidates = locations.filter((location) => location.kind === 'settlement' &&
    (location.cells?.some(([x, y]) => x === Math.floor(stop.x) && y === Math.floor(stop.y)) || Math.hypot(location.x - stop.x, location.y - stop.y) <= 0.75))
  candidates.sort((a, b) => Math.hypot(a.x - stop.x, a.y - stop.y) - Math.hypot(b.x - stop.x, b.y - stop.y))
  return candidates[0]?.name ?? (stop.provider ? `${stop.provider} (${Math.floor(stop.x)}, ${Math.floor(stop.y)})` : `${Math.floor(stop.x)}, ${Math.floor(stop.y)}`)
}
