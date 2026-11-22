import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transformWithOxc } from 'vite'

const source = await readFile(new URL('../src/intervention-data.ts', import.meta.url), 'utf8')
const compiled = (await transformWithOxc(source, 'intervention-data.ts')).code
const { closestIntervention, interventionMarkers } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const marker = (key, x, y, kind = 'temple') => ({ key, x, y, kind })
const ref = (key, actor, x, y, extra = {}) => ({ key, actor, cell: '', position: [x * 8192, y * 8192, 0], deleted: false, destination: null, ...extra })

test('uses the exterior-cell spiral, including negative cells and ties', () => {
  const markers = [marker('east', 2.2, 0), marker('southwest', -1.2, -1.2), marker('south', 0, -0.2)]
  assert.equal(closestIntervention(markers, 'temple', { x: 0.2, y: 0.2 })[0].key, 'south')
  assert.equal(closestIntervention([marker('sw', -1.2, -1.2), marker('se', 2.1, -1.1)], 'temple', { x: 0, y: 0 })[0].key, 'sw')
  assert.deepEqual(closestIntervention([marker('a', -0.8, -0.3), marker('b', -0.2, -0.1)], 'temple', { x: -0.5, y: -0.5 }).map((m) => m.key), ['a', 'b'])
  assert.deepEqual(closestIntervention(markers, 'divine', { x: 0, y: 0 }), [])
})

test('applies enabled modules in load order without leaking interiors', () => {
  const manifest = { cellSize: 8192, sets: [{ id: 'base' }, { id: 'tr' }] }
  const data = { sets: new Map([
    ['base', { interventionReferences: [ref('base:1', 'templemarker', 0, 0), ref('base:2', 'divinemarker', 0, 0, { cell: 'mournhold' }), ref('base:3', 'divinemarker', 1, 2)] }],
    ['tr', { interventionReferences: [ref('tr:9', 'templemarker', 7, 8), ref('base:1', 'templemarker', 1, 1), ref('base:3', 'divinemarker', 1, 2, { deleted: true })] }],
  ]) }
  assert.deepEqual(interventionMarkers(data, manifest, new Set(['base'])).map((m) => [m.key, m.x]), [['base:1', 0], ['base:3', 1]])
  assert.deepEqual(interventionMarkers(data, manifest, new Set(['base', 'tr'])).map((m) => [m.key, m.x]), [['base:1', 1], ['tr:9', 7]])
})
