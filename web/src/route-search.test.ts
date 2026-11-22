import { describe, expect, it } from 'vitest'
import { findRoutes, type RouteOption } from './route-search'
import type { TransportMode, TransportNetwork, TransportRoute, TransportStop } from './transport-data'

const stop = (id: string, x: number, y = 0): TransportStop => ({ id, x, y, interior: '', modes: new Set() })
const ride = (from: string, to: string, mode: TransportMode = 'land'): TransportRoute => ({ from, to, mode, providerId: `${from}-${to}` })
const network = (stops: TransportStop[], routes: TransportRoute[]): TransportNetwork => ({ stops: new Map(stops.map((item) => [item.id, item])), routes })
const rides = (option: RouteOption) => option.steps.flatMap((step) => (step.route ? [step.route] : []))

describe('findRoutes', () => {
  it('finds directed routes and alternatives with walking transfers', () => {
    const graph = network([stop('a', 0), stop('b', 10), stop('c', 10.5), stop('d', 20), stop('e', 0, 1), stop('f', 20, 1)], [
      ride('a', 'b'), ride('c', 'd', 'water'), ride('e', 'f', 'guild'),
    ])
    const options = findRoutes(graph, { x: 0, y: 0 }, { x: 20, y: 0 })
    expect(options).toHaveLength(2)
    expect(options[0].rides).toBe(2)
    expect(options[0].walking).toBe(0.5)
    expect(rides(options[0]).map((route) => route.mode)).toEqual(['land', 'water'])
    expect(options[1].rides).toBe(1)
    expect(findRoutes(graph, { x: 20, y: 0 }, { x: 0, y: 0 })).toHaveLength(0)
  })

  it('does not invent transfers across distant or approximate stops', () => {
    const graph = network([stop('a', 0), stop('b', 10), stop('c', 12), stop('d', 22)], [ride('a', 'b'), ride('c', 'd')])
    expect(findRoutes(graph, { x: 0, y: 0 }, { x: 22, y: 0 })).toHaveLength(0)
    const c = graph.stops.get('c')!
    c.x = 10.5
    c.approximate = true
    expect(findRoutes(graph, { x: 0, y: 0 }, { x: 22, y: 0 })).toHaveLength(0)
  })

  it('does not walk from an approximate stop to nearby mainland stops', () => {
    const graph = network([{ ...stop('mournhold', 0), approximate: true }, stop('nearby', 0.2), stop('destination', 20)], [ride('nearby', 'destination')])
    expect(findRoutes(graph, { x: 0, y: 0, stopId: 'mournhold' }, { x: 20, y: 0 })).toHaveLength(0)
    graph.routes.push(ride('mournhold', 'destination', 'magic'))
    const options = findRoutes(graph, { x: 0, y: 0, stopId: 'mournhold' }, { x: 20, y: 0 })
    expect(options).toHaveLength(1)
    expect(rides(options[0])[0].mode).toBe('magic')
  })

  it('requires a ride and a stop within walking distance', () => {
    const graph = network([stop('a', 0), stop('b', 1)], [ride('a', 'b')])
    expect(findRoutes(network([...graph.stops.values()], []), { x: 0, y: 0 }, { x: 1, y: 0 })).toHaveLength(0)
    expect(findRoutes(graph, { x: 30, y: 0 }, { x: 1, y: 0 })).toHaveLength(0)
    expect(findRoutes(graph, { x: 0, y: 0 }, { x: 1, y: 0 }, 0)).toEqual([])
  })

  it('returns distinct alternatives ordered by their score', () => {
    const graph = network([stop('a', 0), stop('b', 20), stop('c', 0, 1), stop('d', 20, 1), stop('e', 0, 2), stop('f', 20, 2)], [
      ride('a', 'b'), ride('c', 'd'), ride('e', 'f'),
    ])
    const options = findRoutes(graph, { x: 0, y: 0 }, { x: 20, y: 0 })
    expect(options.map((option) => rides(option)[0].from)).toEqual(['a', 'c', 'e'])
    expect(options.every((option, index) => index === 0 || option.score >= options[index - 1].score)).toBe(true)
    expect(findRoutes(graph, { x: 0, y: 0 }, { x: 20, y: 0 }, 2)).toHaveLength(2)
  })
})
