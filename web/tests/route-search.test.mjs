import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transformWithOxc } from 'vite'

const source = await readFile(new URL('../src/route-search.ts', import.meta.url), 'utf8')
const compiled = (await transformWithOxc(source, 'route-search.ts')).code
const { findRoutes } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const stop = (id, x, y = 0) => ({ id, x, y })
const ride = (from, to, mode = 'land') => ({ from, to, mode, provider: '', providerId: `${from}-${to}`, script: '' })
const network = (stops, routes) => ({ stops: new Map(stops.map((item) => [item.id, item])), routes })

test('finds directed routes and alternatives with walking transfers', () => {
  const graph = network([stop('a', 0), stop('b', 10), stop('c', 10.5), stop('d', 20), stop('e', 0, 1), stop('f', 20, 1)], [
    ride('a', 'b'), ride('c', 'd', 'water'), ride('e', 'f', 'guild'),
  ])
  const options = findRoutes(graph, { x: 0, y: 0 }, { x: 20, y: 0 })
  assert.equal(options.length, 2)
  assert.equal(options[0].rides, 2)
  assert.equal(options[0].walking, 0.5)
  assert.deepEqual(options[0].steps.filter((step) => step.route).map((step) => step.route.mode), ['land', 'water'])
  assert.equal(options[1].rides, 1)
  assert.equal(findRoutes(graph, { x: 20, y: 0 }, { x: 0, y: 0 }).length, 0)
})

test('does not invent transfers across distant or approximate stops', () => {
  const graph = network([stop('a', 0), stop('b', 10), stop('c', 12), stop('d', 22)], [ride('a', 'b'), ride('c', 'd')])
  assert.equal(findRoutes(graph, { x: 0, y: 0 }, { x: 22, y: 0 }).length, 0)
  graph.stops.get('c').x = 10.5
  graph.stops.get('c').approximate = true
  assert.equal(findRoutes(graph, { x: 0, y: 0 }, { x: 22, y: 0 }).length, 0)
})

test('does not walk from an approximate destination to nearby mainland stops', () => {
  const graph = network([stop('mournhold', 0), stop('nearby', 0.2), stop('destination', 20)], [ride('nearby', 'destination')])
  graph.stops.get('mournhold').approximate = true
  assert.equal(findRoutes(graph, { x: 0, y: 0, stopId: 'mournhold' }, { x: 20, y: 0 }).length, 0)
  graph.routes.push(ride('mournhold', 'destination', 'magic'))
  const options = findRoutes(graph, { x: 0, y: 0, stopId: 'mournhold' }, { x: 20, y: 0 })
  assert.equal(options.length, 1)
  assert.equal(options[0].steps.find((step) => step.route).route.mode, 'magic')
})

test('requires a selected transport leg and nearby stops', () => {
  const graph = network([stop('a', 0), stop('b', 1)], [ride('a', 'b')])
  assert.equal(findRoutes(network([...graph.stops.values()], []), { x: 0, y: 0 }, { x: 1, y: 0 }).length, 0)
  assert.equal(findRoutes(graph, { x: 30, y: 0 }, { x: 1, y: 0 }).length, 0)
})

test('returns distinct alternatives ordered by the walking and ride score', () => {
  const graph = network([stop('a', 0), stop('b', 20), stop('c', 0, 1), stop('d', 20, 1), stop('e', 0, 2), stop('f', 20, 2)], [
    ride('a', 'b'), ride('c', 'd'), ride('e', 'f'),
  ])
  const options = findRoutes(graph, { x: 0, y: 0 }, { x: 20, y: 0 })
  assert.equal(options.length, 3)
  assert.deepEqual(options.map((option) => option.steps.find((step) => step.route).route.from), ['a', 'c', 'e'])
  assert.ok(options.every((option, index) => index === 0 || option.score >= options[index - 1].score))
})
