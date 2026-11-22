import type L from 'leaflet'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cellGrid, regionTint } from './overlays'
import { location } from './test-helpers'

/** What the layers draw: the light browser has no canvas, so a stand-in records the calls. */
let drawn: { fills: [string, number, number, number, number][]; texts: string[] }

beforeEach(() => {
  drawn = { fills: [], texts: [] }
  const context = {
    fillStyle: '',
    font: '',
    textBaseline: '',
    fillRect(x: number, y: number, width: number, height: number) {
      drawn.fills.push([this.fillStyle, x, y, width, height])
    },
    fillText(text: string) {
      drawn.texts.push(text)
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
})

const tile = (layer: L.GridLayer, x: number, y: number, z: number) =>
  (layer as unknown as { createTile(coords: { x: number; y: number; z: number }): HTMLCanvasElement }).createTile({ x, y, z })

describe('region colours', () => {
  it('fills the Cells of each Region, the later Region winning a shared Cell', () => {
    const regions = [
      location('region', 'West Gash', 0, 0, { color: '#111111', cells: [[0, 0], [1, 0]] }),
      location('region', 'Ashlands', 0, 0, { color: '#222222', cells: [[1, 0]] }),
      location('region', 'Uncoloured', 0, 0, { cells: [[0, 5]] }),
    ]
    // At zoom 7 a Cell is 128 pixels; the tile at row -1 holds the Cells of rows 0 and 1 above it.
    const canvas = tile(regionTint(regions, 11), 0, -1, 7)
    expect([canvas.width, canvas.height]).toEqual([256, 256])
    expect(drawn.fills).toEqual([['#111111', 0, 128, 128, 128], ['#222222', 128, 128, 128, 128]])
    tile(regionTint(regions, 11), 0, -3, 7)
    expect(drawn.fills.at(-1)).toEqual(['#000', 0, 0, 128, 128])
  })
})

describe('the Cell grid', () => {
  it('draws nothing while Cells are small', () => {
    tile(cellGrid(11), 0, 0, 4)
    expect(drawn.fills).toEqual([])
  })

  it('draws the boundaries, and the coordinates once there is room for them', () => {
    tile(cellGrid(11), 0, 0, 6)
    expect([drawn.fills.length, drawn.texts]).toEqual([8, []])
    drawn.fills = []
    // The same Cells as the Region colours: the tile at row -1 holds rows 1 and 0.
    tile(cellGrid(11), 1, -1, 7)
    expect(drawn.texts).toEqual(['2, 1', '2, 0', '3, 1', '3, 0'])
  })
})
