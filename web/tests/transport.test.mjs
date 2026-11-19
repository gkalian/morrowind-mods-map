import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transformWithOxc } from 'vite'

const source = await readFile(new URL('../src/transport-data.ts', import.meta.url), 'utf8')
const compiled = (await transformWithOxc(source, 'transport-data.ts')).code
const { buildTransport, loadTransport, modeOf, stopName } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const manifest = { cellSize: 8192, sets: [{ id: 'base' }, { id: 'mod' }] }
const actor = (id, destinations, mode = 'caravaner') => ({ id, name: id, class: mode, script: '', deleted: false, destinations })
const ref = (key, name, x, cell = '', destination = null, deleted = false) => ({ key, actor: name, cell, position: [x, 0, 0], deleted, destination })
const destination = (x, cell = '') => ({ position: [x, 0, 0], cell })

test('keeps directed routes, converts coordinates and respects enabled sets', () => {
  const data = { sets: new Map([
    ['base', { actors: [actor('carrier', [destination(-8192)])], references: [ref('one', 'carrier', 8192)] }],
    ['mod', { actors: [actor('carrier', [])], references: [] }],
  ]) }
  const base = buildTransport(data, manifest, new Set(['base']))
  assert.equal(base.routes.length, 1)
  assert.equal(base.stops.get('one').x, 1)
  assert.equal(base.stops.get(base.routes[0].to).x, -1)
  assert.equal(buildTransport(data, manifest, new Set(['base', 'mod'])).routes.length, 0)
})

test('uses the active reference override and honours deletion', () => {
  const carrier = actor('carrier', [destination(8192)])
  const data = { sets: new Map([
    ['base', { actors: [carrier], references: [ref('one', 'carrier', 0)] }],
    ['mod', { actors: [], references: [ref('one', 'carrier', 16384)] }],
  ]) }
  assert.equal(buildTransport(data, manifest, new Set(['base', 'mod'])).stops.get('one').x, 2)
  data.sets.get('mod').references = [ref('one', '', 0, '', null, true)]
  assert.equal(buildTransport(data, manifest, new Set(['base', 'mod'])).routes.length, 0)
})

test('follows interior doors to exterior and does not invent unreachable routes', () => {
  const data = { sets: new Map([['base', {
    actors: [actor('guide', [destination(0, 'hall2'), destination(0, 'missing')], 'guild guide')],
    references: [ref('guide-ref', 'guide', 0, 'hall1'), ref('door1', 'door', 1, 'hall1', destination(8192)), ref('door2', 'door', 0, 'hall2', destination(-8192))],
  }]]) }
  const network = buildTransport(data, manifest, new Set(['base']))
  assert.equal(network.routes.length, 1)
  assert.equal(network.stops.get('guild:hall1').x, 1)
  assert.equal(network.stops.get(network.routes[0].to).x, -1)
})

test('groups guild guides in the same hall without losing their departures', () => {
  const data = { sets: new Map([['base', {
    actors: [actor('first', [destination(-8192)], 'guild guide'), actor('second', [destination(16384)], 'guild guide')],
    references: [ref('a', 'first', 0, 'hall'), ref('b', 'second', 1, 'hall'), ref('door', 'door', 0, 'hall', destination(8192))],
  }]]) }
  const network = buildTransport(data, manifest, new Set(['base']))
  assert.equal(network.routes.length, 2)
  assert.equal(network.routes.filter((route) => route.from === 'guild:hall').length, 2)
  assert.equal([...network.stops.keys()].filter((id) => id === 'guild:hall').length, 1)
})

test('recognises transport modes and avoids guessing distant place names', () => {
  assert.equal(modeOf(actor('guide', [], 'guild guide')), 'guild')
  assert.equal(modeOf(actor('boat', [], 'shipmaster')), 'water')
  assert.equal(modeOf(actor('test', [], 'guard')), null)
  assert.equal(modeOf(actor('tr_m7_relenu drolan', [], 'caravaner')), 'air')
  const stop = { x: -1.1, y: -9.3 }
  assert.equal(stopName(stop, [{ kind: 'settlement', x: -1.5, y: -9, cells: [[-2, -10]], name: 'Сейда Нин' }]), 'Сейда Нин')
  assert.equal(stopName(stop, [{ kind: 'settlement', x: 5, y: 5, name: 'Other' }]), '-2, -10')
  assert.equal(stopName({ ...stop, id: 'propylon:romayon', interior: 'romayon, propylon chamber' },
    [{ kind: 'settlement', x: -1.1, y: -9.3, name: 'Other' }]), 'Romayon')
})

test('excludes a cross-mod service while its required set is disabled', () => {
  const data = { sets: new Map([['base', {
    actors: [actor('pc_m1_annineshotn', [destination(8192)], 'shipmaster')],
    references: [ref('boat', 'pc_m1_annineshotn', 0)],
  }]]) }
  const withSkyrim = { ...manifest, sets: [...manifest.sets, { id: 'shotn' }] }
  assert.equal(buildTransport(data, withSkyrim, new Set(['base'])).routes.length, 0)
  assert.equal(buildTransport(data, withSkyrim, new Set(['base', 'shotn'])).routes.length, 1)
})

test('relocates the Cyrodiil shipmaster and selects the matching destination when TR is enabled', () => {
  const withTr = { ...manifest, sets: [...manifest.sets, { id: 'tr' }] }
  const data = { sets: new Map([['mod', {
    actors: [
      actor('pc_m0_tituscorilex', [destination(81920)], 'shipmaster'),
      actor('pc_m1_kaltandoralis', [destination(0)], 'shipmaster'),
      actor('pc_m1_kaltandoralistr', [destination(16384)], 'shipmaster'),
    ],
    references: [ref('titus', 'pc_m0_tituscorilex', 0), ref('vanilla', 'pc_m1_kaltandoralis', 81920), ref('tr-variant', 'pc_m1_kaltandoralistr', 81920)],
    conditionalRelocations: [{ actor: 'pc_m0_tituscorilex', requiredSet: 'tr', position: [16384, 0, 0] }],
  }]]) }
  const normal = buildTransport(data, withTr, new Set(['base', 'mod']))
  assert.equal(normal.stops.get('titus').x, 0)
  assert.deepEqual(normal.routes.map((route) => [route.from, route.to]), [['titus', 'vanilla'], ['vanilla', 'titus']])
  const withMainland = buildTransport(data, withTr, new Set(['base', 'mod', 'tr']))
  assert.equal(withMainland.stops.get('titus').x, 2)
  assert.deepEqual(withMainland.routes.map((route) => [route.from, route.to]), [['titus', 'tr-variant'], ['tr-variant', 'titus']])
})

test('includes confirmed sky lantern and restricted caravan services only with their mod enabled', () => {
  const services = [
    actor('tr_m7_relenu drolan', [destination(8192)]),
    actor('tr_m7_ulath-bael', [destination(0)]),
    actor('tr_m4_nassuran omoril', [destination(24576)], 'merchant'),
    actor('tr_m4_othrys rorivel', [destination(16384)]),
  ]
  const data = { sets: new Map([['mod', { actors: services, references: [
    ref('sky-a', services[0].id, 0), ref('sky-b', services[1].id, 8192),
    ref('caravan-a', services[2].id, 16384), ref('caravan-b', services[3].id, 24576),
  ] }]]) }
  const network = buildTransport(data, manifest, new Set(['base', 'mod']))
  assert.deepEqual(network.routes.map(({ from, to, mode }) => ({ from, to, mode })), [
    { from: 'sky-a', to: 'sky-b', mode: 'air' },
    { from: 'sky-b', to: 'sky-a', mode: 'air' },
    { from: 'caravan-a', to: 'caravan-b', mode: 'land' },
    { from: 'caravan-b', to: 'caravan-a', mode: 'land' },
  ])
  assert.equal(buildTransport(data, manifest, new Set(['base'])).routes.length, 0)
})

test('keeps Folms travel and ignores quest-only routes from older transport data', () => {
  const data = { sets: new Map([['mod', {
    actors: [actor('folms mirel', []), actor('sailor', [])],
    references: [ref('folms', 'folms mirel', 0, 'caldera'), ref('door', 'door', 0, 'caldera', destination(8192)), ref('fort-door', 'door', 0, 'fort', destination(16384)), ref('boat', 'sailor', 32768)],
    specialRoutes: [
      { actor: 'folms mirel', from: null, to: destination(0, 'fort'), mode: 'propylon', condition: 'folmsMaster' },
      { actor: 'sailor', from: null, to: destination(40960), mode: 'water', condition: 'questNight' },
      { actor: 'sailor', from: null, to: destination(49152), mode: 'water', condition: 'questVoyage' },
      { actor: 'sailor', from: null, to: destination(57344), mode: 'water', condition: 'firemothQuest' },
    ],
  }]]) }
  const network = buildTransport(data, manifest, new Set(['base', 'mod']))
  assert.equal(network.routes.length, 1)
  assert.deepEqual(network.routes.map(({ from, to, condition }) => ({ from, to, condition })), [
    { from: 'propylon:caldera', to: 'propylon:fort', condition: 'folmsMaster' },
  ])
  assert.equal(buildTransport(data, manifest, new Set(['base'])).routes.length, 0)
})

test('locates the departure and places Mournhold approximately on the mainland backdrop', () => {
  const data = { sets: new Map([['base', {
    actors: [actor('asciene rane', []), actor('effe_tei', [])],
    references: [ref('asciene', 'asciene rane', 0, 'council'), ref('effe', 'effe_tei', 0, 'mournhold'), ref('door', 'door', 0, 'council', destination(8192))],
    specialRoutes: [
      { actor: 'asciene rane', from: null, to: destination(100, 'mournhold'), mode: 'magic', condition: 'mournhold', toLabel: 'transportMournhold' },
      { actor: 'effe_tei', from: null, to: destination(0, 'council'), mode: 'magic', condition: 'mournholdReturn', fromLabel: 'transportMournhold' },
    ],
  }]]) }
  const network = buildTransport(data, manifest, new Set(['base']))
  assert.equal(network.routes.length, 2)
  const route = network.routes[0]
  assert.equal(route.mode, 'magic')
  assert.equal(network.stops.get(route.from).x, 1)
  assert.equal(network.stops.get(route.to).label, 'transportMournhold')
  assert.equal(network.stops.get(route.to).approximate, true)
  assert.equal(network.stops.get(route.to).x, 23.5)
  assert.equal(network.stops.get(route.to).y, -27.5)
  assert.deepEqual([network.routes[1].from, network.routes[1].to], [route.to, route.from])
})

test('keeps older maps usable and reports missing transport data', async () => {
  assert.equal(await loadTransport(manifest), null)
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 404 })
  try {
    await assert.rejects(loadTransport({ ...manifest, transport: 'transport/index.json' }), /404/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('draws only explicit propylon links and preserves the required index', () => {
  const data = { sets: new Map([
    ['base', {
      actors: [],
      activators: [{ id: 'portal', script: 'warp_b', deleted: false }],
      propylonScripts: [{ id: 'warp_b', destination: destination(0, 'hall-b'), requiredIndex: 'Index_B', deleted: false }],
      references: [ref('portal-a', 'portal', 0, 'hall-a'), ref('door-a', 'door', 0, 'hall-a', destination(8192)), ref('door-b', 'door', 0, 'hall-b', destination(-8192))],
    }],
    ['mod', { actors: [], references: [], propylonScripts: [{ id: 'warp_b', destination: null, requiredIndex: null, deleted: true }] }],
  ]) }
  const base = buildTransport(data, manifest, new Set(['base']))
  assert.equal(base.routes.length, 1)
  assert.deepEqual({ from: base.routes[0].from, to: base.routes[0].to, index: base.routes[0].requiredIndex, mode: base.routes[0].mode },
    { from: 'propylon:hall-a', to: 'propylon:hall-b', index: 'Index_B', mode: 'propylon' })
  assert.equal(buildTransport(data, manifest, new Set(['base', 'mod'])).routes.length, 0)
})

test('adds one master-index route to Caldera per chamber without inventing a return trip', () => {
  const data = { sets: new Map([['base', {
    actors: [],
    activators: [
      { id: 'portal-b', script: 'warp_b', deleted: false },
      { id: 'portal-c', script: 'warp_c', deleted: false },
    ],
    propylonScripts: [
      { id: 'warp_b', destination: destination(0, 'hall-b'), masterDestination: destination(0, 'caldera'), requiredIndex: 'Index_B', deleted: false },
      { id: 'warp_c', destination: destination(0, 'hall-c'), masterDestination: destination(0, 'caldera'), requiredIndex: 'Index_C', deleted: false },
    ],
    references: [
      ref('portal-a1', 'portal-b', 0, 'hall-a'), ref('portal-a2', 'portal-c', 1, 'hall-a'),
      ref('door-a', 'door', 0, 'hall-a', destination(8192)), ref('door-b', 'door', 0, 'hall-b', destination(-8192)),
      ref('door-c', 'door', 0, 'hall-c', destination(16384)), ref('door-caldera', 'door', 0, 'caldera', destination(24576)),
    ],
  }]]) }
  const network = buildTransport(data, manifest, new Set(['base']))
  const master = network.routes.filter((route) => route.requiredIndex === 'Index_Master')
  assert.equal(master.length, 1)
  assert.deepEqual([master[0].from, master[0].to], ['propylon:hall-a', 'propylon:caldera'])
  assert.equal(network.routes.filter((route) => route.requiredIndex !== 'Index_Master').length, 2)
  assert.equal(network.routes.some((route) => route.from === 'propylon:caldera'), false)
})
