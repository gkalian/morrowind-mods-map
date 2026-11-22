import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFetch, location, manifest } from './test-helpers'
import {
  buildTransport,
  createStopNamer,
  loadTransport,
  stopName,
  TRANSPORT_SCHEMA,
  type Actor,
  type Anchor,
  type Destination,
  type Named,
  type TransportChanges,
  type TransportData,
  type TransportMode,
  type TransportNetwork,
  type TransportReference,
} from './transport-data'

const sets = manifest(['base', 'mod', 'tr'])
const actor = (id: string, destinations: Destination[], mode: TransportMode | null = 'land', extra: Partial<Actor> = {}): Actor =>
  ({ id, name: id, mode, script: '', deleted: false, destinations, ...extra })
const ref = (key: string, name: string, x: number, cell = '', destination: Destination | null = null, deleted = false): TransportReference =>
  ({ key, actor: name, cell, position: [x, 0, 0], deleted, destination })
const destination = (x: number, cell = ''): Destination => ({ position: [x, 0, 0], cell })
const changes = (fields: Partial<TransportChanges>): TransportChanges =>
  ({ actors: [], references: [], activators: [], scripts: [], dialogue: [], interventionReferences: [], ...fields })
const data = (groups: Record<string, Partial<TransportChanges>>, extra: Partial<TransportData> = {}): TransportData =>
  ({ sets: new Map(Object.entries(groups).map(([id, fields]) => [id, changes(fields)])), anchors: [], items: new Map(), ...extra })
const routes = (network: TransportNetwork) => network.routes.map(({ from, to, mode }) => [from, to, mode])
const build = (transport: TransportData, enabled: string[]) => buildTransport(transport, sets, new Set(enabled))

describe('buildTransport', () => {
  it('keeps directed routes, converts coordinates and respects enabled sets', () => {
    const transport = data({
      base: { actors: [actor('carrier', [destination(-8192)])], references: [ref('one', 'carrier', 8192)] },
      mod: { actors: [actor('carrier', [])] },
    })
    const base = build(transport, ['base'])
    expect(base.routes).toHaveLength(1)
    expect(base.stops.get('one')!.x).toBe(1)
    expect(base.stops.get(base.routes[0].to)!.x).toBe(-1)
    expect(build(transport, ['base', 'mod']).routes, 'the later set takes the destinations away').toHaveLength(0)
  })

  it('uses the active reference override and honours deletion', () => {
    const transport = data({
      base: { actors: [actor('carrier', [destination(8192)])], references: [ref('one', 'carrier', 0)] },
      mod: { references: [ref('one', 'carrier', 16384)] },
    })
    expect(build(transport, ['base', 'mod']).stops.get('one')!.x).toBe(2)
    transport.sets.get('mod')!.references = [ref('one', '', 0, '', null, true)]
    expect(build(transport, ['base', 'mod']).routes).toHaveLength(0)
    transport.sets.get('mod')!.actors = [actor('carrier', [], 'land', { deleted: true })]
    expect(build(transport, ['base', 'mod']).routes).toHaveLength(0)
  })

  it('leaves out carriers without a mode', () => {
    const transport = data({ base: { actors: [actor('thief', [destination(8192)], null)], references: [ref('one', 'thief', 0)] } })
    expect(build(transport, ['base']).routes).toHaveLength(0)
  })

  it('follows interior doors to the exterior and does not invent unreachable routes', () => {
    const transport = data({ base: {
      actors: [actor('guide', [destination(0, 'hall2'), destination(0, 'missing')], 'guild')],
      references: [ref('guide-ref', 'guide', 0, 'hall1'), ref('door1', 'door', 1, 'hall1', destination(8192)), ref('door2', 'door', 0, 'hall2', destination(-8192))],
    } })
    const network = build(transport, ['base'])
    expect(network.routes).toHaveLength(1)
    expect(network.stops.get('guild:hall1')!.x).toBe(1)
    expect(network.stops.get(network.routes[0].to)!.x).toBe(-1)
  })

  it('takes a door straight out before going deeper, and goes through several interiors if it must', () => {
    const transport = data({ base: {
      actors: [actor('guide', [destination(8192)], 'guild')],
      references: [
        ref('g', 'guide', 0, 'inner'),
        ref('far', 'door', 5000, 'inner', destination(-16384)),
        ref('near', 'door', 10, 'inner', destination(0, 'hall')),
        ref('out', 'door', 0, 'hall', destination(24576)),
      ],
    } })
    expect(build(transport, ['base']).stops.get('guild:inner')!.x).toBe(-2)
    transport.sets.get('base')!.references = transport.sets.get('base')!.references.filter((item) => item.key !== 'far')
    expect(build(transport, ['base']).stops.get('guild:inner')!.x).toBe(3)
  })

  it('groups guild guides in the same hall without losing their departures', () => {
    const transport = data({ base: {
      actors: [actor('first', [destination(-8192)], 'guild'), actor('second', [destination(16384)], 'guild')],
      references: [ref('a', 'first', 0, 'hall'), ref('b', 'second', 1, 'hall'), ref('door', 'door', 0, 'hall', destination(8192))],
    } })
    const network = build(transport, ['base'])
    expect(network.routes.filter((route) => route.from === 'guild:hall')).toHaveLength(2)
    expect([...network.stops.keys()].filter((id) => id === 'guild:hall')).toHaveLength(1)
  })

  it('shows carriers only with the sets their script asks for', () => {
    const transport = data({ mod: {
      actors: [
        actor('needs-tr', [destination(8192)], 'water', { script: 'needs_tr_sc' }),
        actor('gone-with-tr', [destination(0)], 'water', { script: 'gone_with_tr_sc' }),
      ],
      references: [ref('a', 'needs-tr', 0), ref('b', 'gone-with-tr', 8192)],
      scripts: [{ id: 'needs_tr_sc', deleted: false, requires: ['tr'] }, { id: 'gone_with_tr_sc', deleted: false, excludedBy: ['tr'] }],
    } })
    expect(routes(build(transport, ['mod'])).map(([from]) => from)).toEqual(['b'])
    expect(routes(build(transport, ['mod', 'tr'])).map(([from]) => from)).toEqual(['a'])
  })

  it('moves a carrier where a script puts it once its set is enabled, meeting the other end', () => {
    const transport = data({ mod: {
      actors: [actor('shipmaster', [destination(81920)], 'water'), actor('far', [destination(16384)], 'water')],
      references: [ref('ship', 'shipmaster', 0), ref('far-ref', 'far', 81920)],
      scripts: [{ id: 'start_sc', deleted: false, moves: [{ actor: 'shipmaster', set: 'tr', to: destination(16384) }] }],
    } })
    expect(build(transport, ['mod']).stops.get('ship')!.x).toBe(0)
    const moved = build(transport, ['mod', 'tr'])
    expect(moved.stops.get('ship')!.x).toBe(2)
    expect(routes(moved)).toEqual([['ship', 'far-ref', 'water'], ['far-ref', 'ship', 'water']])
  })

  it('marks routes of carriers that come and go with the game', () => {
    const transport = data({ base: {
      actors: [actor('colony', [destination(8192)], 'water', { script: 'colony_sc' })],
      references: [ref('c', 'colony', 0)],
      scripts: [{ id: 'colony_sc', deleted: false, conditional: true }],
    } })
    expect(build(transport, ['base']).routes[0].conditional).toBe(true)
  })

  it('links gates by their script and names the items they need', () => {
    const transport = data({
      base: {
        activators: [{ id: 'portal', script: 'warp_b', deleted: false }],
        scripts: [{ id: 'warp_b', deleted: false, gates: [
          { to: destination(0, 'hall-b'), items: ['index_b'], mode: 'propylon' },
          { to: destination(0, 'hall-a'), items: ['index_a'], mode: 'propylon' },
        ] }],
        references: [ref('portal-a', 'portal', 0, 'hall-a'), ref('door-a', 'door', 0, 'hall-a', destination(8192)), ref('door-b', 'door', 0, 'hall-b', destination(-8192))],
      },
      mod: { scripts: [{ id: 'warp_b', deleted: true }] },
    }, { items: new Map<string, Named>([['index_b', { name: 'B Index', ru: 'Метка B' }]]) })
    const base = build(transport, ['base'])
    expect(routes(base), 'no gate back into the hall it stands in').toEqual([['propylon:hall-a', 'propylon:hall-b', 'propylon']])
    expect(base.routes[0].items).toEqual([{ name: 'B Index', ru: 'Метка B' }])
    expect(build(transport, ['base', 'mod']).routes).toHaveLength(0)
  })

  it('places transport to and from a place without exterior at its anchor', () => {
    const anchor: Anchor = { cells: 'mournhold', x: 23.5, y: -27.5, name: 'Mournhold', ru: 'Морнхолд' }
    const transport = data({ base: {
      actors: [actor('asciene', [], null), actor('effe', [], null), actor('silent', [], null)],
      references: [ref('a', 'asciene', 0, 'council'), ref('e', 'effe', 0, 'mournhold, palace'), ref('door', 'door', 0, 'council', destination(8192))],
      dialogue: [
        { actor: 'asciene', topic: 'transport to Mournhold', mode: 'magic', to: destination(100, 'mournhold, palace') },
        { actor: 'asciene', topic: 'transport to Mournhold', mode: 'magic', to: destination(100, 'mournhold, palace') },
        { actor: 'effe', topic: 'transport to Vvardenfell', mode: 'magic', to: destination(0, 'council') },
        { actor: 'silent', topic: 'nowhere', mode: 'magic', to: destination(0) },
      ],
    } }, { anchors: [anchor] })
    const network = build(transport, ['base'])
    expect(routes(network)).toEqual([['magic:council', 'anchor:mournhold', 'magic'], ['anchor:mournhold', 'magic:council', 'magic']])
    const mournhold = network.stops.get('anchor:mournhold')!
    expect([mournhold.x, mournhold.y, mournhold.approximate, mournhold.anchor?.ru]).toEqual([23.5, -27.5, true, 'Морнхолд'])
    expect(network.stops.get('magic:council')!.x).toBe(1)
    expect(network.routes.every((route) => route.dialogue)).toBe(true)
  })

  it('leaves out an arrival nobody waits at as a stop of its own', () => {
    const transport = data({ base: { actors: [actor('boat', [destination(40960)], 'water')], references: [ref('b', 'boat', 0)] } })
    const network = build(transport, ['base'])
    expect(network.routes[0].to).toBe('arrival:water:5000:0')
  })
})

describe('stop names', () => {
  const stop = { id: 'stop', x: -1.1, y: -9.3, interior: '' }

  it('names a stop after the Settlement it is in or next to', () => {
    expect(stopName(stop, [location('settlement', 'Seyda Neen', -1.5, -9, { name: 'Сейда Нин', cells: [[-2, -10]] })])).toBe('Сейда Нин')
    expect(stopName(stop, [location('settlement', 'Near', -1.3, -9.1)])).toBe('Near')
    expect(stopName(stop, [location('settlement', 'Far', -1.6, -9.0, { cells: [[5, 5]] }), location('settlement', 'Nearer', -1.2, -9.3)])).toBe('Nearer')
  })

  it('does not guess a distant name and falls back to the carrier and the Cell', () => {
    expect(stopName(stop, [location('settlement', 'Other', 5, 5)])).toBe('-2, -10')
    expect(stopName({ ...stop, provider: { name: 'Boat', ru: 'Лодка' } }, [], (named) => named.ru ?? named.name)).toBe('Лодка (-2, -10)')
    expect(stopName({ ...stop, provider: { name: 'Boat' } }, [])).toBe('Boat (-2, -10)')
  })

  it('names an interior after its Interior Entrance, or a propylon after its place', () => {
    expect(stopName({ ...stop, interior: 'vivec, guild of mages' }, [location('entrance', 'Vivec, Guild of Mages', -1, -9, { name: 'Гильдия магов' })])).toBe('Гильдия магов')
    expect(stopName({ ...stop, id: 'propylon:romayon', interior: 'romayon, propylon chamber' }, [location('settlement', 'Other', -1.1, -9.3)])).toBe('Romayon')
  })

  it('builds the index once for many stops', () => {
    const namer = createStopNamer([location('settlement', 'A', 0.5, 0.5), location('settlement', 'B', 10.5, 10.5)])
    expect([namer({ id: 'a', x: 0.6, y: 0.4, interior: '' }), namer({ id: 'b', x: 10.4, y: 10.6, interior: '' })]).toEqual(['A', 'B'])
  })
})

describe('loadTransport', () => {
  afterEach(() => vi.unstubAllGlobals())
  const withTransport = manifest(['base', 'mod'], { transport: 'transport/index.json' })

  it('keeps older maps usable', async () => {
    expect(await loadTransport(sets)).toBeNull()
  })

  it('reports missing, outdated or broken data', async () => {
    vi.stubGlobal('fetch', fakeFetch({}))
    await expect(loadTransport(withTransport)).rejects.toThrow(/404/)
    vi.stubGlobal('fetch', fakeFetch({ 'index.json': { schemaVersion: 1, sets: [] } }))
    await expect(loadTransport(withTransport)).rejects.toThrow(/regenerate/)
    vi.stubGlobal('fetch', fakeFetch({ 'index.json': { schemaVersion: TRANSPORT_SCHEMA, sets: ['base'] } }))
    await expect(loadTransport(withTransport)).rejects.toThrow(/Transport data: 404/)
    vi.stubGlobal('fetch', fakeFetch({ 'index.json': { schemaVersion: TRANSPORT_SCHEMA, sets: ['base'] }, 'base.json': { actors: 'none' } }))
    await expect(loadTransport(withTransport)).rejects.toThrow(/Invalid/)
  })

  it('loads the sets the index lists, with anchors and item names', async () => {
    vi.stubGlobal('fetch', fakeFetch({
      'index.json': { schemaVersion: TRANSPORT_SCHEMA, sets: ['base'], items: { x: { name: 'X' } }, anchors: [{ cells: 'm', x: 1, y: 2, name: 'M' }] },
      'base.json': changes({}),
    }))
    const loaded = (await loadTransport(withTransport))!
    expect([[...loaded.sets.keys()], loaded.items.get('x')?.name, loaded.anchors[0].name]).toEqual([['base'], 'X', 'M'])
  })
})
