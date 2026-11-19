import L from 'leaflet'
import { t } from './i18n'
import { closestIntervention, interventionMarkers, type InterventionKind, type InterventionMarker, type InterventionPoint } from './intervention-data'
import { closeLegendInfoWithin, createLegendInfo } from './legend-info'
import type { Location } from './locations'
import type { Manifest } from './manifest'
import { stopName, type TransportData } from './transport-data'

const KINDS: InterventionKind[] = ['temple', 'divine']
const COLORS: Record<InterventionKind, string> = { temple: '#e78151', divine: '#59baf1' }
const NAMES = { temple: 'interventionTemple', divine: 'interventionDivine' } as const

interface ChosenPoint extends InterventionPoint { location?: Location }
export interface Intervention {
  element: HTMLDetailsElement
  update(): void
  localize(): void
  select(place: Location): void
  pickLocation(place: Location): boolean
  pickPoint(point: InterventionPoint): boolean
  cancelPicking(): void
}

export function createIntervention(map: L.Map, data: TransportData, manifest: Manifest, locations: Location[], getSets: () => Set<string>, onStartPicking: () => void): Intervention {
  const element = document.createElement('details')
  element.className = 'intervention-options'
  const markersLayer = L.layerGroup().addTo(map)
  const resultLayer = L.layerGroup().addTo(map)
  const params = new URLSearchParams(location.search)
  const active = new Set<InterventionKind>(params.has('intervention') ? (params.get('intervention') ?? '').split(',').filter((kind): kind is InterventionKind => KINDS.includes(kind as InterventionKind)) : [])
  let markers: InterventionMarker[] = []
  let point: ChosenPoint | null = null
  let picking = false
  let hiddenLegend: HTMLElement | null = null
  let banner: HTMLElement | null = null

  function setPicking(next: boolean): void {
    if (next && !picking) {
      onStartPicking()
      map.closePopup()
      if (!active.size) {
        KINDS.forEach((kind) => active.add(kind))
        const query = new URLSearchParams(location.search)
        query.set('intervention', [...active].join(','))
        history.replaceState(null, '', `?${query}`)
        draw()
      }
      if (map.getSize().x < 600) {
        const legend = element.closest<HTMLElement>('.legend')
        if (legend && !legend.hidden) {
          hiddenLegend = legend
          legend.hidden = true
          document.querySelector('.panel .menu')?.setAttribute('aria-expanded', 'false')
        }
      }
    }
    if (!next && hiddenLegend) {
      hiddenLegend.hidden = false
      hiddenLegend = null
      document.querySelector('.panel .menu')?.setAttribute('aria-expanded', 'true')
    }
    picking = next
    map.getContainer().classList.toggle('route-picking', picking)
    banner?.remove()
    banner = null
    if (picking) {
      banner = document.createElement('div')
      banner.className = 'route-pick-banner'
      banner.setAttribute('role', 'status')
      const text = document.createElement('span')
      text.textContent = t('interventionPickHint')
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'route-button'
      cancel.textContent = t('interventionCancel')
      cancel.addEventListener('click', () => { setPicking(false); render() })
      banner.append(text, cancel)
      document.body.append(banner)
    }
  }

  function markerName(marker: InterventionMarker): string {
    const available = locations.filter((item) => getSets().has(item.set.id))
    const exact = marker.location && available.find((item) => item.en.toLowerCase() === marker.location!.toLowerCase() && Math.hypot(item.x - marker.x, item.y - marker.y) < 2)
    if (exact) return exact.name
    const nearby = stopName({ id: marker.key, x: marker.x, y: marker.y, interior: '', modes: new Set(), provider: '', script: '' }, available)
    const cell = `${Math.floor(marker.x)}, ${Math.floor(marker.y)}`
    return nearby !== cell ? nearby : marker.location || t('cell', { x: Math.floor(marker.x), y: Math.floor(marker.y) })
  }

  function draw(): void {
    markersLayer.clearLayers()
    resultLayer.clearLayers()
    for (const marker of markers) {
      if (!active.has(marker.kind)) continue
      const tooltip = document.createElement('span')
      tooltip.textContent = `${t(NAMES[marker.kind])}: ${markerName(marker)}`
      L.circleMarker([marker.y, marker.x], { radius: 5, color: '#fff', weight: 1.5, fillColor: COLORS[marker.kind], fillOpacity: 1 }).bindTooltip(tooltip, { direction: 'top', offset: [0, -3] }).addTo(markersLayer)
    }
    if (!point || !active.size) return
    L.circleMarker([point.y, point.x], { radius: 6, color: '#fff', weight: 2, fillColor: '#252b35', fillOpacity: 1, interactive: false }).addTo(resultLayer)
    for (const kind of KINDS) {
      if (!active.has(kind)) continue
      for (const marker of closestIntervention(markers, kind, point)) {
        const positions: L.LatLngExpression[] = [[point.y, point.x], [marker.y, marker.x]]
        L.polyline(positions, { color: '#1c2632', weight: 5, opacity: 0.75, interactive: false }).addTo(resultLayer)
        L.polyline(positions, { color: COLORS[kind], weight: 2.5, opacity: 1, dashArray: '4 6', interactive: false }).addTo(resultLayer)
        L.circleMarker([marker.y, marker.x], { radius: 7, color: '#fff', weight: 2, fillColor: COLORS[kind], fillOpacity: 1, interactive: false }).addTo(resultLayer)
      }
    }
  }

  function render(): void {
    closeLegendInfoWithin(element)
    const summary = document.createElement('summary')
    summary.append(document.createTextNode(t('intervention')), createLegendInfo('intervention', manifest.sets, data))
    const content = document.createElement('div')
    content.className = 'intervention-content'
    for (const kind of KINDS) {
      const label = document.createElement('label')
      label.className = 'check intervention-option'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = active.has(kind)
      input.addEventListener('change', () => {
        if (input.checked) active.add(kind)
        else active.delete(kind)
        const query = new URLSearchParams(location.search)
        query.set('intervention', [...active].join(','))
        history.replaceState(null, '', `?${query}`)
        draw()
        render()
      })
      const swatch = document.createElement('span')
      swatch.className = `intervention-swatch intervention-swatch--${kind}`
      swatch.setAttribute('aria-hidden', 'true')
      label.append(input, swatch, document.createTextNode(t(NAMES[kind])))
      content.append(label)
    }
    const controls = document.createElement('div')
    controls.className = 'route-controls'
    const choose = document.createElement('button')
    choose.type = 'button'
    choose.className = 'route-button route-button-primary'
    choose.textContent = picking ? t('interventionCancel') : t('interventionPick')
    choose.addEventListener('click', () => { setPicking(!picking); render() })
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'route-button'
    clear.textContent = t('interventionClear')
    clear.disabled = !point
    clear.addEventListener('click', () => { point = null; setPicking(false); draw(); render() })
    controls.append(choose, clear)
    content.append(controls)
    if (point) {
      const origin = document.createElement('div')
      origin.className = 'intervention-origin'
      origin.textContent = t('interventionFrom', { place: point.location?.name ?? t('cell', { x: Math.floor(point.x), y: Math.floor(point.y) }) })
      content.append(origin)
      const results = document.createElement('div')
      results.className = 'intervention-results'
      results.setAttribute('aria-live', 'polite')
      for (const kind of KINDS) {
        const found = closestIntervention(markers, kind, point)
        const row = document.createElement('div')
        const label = document.createElement('strong')
        label.textContent = t(NAMES[kind])
        const value = document.createElement('span')
        value.textContent = [...new Set(found.map(markerName))].join(' / ') || t('interventionMissing')
        row.append(label, value)
        if (found.length > 1) {
          const note = document.createElement('small')
          note.textContent = t('interventionAmbiguous')
          row.append(note)
        }
        results.append(row)
      }
      content.append(results)
    } else {
      const hint = document.createElement('p')
      hint.className = 'intervention-note'
      hint.textContent = t(markers.length ? 'interventionChoose' : 'interventionNoData')
      content.append(hint)
    }
    const note = document.createElement('p')
    note.className = 'intervention-note'
    note.textContent = t('interventionNote')
    content.append(note)
    const missing = manifest.sets.filter((set) => getSets().has(set.id) && !data.sets.get(set.id)?.interventionReferences).map((set) => set.name)
    if (missing.length) {
      const warning = document.createElement('p')
      warning.className = 'intervention-note'
      warning.textContent = t('interventionMissingSets', { modules: missing.join(', ') })
      content.append(warning)
    }
    element.replaceChildren(summary, content)
  }

  function choose(pointValue: ChosenPoint): void {
    point = pointValue
    setPicking(false)
    draw()
    render()
  }
  map.on('click', (event: L.LeafletMouseEvent) => { if (picking) choose({ x: event.latlng.lng, y: event.latlng.lat }) })
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && picking) { setPicking(false); render() } })
  markers = interventionMarkers(data, manifest, getSets())
  draw()
  render()
  return {
    element,
    update() { markers = interventionMarkers(data, manifest, getSets()); draw(); render() },
    localize() { setPicking(false); draw(); render() },
    select(place) { choose({ x: place.x, y: place.y, location: place }) },
    pickLocation(place) { if (!picking) return false; choose({ x: place.x, y: place.y, location: place }); return true },
    pickPoint(value) { if (!picking) return false; choose(value); return true },
    cancelPicking() { if (picking) { setPicking(false); render() } },
  }
}
