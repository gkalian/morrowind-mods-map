import L from 'leaflet'
import type { Kind, Location } from './locations'

/** Zoom range in which each kind of Location is drawn. */
const ZOOM_RANGE: Record<Kind, [number, number]> = {
  region: [0, 4],
  settlement: [4, Infinity],
  entrance: [7, Infinity],
}

/** Drawing order: earlier kinds keep their names when names collide. */
const KIND_ORDER: Kind[] = ['region', 'settlement', 'entrance']

const MAX_DRAWN = 800
/** Dots closer than this many pixels are drawn as one. */
const DOT_SPACING = 9
const LABEL_HEIGHT = 18
/** Width of one character of a name in pixels; follows the font sizes in the stylesheet. */
const CHARACTER_WIDTH: Record<Kind, number> = { region: 12, settlement: 7.7, entrance: 7.2 }

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function contains(box: Box, point: L.Point): boolean {
  return point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom
}

/** Draws the Locations that fit the current view, dropping names that would overlap. */
export class LabelLayer {
  private readonly group = L.layerGroup()
  private selected: Location | null = null

  constructor(
    private readonly map: L.Map,
    private readonly locations: Location[],
    private readonly isShown: (location: Location) => boolean,
    private readonly onPick: (location: Location) => void,
  ) {
    this.group.addTo(map)
    // A zoom ends with a move too, so this covers both.
    map.on('moveend', () => this.refresh())
    this.refresh()
  }

  /** The selected Location is always drawn, whatever the zoom. */
  select(location: Location | null): void {
    this.selected = location
    this.refresh()
  }

  refresh(): void {
    this.group.clearLayers()
    const zoom = this.map.getZoom()
    const view = this.map.getBounds().pad(0.1)

    const candidates = this.locations.filter((location) => {
      if (location === this.selected) return false
      if (!this.isShown(location)) return false
      const [from, to] = ZOOM_RANGE[location.kind]
      return zoom >= from && zoom <= to && view.contains([location.y, location.x])
    })
    candidates.sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.size - a.size || a.name.localeCompare(b.name),
    )
    if (this.selected) candidates.unshift(this.selected)

    const names: Box[] = []
    const dots: L.Point[] = []
    let drawn = 0
    for (const location of candidates) {
      if (drawn >= MAX_DRAWN) break
      const point = this.map.latLngToContainerPoint([location.y, location.x])
      const isSelected = location === this.selected
      const width = location.name.length * CHARACTER_WIDTH[location.kind]

      // A Region's name is centred on its point; other names sit to the right of their dot.
      const box: Box =
        location.kind === 'region'
          ? { left: point.x - width / 2, right: point.x + width / 2, top: point.y - 10, bottom: point.y + 10 }
          : { left: point.x - 6, right: point.x + 12 + width, top: point.y - LABEL_HEIGHT / 2, bottom: point.y + LABEL_HEIGHT / 2 }
      const nameFits =
        isSelected || (!names.some((other) => overlaps(box, other)) && !dots.some((dot) => contains(box, dot)))

      if (!isSelected) {
        // Only an Interior Entrance is worth drawing as a bare dot: they crowd together in towns.
        if (!nameFits && location.kind !== 'entrance') continue
        if (location.kind !== 'region') {
          if (dots.some((dot) => dot.distanceTo(point) < DOT_SPACING)) continue
          if (names.some((other) => contains(other, point))) continue
        }
      }

      if (nameFits) names.push(box)
      if (location.kind !== 'region') dots.push(point)
      this.group.addLayer(this.marker(location, nameFits, isSelected))
      drawn += 1
    }
  }

  private marker(location: Location, withName: boolean, isSelected: boolean): L.Marker {
    const element = document.createElement('div')
    element.className = `loc loc-${location.kind}${isSelected ? ' loc-selected' : ''}`
    element.title = location.name
    if (location.kind !== 'region') element.append(document.createElement('i'))
    if (withName) {
      const name = document.createElement('span')
      name.textContent = location.name
      element.append(name)
    }

    const marker = L.marker([location.y, location.x], {
      icon: L.divIcon({ html: element, className: 'loc-anchor', iconSize: [0, 0] }),
      keyboard: false,
    })
    marker.on('click', () => this.onPick(location))
    return marker
  }
}
