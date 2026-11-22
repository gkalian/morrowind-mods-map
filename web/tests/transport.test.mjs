import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transformWithOxc } from 'vite'

const source = await readFile(new URL('../src/transport-data.ts', import.meta.url), 'utf8')
const compiled = (await transformWithOxc(source, 'transport-data.ts')).code
const { buildTransport, loadTransport, stopName, TRANSPORT_SCHEMA } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const manifest = { cellSize: 8192, sets: [{ id: 'base' }, { id: 'mod' }, { id: 'tr' }] }
const actor = (id, destinations, mode = 'land', extra = {}) => ({ id, name: id, mode, script: '', deleted: false, destinations, ...extra })
const ref = (key, name, x, cell = '', destination = null, deleted = false) => ({ key, actor: name, cell, position: [x, 0, 0], deleted, destination })
const destination = (x, cell = '') => ({ position: [x, 0, 0], cell })
const changes = (fields) => ({ actors: [], references: [], activators: [], scripts: [], dialogue: [], interventionReferences: [], ...fields })
const data = (sets, extra = {}) => ({ sets: new Map(Object.entries(sets).map(([id, fields]) => [id, changes(fields)])), anchors: [], items: new Map(), ...extra })
const routes = (network) => network.routes.map(({ from, to, mode }) => [from, to, mode])

test('keeps directed routes, converts coordinates and respects enabled sets', () => {
  const transport = data({
    base: { actors: [actor('carrier', [destination(-8192)])], references: [ref('one', 'carrier', 8192)] },
    mod: { actors: [actor('carrier', [])] },
  })
  const base = buildTransport(transport, manifest, new Set(['base']))
  assert.equal(base.routes.length, 1)
  assert.equal(base.stops.get('one').x, 1)
  assert.equal(base.stops.get(base.routes[0].to).x, -1)
  assert.equal(buildTransport(transport, manifest, new Set(['base', 'mod'])).routes.length, 0, 'the later set takes the destinations away')
})

test('uses the active reference override and honours deletion', () => {
  const transport = data({
    base: { actors: [actor('carrier', [destination(8192)])], references: [ref('one', 'carrier', 0)] },
    mod: { references: [ref('one', 'carrier', 16384)] },
  })
  assert.equal(buildTransport(transport, manifest, new Set(['base', 'mod'])).stops.get('one').x, 2)
  transport.sets.get('mod').references = [ref('one', '', 0, '', null, true)]
  assert.equal(buildTransport(transport, manifest, new Set(['base', 'mod'])).routes.length, 0)
})

test('leaves out carriers without a mode', () => {
  const transport = data({ base: { actors: [actor('thief', [destination(8192)], null)], references: [ref('one', 'thief', 0)] } })
  assert.equal(buildTransport(transport, manifest, new Set(['base'])).routes.length, 0)
})

test('follows interior doors to exterior and does not invent unreachable routes', () => {
  const transport = data({ base: {
    actors: [actor('guide', [destination(0, 'hall2'), destination(0, 'missing')], 'guild')],
    references: [ref('guide-ref', 'guide', 0, 'hall1'), ref('door1', 'door', 1, 'hall1', destination(8192)), ref('door2', 'door', 0, 'hall2', destination(-8192))],
  } })
  const network = buildTransport(transport, manifest, new Set(['base']))
  assert.equal(network.routes.length, 1)
  assert.equal(network.stops.get('guild:hall1').x, 1)
  assert.equal(network.stops.get(network.routes[0].to).x, -1)
})

test('groups guild guides in the same hall without losing their departures', () => {
  const transport = data({ base: {
    actors: [actor('first', [destination(-8192)], 'guild'), actor('second', [destination(16384)], 'guild')],
    references: [ref('a', 'first', 0, 'hall'), ref('b', 'second', 1, 'hall'), ref('door', 'door', 0, 'hall', destination(8192))],
  } })
  const network = buildTransport(transport, manifest, new Set(['base']))
  assert.equal(network.routes.filter((route) => route.from === 'guild:hall').length, 2)
  assert.equal([...network.stops.keys()].filter((id) => id === 'guild:hall').length, 1)
})

test('shows carriers only with the sets their script asks for', () => {
  const transport = data({ mod: {
    actors: [
      actor('needs-tr', [destination(8192)], 'water', { script: 'needs_tr_sc' }),
      actor('gone-with-tr', [destination(0)], 'water', { script: 'gone_with_tr_sc' }),
    ],
    references: [ref('a', 'needs-tr', 0), ref('b', 'gone-with-tr', 8192)],
    scripts: [{ id: 'needs_tr_sc', deleted: false, requires: ['tr'] }, { id: 'gone_with_tr_sc', deleted: false, excludedBy: ['tr'] }],
  } })
  assert.deepEqual(routes(buildTransport(transport, manifest, new Set(['mod']))).map(([from]) => from), ['b'])
  assert.deepEqual(routes(buildTransport(transport, manifest, new Set(['mod', 'tr']))).map(([from]) => from), ['a'])
})

test('moves a carrier where a script puts it once its set is enabled, matching the other end', () => {
  const transport = data({ mod: {
    actors: [actor('shipmaster', [destination(81920)], 'water'), actor('far', [destination(16384)], 'water')],
    references: [ref('ship', 'shipmaster', 0), ref('far-ref', 'far', 81920)],
    scripts: [{ id: 'start_sc', deleted: false, moves: [{ actor: 'shipmaster', set: 'tr', to: destination(16384) }] }],
  } })
  assert.equal(buildTransport(transport, manifest, new Set(['mod'])).stops.get('ship').x, 0)
  const moved = buildTransport(transport, manifest, new Set(['mod', 'tr']))
  assert.equal(moved.stops.get('ship').x, 2)
  assert.deepEqual(routes(moved), [['ship', 'far-ref', 'water'], ['far-ref', 'ship', 'water']])
})

test('marks routes of carriers that come and go with the game', () => {
  const transport = data({ base: {
    actors: [actor('colony', [destination(8192)], 'water', { script: 'colony_sc' })],
    references: [ref('c', 'colony', 0)],
    scripts: [{ id: 'colony_sc', deleted: false, conditional: true }],
  } })
  assert.equal(buildTransport(transport, manifest, new Set(['base'])).routes[0].conditional, true)
})

test('links gates by their script and names the items they need', () => {
  const transport = data({
    base: {
      activators: [{ id: 'portal', script: 'warp_b', deleted: false }],
      scripts: [{ id: 'warp_b', deleted: false, gates: [{ to: destination(0, 'hall-b'), items: ['index_b'], mode: 'propylon' }] }],
      references: [ref('portal-a', 'portal', 0, 'hall-a'), ref('door-a', 'door', 0, 'hall-a', destination(8192)), ref('door-b', 'door', 0, 'hall-b', destination(-8192))],
    },
    mod: { scripts: [{ id: 'warp_b', deleted: true }] },
  }, { items: new Map([['index_b', { name: 'B Index', ru: 'Метка B' }]]) })
  const base = buildTransport(transport, manifest, new Set(['base']))
  assert.deepEqual(routes(base), [['propylon:hall-a', 'propylon:hall-b', 'propylon']])
  assert.deepEqual(base.routes[0].items, [{ name: 'B Index', ru: 'Метка B' }])
  assert.equal(buildTransport(transport, manifest, new Set(['base', 'mod'])).routes.length, 0)
})

test('places dialogue transport to and from a place without exterior at its anchor', () => {
  const transport = data({ base: {
    actors: [actor('asciene', [], null), actor('effe', [], null)],
    references: [ref('a', 'asciene', 0, 'council'), ref('e', 'effe', 0, 'mournhold, palace'), ref('door', 'door', 0, 'council', destination(8192))],
    dialogue: [
      { actor: 'asciene', topic: 'transport to Mournhold', mode: 'magic', to: destination(100, 'mournhold, palace') },
      { actor: 'asciene', topic: 'transport to Mournhold', mode: 'magic', to: destination(100, 'mournhold, palace') },
      { actor: 'effe', topic: 'transport to Vvardenfell', mode: 'magic', to: destination(0, 'council') },
    ],
  } }, { anchors: [{ cells: 'mournhold', x: 23.5, y: -27.5, name: 'Mournhold', ru: 'Морнхолд' }] })
  const network = buildTransport(transport, manifest, new Set(['base']))
  assert.deepEqual(routes(network), [['magic:council', 'anchor:mournhold', 'magic'], ['anchor:mournhold', 'magic:council', 'magic']])
  const mournhold = network.stops.get('anchor:mournhold')
  assert.deepEqual([mournhold.x, mournhold.y, mournhold.approximate, mournhold.anchor.ru], [23.5, -27.5, true, 'Морнхолд'])
  assert.equal(network.stops.get('magic:council').x, 1)
  assert.ok(network.routes.every((route) => route.dialogue))
})

test('names stops after the place they are at and avoids guessing distant names', () => {
  const stop = { x: -1.1, y: -9.3, interior: '' }
  assert.equal(stopName(stop, [{ kind: 'settlement', x: -1.5, y: -9, cells: [[-2, -10]], name: 'Сейда Нин', en: 'Seyda Neen' }]), 'Сейда Нин')
  assert.equal(stopName(stop, [{ kind: 'settlement', x: 5, y: 5, name: 'Other', en: 'Other' }]), '-2, -10')
  assert.equal(stopName({ ...stop, provider: { name: 'Boat', ru: 'Лодка' } }, [], (named) => named.ru), 'Лодка (-2, -10)')
  assert.equal(stopName({ ...stop, id: 'propylon:romayon', interior: 'romayon, propylon chamber' }, [{ kind: 'settlement', x: -1.1, y: -9.3, name: 'Other', en: 'Other' }]), 'Romayon')
  assert.equal(stopName({ ...stop, interior: 'vivec, guild of mages' }, [{ kind: 'entrance', x: -1, y: -9, name: 'Гильдия магов', en: 'Vivec, Guild of Mages' }]), 'Гильдия магов')
})

test('keeps older maps usable and reports missing or outdated transport data', async () => {
  assert.equal(await loadTransport(manifest), null)
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: false, status: 404 })
    await assert.rejects(loadTransport({ ...manifest, transport: 'transport/index.json' }), /404/)
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, sets: [] }) })
    await assert.rejects(loadTransport({ ...manifest, transport: 'transport/index.json' }), /regenerate/)
    globalThis.fetch = async (url) => ({ ok: true, json: async () => (url.endsWith('index.json') ? { schemaVersion: TRANSPORT_SCHEMA, sets: ['base'], items: { x: { name: 'X' } } } : changes({})) })
    const loaded = await loadTransport({ ...manifest, transport: 'transport/index.json' })
    assert.deepEqual([[...loaded.sets.keys()], loaded.items.get('x').name, loaded.anchors], [['base'], 'X', []])
  } finally {
    globalThis.fetch = previousFetch
  }
})
