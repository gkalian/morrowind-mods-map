import type { TransportNetwork, TransportRoute, TransportStop } from './transport-data'

export interface RoutePoint { x: number; y: number; stopId?: string }
export interface RouteStep { from: RoutePoint; to: RoutePoint; route?: TransportRoute }
export interface RouteOption { steps: RouteStep[]; walking: number; rides: number; score: number }

const MAX_APPROACH = 8
const MAX_TRANSFER = 1.5
const RIDE_COST = 0.35

interface Edge { from: string; to: string; distance: number; route?: TransportRoute; key: string }
interface State { node: string; ridden: boolean; walking: boolean; cost: number; previous?: State; edge?: Edge }

function distance(a: RoutePoint, b: RoutePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function stateKey(state: State): string {
  return `${state.node}|${Number(state.ridden)}|${Number(state.walking)}`
}

function shortest(edges: Map<string, Edge[]>, banned: Set<string>): State | null {
  const start: State = { node: '@start', ridden: false, walking: false, cost: 0 }
  const queue: State[] = [start]
  const best = new Map<string, number>([[stateKey(start), 0]])
  while (queue.length) {
    queue.sort((a, b) => b.cost - a.cost)
    const current = queue.pop()!
    if (current.cost > (best.get(stateKey(current)) ?? Infinity)) continue
    if (current.node === '@end' && current.ridden) return current
    for (const edge of edges.get(current.node) ?? []) {
      if (banned.has(edge.key) || (!edge.route && current.walking)) continue
      const ridden = current.ridden || !!edge.route
      if (edge.to === '@end' && !ridden) continue
      const next: State = { node: edge.to, ridden, walking: !edge.route, cost: current.cost + (edge.route ? RIDE_COST : edge.distance), previous: current, edge }
      const key = stateKey(next)
      if (next.cost >= (best.get(key) ?? Infinity)) continue
      best.set(key, next.cost)
      queue.push(next)
    }
  }
  return null
}

export function findRoutes(network: TransportNetwork, from: RoutePoint, to: RoutePoint, limit = 3): RouteOption[] {
  if (limit <= 0) return []
  const usedStops = new Set(network.routes.flatMap((route) => [route.from, route.to]))
  const stops = [...network.stops.values()].filter((stop) => usedStops.has(stop.id))
  const points = new Map<string, RoutePoint>([['@start', from], ['@end', to], ...stops.map((stop): [string, TransportStop] => [stop.id, stop])])
  const edges = new Map<string, Edge[]>()
  function add(fromId: string, toId: string, route?: TransportRoute): void {
    const a = points.get(fromId)!
    const b = points.get(toId)!
    const key = route ? `ride|${route.mode}|${route.from}|${route.to}|${route.providerId}` : `walk|${fromId}|${toId}`
    const edge = { from: fromId, to: toId, distance: distance(a, b), route, key }
    edges.set(fromId, [...(edges.get(fromId) ?? []), edge])
  }
  for (const stop of stops) {
    if (from.stopId ? from.stopId === stop.id : distance(from, stop) <= MAX_APPROACH) add('@start', stop.id)
    if (to.stopId ? to.stopId === stop.id : distance(stop, to) <= MAX_APPROACH) add(stop.id, '@end')
    if (stop.approximate) continue
    for (const other of stops) {
      if (other.id !== stop.id && !other.approximate && distance(stop, other) <= MAX_TRANSFER) add(stop.id, other.id)
    }
  }
  for (const route of network.routes) {
    if (points.has(route.from) && points.has(route.to) && route.from !== route.to) add(route.from, route.to, route)
  }
  function option(state: State, banned: Set<string>): { value: RouteOption; rides: string[]; banned: Set<string> } {
    const path: Edge[] = []
    for (let at: State | undefined = state; at?.edge; at = at.previous) path.push(at.edge)
    path.reverse()
    return {
      value: { steps: path.map((edge) => ({ from: points.get(edge.from)!, to: points.get(edge.to)!, route: edge.route })), walking: path.filter((edge) => !edge.route).reduce((sum, edge) => sum + edge.distance, 0), rides: path.filter((edge) => edge.route).length, score: state.cost },
      rides: path.filter((edge) => edge.route).map((edge) => edge.key),
      banned,
    }
  }
  const first = shortest(edges, new Set())
  if (!first) return []
  const selected = [option(first, new Set())]
  const candidates = new Map<string, ReturnType<typeof option>>()
  const seen = new Set<string>([selected[0].rides.join('\n')])
  while (selected.length < limit) {
    for (const key of selected[selected.length - 1].rides) {
      const banned = new Set([...selected[selected.length - 1].banned, key])
      const alternative = shortest(edges, banned)
      if (!alternative) continue
      const candidate = option(alternative, banned)
      const signature = candidate.rides.join('\n')
      if (!seen.has(signature)) candidates.set(signature, candidate)
    }
    const next = [...candidates.entries()].sort((a, b) => a[1].value.score - b[1].value.score)[0]
    if (!next) break
    candidates.delete(next[0])
    seen.add(next[0])
    selected.push(next[1])
  }
  return selected.map((item) => item.value)
}
