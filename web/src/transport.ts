import L from 'leaflet'
import { localName, t } from './i18n'
import { createLegendInfo } from './legend-info'
import type { Location } from './locations'
import type { Manifest, PluginSet } from './manifest'
import { buildTransport, createStopNamer, type TransportData, type TransportMode, type TransportNetwork, type TransportRoute, type TransportStop } from './transport-data'

const COLORS: Record<TransportMode, string> = { land: '#b56232', water: '#2886b5', air: '#489774', guild: '#a05cb0', magic: '#ce69a6', propylon: '#d1a52d' }
const NAMES: Record<TransportMode, 'transportLand' | 'transportWater' | 'transportAir' | 'transportGuild' | 'transportMagic' | 'transportPropylon'> = { land: 'transportLand', water: 'transportWater', air: 'transportAir', guild: 'transportGuild', magic: 'transportMagic', propylon: 'transportPropylon' }
export const TRANSPORT_MODES: TransportMode[] = ['land', 'water', 'air', 'guild', 'magic', 'propylon']

export function transportName(mode: TransportMode): string {
  return t(NAMES[mode])
}

/** The name of a stop that stands for a place without an exterior. */
export function anchorName(stop: TransportStop): string | null {
  return stop.anchor ? t('transportApproximate', { name: localName(stop.anchor) }) : null
}

/** What the viewer should know about a route, from the plugins: items, conditions, approximate ends. */
export function transportNotes(route: TransportRoute, stops?: Map<string, TransportStop>): string[] {
  const notes: string[] = []
  if (route.items?.length) notes.push(t('transportNeedsItem', { items: route.items.map(localName).join(', ') }))
  if (route.dialogue) notes.push(t('transportDialogue'))
  if (route.conditional) notes.push(t('transportConditional'))
  for (const id of [route.from, route.to]) {
    const anchor = stops?.get(id)?.anchor
    if (anchor) notes.push(t('transportAnchorNote', { name: localName(anchor) }))
  }
  return notes
}

export function createTransportControls(modes: Set<TransportMode>, onChange: () => void, sets: PluginSet[], data: TransportData, planner?: HTMLElement): HTMLElement {
  const details = document.createElement('details')
  details.className = 'transport-options'
  const summary = document.createElement('summary')
  summary.append(document.createTextNode(t('transport')), createLegendInfo('transport', sets, data))
  details.append(summary)
  const filters = document.createElement('details')
  filters.className = 'transport-filters'
  filters.open = true
  const filtersSummary = document.createElement('summary')
  filtersSummary.textContent = t('transportFilters')
  filters.append(filtersSummary)
  const actions = document.createElement('div')
  actions.className = 'transport-actions'
  const allLabel = document.createElement('label')
  allLabel.className = 'check'
  const allInput = document.createElement('input')
  allInput.type = 'checkbox'
  allInput.checked = TRANSPORT_MODES.every((mode) => modes.has(mode))
  const modeInputs = new Map<TransportMode, HTMLInputElement>()
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'transport-reset'
  reset.textContent = t('transportReset')
  reset.disabled = modes.size === 0
  allInput.addEventListener('change', () => {
    for (const mode of TRANSPORT_MODES) {
      if (allInput.checked) modes.add(mode)
      else modes.delete(mode)
      modeInputs.get(mode)!.checked = allInput.checked
    }
    reset.disabled = modes.size === 0
    onChange()
  })
  allLabel.append(allInput, document.createTextNode(t('transportAll')))
  reset.addEventListener('click', () => {
    modes.clear()
    allInput.checked = false
    for (const input of modeInputs.values()) input.checked = false
    reset.disabled = true
    onChange()
  })
  actions.append(allLabel, reset)
  filters.append(actions)
  for (const mode of TRANSPORT_MODES) {
    const label = document.createElement('label')
    label.className = 'check transport-option'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = modes.has(mode)
    modeInputs.set(mode, input)
    input.addEventListener('change', () => {
      if (input.checked) modes.add(mode)
      else modes.delete(mode)
      allInput.checked = TRANSPORT_MODES.every((item) => modes.has(item))
      reset.disabled = modes.size === 0
      onChange()
    })
    const swatch = document.createElement('span')
    swatch.className = `transport-swatch transport-swatch--${mode}`
    swatch.setAttribute('aria-hidden', 'true')
    label.append(input, swatch, document.createTextNode(t(NAMES[mode])))
    filters.append(label)
  }
  details.append(filters)
  if (planner) details.append(planner)
  return details
}

export function createTransportLayer(map: L.Map, data: TransportData, manifest: Manifest, locations: Location[], onPickStop: (stop: TransportStop) => boolean = () => false) {
  const lines = L.layerGroup().addTo(map)
  const markers = L.layerGroup().addTo(map)
  // Magic stops stand above the others, as few lines lead to them.
  const topPane = map.createPane('transportTop')
  topPane.style.zIndex = '625'
  let network: TransportNetwork = { stops: new Map(), routes: [] }
  let visible = new Set<TransportMode>()
  let selected: string | null = null
  let routeFocus = false
  let enabledSets = new Set<string>()
  let land = new Set<string>()
  let backdropLand = new Set<string>()

  function covered(stop: TransportStop): boolean {
    const x = Math.floor(stop.x)
    const y = Math.floor(stop.y)
    if (stop.anchor && backdropLand.has(`${x},${y}`)) return true
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (land.has(`${x + dx},${y + dy}`)) return true
      }
    }
    return false
  }

  function render(): void {
    lines.clearLayers()
    markers.clearLayers()
    const routes = network.routes.filter((route) => visible.has(route.mode))
    const directions = new Set(routes.map((route) => `${route.mode}|${route.from}|${route.to}`))
    const included = new Set<string>()
    const drawn = new Set<string>()
    const markerById = new Map<string, L.CircleMarker>()
    for (const route of routes) {
      const from = network.stops.get(route.from)
      const to = network.stops.get(route.to)
      if (!from || !to) continue
      if (covered(from)) included.add(from.id)
      if (covered(to)) included.add(to.id)
      if (!covered(from) || !covered(to)) continue
      const key = [route.from, route.to].sort().join('|') + route.mode
      if (drawn.has(key)) continue
      drawn.add(key)
      L.polyline([[from.y, from.x], [to.y, to.x]], {
        color: COLORS[route.mode], weight: 2,
        opacity: routeFocus ? 0.4 : 0.8,
        dashArray: route.mode === 'water' ? '8 5' : route.mode === 'air' ? '12 6' : route.mode === 'guild' ? '2 6' : route.mode === 'propylon' ? '12 4 2 4' : undefined,
        interactive: false,
      }).addTo(lines)
      if (!directions.has(`${route.mode}|${route.to}|${route.from}`)) {
        const angle = Math.atan2(from.y - to.y, to.x - from.x) * 180 / Math.PI
        const arrow = L.divIcon({
          className: 'transport-arrow',
          html: `<span style="border-left-color:${COLORS[route.mode]};transform:rotate(${angle}deg)"></span>`,
          iconSize: [10, 10], iconAnchor: [5, 5],
        })
        L.marker([(from.y + to.y) / 2, (from.x + to.x) / 2], { icon: arrow, interactive: false, keyboard: false, opacity: routeFocus ? 0.4 : 0.8 }).addTo(lines)
      }
    }
    const namer = createStopNamer(locations.filter((location) => enabledSets.has(location.set.id)), localName)
    const displayName = (stop: TransportStop) => anchorName(stop) ?? namer(stop)
    const backdrops = manifest.sets.filter((set) => set.backdropFor).flatMap((set) => set.backdropFor ?? [])
    const backdropNames = manifest.sets.filter((set) => backdrops.includes(set.id)).map((set) => set.name).join(', ')
    for (const id of included) {
      const stop = network.stops.get(id)!
      const mode = [...stop.modes].find((candidate) => visible.has(candidate)) ?? 'land'
      const marker = L.circleMarker([stop.y, stop.x], {
        radius: mode === 'magic' || selected === id ? 7 : 5, color: COLORS[mode], weight: 2,
        fillColor: '#fff', fillOpacity: 0.95, pane: mode === 'magic' ? 'transportTop' : 'overlayPane',
      }).addTo(markers)
      markerById.set(id, marker)
      const name = displayName(stop)
      marker.bindTooltip(name, { direction: 'top', opacity: 0.95 })
      marker.on('click', () => {
        if (onPickStop(stop)) return
        selected = id
        const content = document.createElement('div')
        content.className = 'card transport-card'
        const title = document.createElement('strong')
        title.textContent = name
        content.append(title)
        const departures = routes.filter((route) => route.from === id)
        if (!departures.length) {
          const empty = document.createElement('div')
          empty.textContent = stop.anchor ? t('transportAnchorNote', { name: localName(stop.anchor) }) : t('transportNoDepartures')
          content.append(empty)
        }
        for (const route of departures) {
          const target = network.stops.get(route.to)
          if (!target) continue
          const item = document.createElement('div')
          item.className = 'transport-destination'
          const inside = covered(target)
          const text = document.createElement(inside ? 'button' : 'span')
          text.textContent = `${t(NAMES[route.mode])} → ${displayName(target)}`
          if (text instanceof HTMLButtonElement) {
            text.type = 'button'
            text.addEventListener('click', () => {
              map.flyTo([target.y, target.x], Math.max(map.getZoom(), 6))
              markerById.get(target.id)?.fire('click')
            })
          }
          item.append(text)
          if (route.provider) {
            const provider = document.createElement('small')
            provider.textContent = `${t('transportProvider')}: ${localName(route.provider)}`
            item.append(provider)
          }
          for (const text of transportNotes(route, network.stops)) {
            const note = document.createElement('small')
            note.textContent = text
            item.append(note)
          }
          if (!inside) {
            const outside = document.createElement('small')
            outside.textContent = target.anchor ? t('transportBackdropRequired', { modules: backdropNames }) : t('transportOutside')
            item.append(outside)
          }
          content.append(item)
        }
        marker.bindPopup(content).openPopup()
      })
    }
  }
  return {
    update(sets: Set<string>, modes: Set<TransportMode>) {
      enabledSets = sets
      visible = modes
      land = new Set()
      backdropLand = new Set()
      for (const set of manifest.sets) {
        if (set.backdropFor) {
          if (set.backdropFor.some((id) => sets.has(id))) {
            for (let i = 0; i < set.land.length; i += 2) backdropLand.add(`${set.land[i]},${set.land[i + 1]}`)
          }
        } else if (sets.has(set.id)) {
          for (let i = 0; i < set.land.length; i += 2) land.add(`${set.land[i]},${set.land[i + 1]}`)
        }
      }
      network = buildTransport(data, manifest, sets)
      if (selected && !network.stops.has(selected)) selected = null
      render()
    },
    routingNetwork(): TransportNetwork {
      const stops = new Map([...network.stops].filter(([, stop]) => covered(stop)))
      return { stops, routes: network.routes.filter((route) => visible.has(route.mode) && stops.has(route.from) && stops.has(route.to)) }
    },
    setRouteFocus(active: boolean) {
      if (routeFocus === active) return
      routeFocus = active
      const opacity = active ? 0.4 : 0.8
      lines.eachLayer((layer) => {
        if (layer instanceof L.Polyline) layer.setStyle({ opacity })
        else if (layer instanceof L.Marker) layer.setOpacity(opacity)
      })
    },
    refresh() { render() },
  }
}
