import type { Manifest } from './manifest'
import type { TransportData, TransportReference } from './transport-data'

export type InterventionKind = 'temple' | 'divine'
export interface InterventionMarker { key: string; kind: InterventionKind; x: number; y: number; location?: string }
export interface InterventionPoint { x: number; y: number }

export function interventionMarkers(data: TransportData, manifest: Manifest, enabled: Set<string>): InterventionMarker[] {
  const references = new Map<string, TransportReference>()
  const addons: { name: string; references: TransportReference[] }[] = []
  for (const set of manifest.sets) {
    if (!enabled.has(set.id)) continue
    const group = data.sets.get(set.id)
    if (!group) continue
    for (const ref of group.interventionReferences ?? []) {
      if (ref.deleted) references.delete(ref.key)
      else references.set(ref.key, ref)
    }
    addons.push(...(group.interventionAddons ?? []))
  }
  for (const addon of addons) {
    for (const ref of addon.references) {
      if (!references.has(ref.key) && !ref.key.startsWith(`${addon.name.toLowerCase()}:`)) continue
      if (ref.deleted) references.delete(ref.key)
      else references.set(ref.key, ref)
    }
  }
  return [...references.values()].flatMap((ref) => {
    const kind = ref.actor === 'templemarker' ? 'temple' : ref.actor === 'divinemarker' ? 'divine' : null
    return kind && !ref.cell ? [{ key: ref.key, kind, x: ref.position[0] / manifest.cellSize, y: ref.position[1] / manifest.cellSize, location: ref.location }] : []
  })
}

export function closestIntervention(markers: InterventionMarker[], kind: InterventionKind, point: InterventionPoint): InterventionMarker[] {
  const x = Math.floor(point.x)
  const y = Math.floor(point.y)
  let bestRadius = Infinity
  let bestRank = Infinity
  let result: InterventionMarker[] = []
  for (const marker of markers) {
    if (marker.kind !== kind) continue
    const dx = Math.floor(marker.x) - x
    const dy = Math.floor(marker.y) - y
    const radius = Math.max(Math.abs(dx), Math.abs(dy))
    const size = radius * 2
    const column = radius + dx
    const row = radius + dy
    const rank = row === 0 ? column : column === size ? size + row : row === size ? size * 3 - column : size * 4 - row
    if (radius < bestRadius || (radius === bestRadius && rank < bestRank)) {
      bestRadius = radius
      bestRank = rank
      result = [marker]
    } else if (radius === bestRadius && rank === bestRank) result.push(marker)
  }
  return result
}
