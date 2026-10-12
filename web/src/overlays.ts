import L from 'leaflet'
import type { Location } from './locations'

type TileLayerClass = new (options?: L.GridLayerOptions) => L.GridLayer

const TINT_OPACITY = 0.38

/**
 * Colours the Cells of the given Regions. Where two Regions claim a Cell, the later one in the
 * list wins, so pass them in Plugin Set order.
 */
export function regionTint(regions: Location[], maxZoom: number): L.GridLayer {
  const colours = new Map<string, string>()
  for (const region of regions) {
    for (const [x, y] of region.cells ?? []) colours.set(`${x},${y}`, region.color ?? '#000')
  }

  const Layer = L.GridLayer.extend({
    createTile(coords: L.Coords): HTMLCanvasElement {
      const tile = document.createElement('canvas')
      tile.width = tile.height = 256
      const context = tile.getContext('2d')!
      const cell = 2 ** coords.z
      const left = coords.x * 256
      const top = coords.y * 256
      for (let column = Math.floor(left / cell); column * cell < left + 256; column++) {
        // Rows grow southwards on screen and northwards in the game.
        for (let row = Math.floor(top / cell); row * cell < top + 256; row++) {
          const colour = colours.get(`${column},${-row - 1}`)
          if (!colour) continue
          context.fillStyle = colour
          context.fillRect(column * cell - left, row * cell - top, cell, cell)
        }
      }
      return tile
    },
  }) as unknown as TileLayerClass

  return new Layer({ tileSize: 256, maxZoom, opacity: TINT_OPACITY, updateWhenZooming: false, zIndex: 100 })
}

/** Cell boundaries are drawn once a Cell is at least this many pixels wide. */
const GRID_MIN_CELL = 32
/** Cell coordinates are written once a Cell is at least this many pixels wide. */
const GRID_LABEL_MIN_CELL = 128

/** Lines along the Cell boundaries, with each Cell's coordinates when there is room. */
export function cellGrid(maxZoom: number): L.GridLayer {
  const Layer = L.GridLayer.extend({
    createTile(coords: L.Coords): HTMLCanvasElement {
      const tile = document.createElement('canvas')
      tile.width = tile.height = 256
      const cell = 2 ** coords.z
      if (cell < GRID_MIN_CELL) return tile

      const context = tile.getContext('2d')!
      context.fillStyle = 'rgb(255 255 255 / 28%)'
      const left = coords.x * 256
      const top = coords.y * 256
      // First boundary at or after the tile's edge, in tile pixels.
      const firstX = ((-left % cell) + cell) % cell
      const firstY = ((-top % cell) + cell) % cell
      for (let x = firstX; x < 256; x += cell) context.fillRect(x, 0, 1, 256)
      for (let y = firstY; y < 256; y += cell) context.fillRect(0, y, 256, 1)

      if (cell >= GRID_LABEL_MIN_CELL) {
        context.font = '11px ui-monospace, Consolas, monospace'
        context.fillStyle = 'rgb(255 255 255 / 70%)'
        context.textBaseline = 'top'
        for (let x = firstX; x < 256; x += cell) {
          for (let y = firstY; y < 256; y += cell) {
            // Rows grow southwards on screen and northwards in the game.
            context.fillText(`${Math.round((left + x) / cell)}, ${Math.round(-(top + y) / cell) - 1}`, x + 4, y + 4)
          }
        }
      }
      return tile
    },
  }) as unknown as TileLayerClass

  return new Layer({ tileSize: 256, maxZoom, updateWhenZooming: false, zIndex: 101 })
}
