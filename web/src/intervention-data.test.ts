import { describe, expect, it } from 'vitest'
import { closestIntervention, interventionMarkers, type InterventionKind, type InterventionMarker } from './intervention-data'
import { manifest } from './test-helpers'
import type { TransportChanges, TransportData, TransportReference } from './transport-data'

const marker = (key: string, x: number, y: number, kind: InterventionKind = 'temple'): InterventionMarker => ({ key, x, y, kind })
const ref = (key: string, actor: string, x: number, y: number, extra: Partial<TransportReference> = {}): TransportReference =>
  ({ key, actor, cell: '', position: [x * 8192, y * 8192, 0], deleted: false, destination: null, ...extra })
const changes = (interventionReferences: TransportReference[]): TransportChanges =>
  ({ actors: [], references: [], activators: [], scripts: [], dialogue: [], interventionReferences })
const data = (sets: Record<string, TransportReference[]>): TransportData =>
  ({ sets: new Map(Object.entries(sets).map(([id, refs]) => [id, changes(refs)])), anchors: [], items: new Map() })

describe('closestIntervention', () => {
  it('searches square rings of Cells as OpenMW does, with negative Cells and ties', () => {
    const markers = [marker('east', 2.2, 0), marker('southwest', -1.2, -1.2), marker('south', 0, -0.2)]
    expect(closestIntervention(markers, 'temple', { x: 0.2, y: 0.2 })[0].key).toBe('south')
    // On one ring, the way round from the south-west corner decides.
    expect(closestIntervention([marker('sw', -1.2, -1.2), marker('se', 2.1, -1.1)], 'temple', { x: 0, y: 0 })[0].key).toBe('sw')
    expect(closestIntervention([marker('a', -0.8, -0.3), marker('b', -0.2, -0.1)], 'temple', { x: -0.5, y: -0.5 }).map((m) => m.key)).toEqual(['a', 'b'])
    expect(closestIntervention(markers, 'divine', { x: 0, y: 0 })).toEqual([])
  })

  it('walks every edge of the ring in order', () => {
    // All three on the first ring around Cell 0,0: east comes before north, north before west.
    const ring = [marker('west', -0.5, 0.5), marker('north', 0.5, 1.5), marker('east', 1.5, 0.5)]
    expect(closestIntervention(ring, 'temple', { x: 0.5, y: 0.5 })[0].key).toBe('east')
    expect(closestIntervention(ring.slice(0, 2), 'temple', { x: 0.5, y: 0.5 })[0].key).toBe('north')
    expect(closestIntervention(ring.slice(0, 1), 'temple', { x: 0.5, y: 0.5 })[0].key).toBe('west')
  })
})

describe('interventionMarkers', () => {
  it('applies enabled modules in load order and leaves interiors out', () => {
    const transport = data({
      base: [ref('base:1', 'templemarker', 0, 0), ref('base:2', 'divinemarker', 0, 0, { cell: 'mournhold' }), ref('base:3', 'divinemarker', 1, 2), ref('base:4', 'chair', 5, 5)],
      tr: [ref('tr:9', 'templemarker', 7, 8), ref('base:1', 'templemarker', 1, 1), ref('base:3', 'divinemarker', 1, 2, { deleted: true })],
    })
    const sets = manifest(['base', 'tr', 'missing'])
    expect(interventionMarkers(transport, sets, new Set(['base'])).map((m) => [m.key, m.kind, m.x])).toEqual([['base:1', 'temple', 0], ['base:3', 'divine', 1]])
    expect(interventionMarkers(transport, sets, new Set(['base', 'tr', 'missing'])).map((m) => [m.key, m.x])).toEqual([['base:1', 1], ['tr:9', 7]])
  })
})
