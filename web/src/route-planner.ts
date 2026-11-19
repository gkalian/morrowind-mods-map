import L from 'leaflet'
import { t } from './i18n'
import { kindName, type Location } from './locations'
import { findLocations } from './search'
import { findRoutes, type RouteOption, type RoutePoint } from './route-search'
import { stopName, type SpecialLabel, type TransportMode, type TransportNetwork, type TransportStop } from './transport-data'
import { transportName, transportNote } from './transport'

interface ChosenPoint extends RoutePoint { location?: Location; label?: SpecialLabel; stop?: TransportStop }
type End = 'from' | 'to'

export interface RoutePlanner {
  element: HTMLElement
  refresh(): void
  localize(): void
  pickLocation(place: Location): boolean
  pickStop(stop: TransportStop): boolean
  cancelPicking(): void
}

export function createRoutePlanner(map: L.Map, locations: Location[], getNetwork: () => TransportNetwork, getSets: () => Set<string>, getModes: () => Set<TransportMode>, setRouteFocus: (active: boolean) => void, onStartPicking: () => void = () => {}): RoutePlanner {
  const element = document.createElement('details')
  element.className = 'route-planner'
  const overlay = L.layerGroup().addTo(map)
  const pointPane = map.createPane('routePoints')
  pointPane.style.zIndex = '640'
  let from: ChosenPoint | null = null
  let to: ChosenPoint | null = null
  let picking: End | null = null
  let searched = false
  let selected = 0
  let options: RouteOption[] = []
  let message = ''
  let hiddenLegend: HTMLElement | null = null
  let banner: HTMLElement | null = null
  let suggestions: { input: HTMLInputElement; list: HTMLUListElement } | null = null

  function closeSuggestions(): void {
    suggestions?.input.setAttribute('aria-expanded', 'false')
    suggestions?.input.removeAttribute('aria-activedescendant')
    suggestions?.list.remove()
    suggestions = null
  }

  function positionSuggestions(): void {
    if (!suggestions) return
    const { input, list } = suggestions
    const rect = input.getBoundingClientRect()
    const legend = input.closest<HTMLElement>('.legend')
    const bounds = legend?.getBoundingClientRect()
    if (!input.isConnected || !element.open || legend?.hidden || (bounds && (rect.bottom <= bounds.top || rect.top >= bounds.bottom))) {
      closeSuggestions()
      return
    }
    const view = window.visualViewport
    const top = view?.offsetTop ?? 0
    const bottom = top + (view?.height ?? window.innerHeight)
    const left = view?.offsetLeft ?? 0
    const width = view?.width ?? window.innerWidth
    const above = Math.max(0, rect.top - top - 8)
    const below = Math.max(0, bottom - rect.bottom - 8)
    list.style.maxHeight = '260px'
    const desired = Math.min(list.scrollHeight + list.offsetHeight - list.clientHeight, 260)
    const flip = below < desired && above > below
    const available = flip ? above : below
    const height = Math.min(desired, available)
    list.dataset.placement = flip ? 'top' : 'bottom'
    list.style.maxHeight = `${height}px`
    list.style.width = `${Math.min(rect.width, width - 16)}px`
    list.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - rect.width - 8))}px`
    list.style.top = `${flip ? rect.top - height - 4 : rect.bottom + 4}px`
  }

  function pointName(point: ChosenPoint): string {
    return point.location?.name ?? (point.label ? t(point.label) : point.stop ? stopName(point.stop, locations.filter((location) => getSets().has(location.set.id))) : t('cell', { x: Math.floor(point.x), y: Math.floor(point.y) }))
  }

  function named(point: RoutePoint, network: TransportNetwork): string {
    if (point === from || point === to) return pointName(point as ChosenPoint)
    const id = 'id' in point ? String(point.id) : ''
    const stop = network.stops.get(id)
    if (!stop) return t('cell', { x: Math.floor(point.x), y: Math.floor(point.y) })
    return stop.label ? t(stop.label) : stopName(stop, locations.filter((location) => getSets().has(location.set.id)))
  }

  function setPicking(next: End | null): void {
    if (next && !picking) onStartPicking()
    if (next && !picking) map.closePopup()
    if (next && !picking && map.getSize().x < 600) {
      const legend = element.closest<HTMLElement>('.legend')
      if (legend && !legend.hidden) {
        hiddenLegend = legend
        legend.hidden = true
        document.querySelector('.panel .menu')?.setAttribute('aria-expanded', 'false')
      }
    }
    if (!next && hiddenLegend) {
      hiddenLegend.hidden = false
      hiddenLegend = null
      document.querySelector('.panel .menu')?.setAttribute('aria-expanded', 'true')
    }
    picking = next
    map.getContainer().classList.toggle('route-picking', picking !== null)
    banner?.remove()
    banner = null
    if (picking) {
      banner = document.createElement('div')
      banner.className = 'route-pick-banner'
      banner.setAttribute('role', 'status')
      const text = document.createElement('span')
      text.textContent = t(picking === 'from' ? 'routeClickFrom' : 'routeClickTo')
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'route-button'
      cancel.textContent = t('routeCancelPick')
      cancel.addEventListener('click', () => { setPicking(null); render() })
      banner.append(text, cancel)
      document.body.append(banner)
    }
  }

  function draw(fit = false): void {
    const route = options[selected]
    setRouteFocus(!!route)
    overlay.clearLayers()
    if (from) L.circleMarker([from.y, from.x], { radius: 6, color: '#fff', weight: 2, fillColor: '#1766b4', fillOpacity: 1, interactive: false, pane: 'routePoints' }).addTo(overlay)
    if (to) L.circleMarker([to.y, to.x], { radius: 6, color: '#fff', weight: 2, fillColor: '#c44436', fillOpacity: 1, interactive: false, pane: 'routePoints' }).addTo(overlay)
    if (!route) return
    const positions: L.LatLngExpression[] = []
    for (const step of route.steps) {
      const line: L.LatLngExpression[] = [[step.from.y, step.from.x], [step.to.y, step.to.x]]
      positions.push(...line)
      L.polyline(line, { color: '#16232e', weight: 7, opacity: 0.8, interactive: false, dashArray: step.route ? undefined : '5 8' }).addTo(overlay)
      L.polyline(line, { color: step.route ? '#33daf2' : '#fff', weight: 4, opacity: 1, interactive: false, dashArray: step.route ? undefined : '5 8' }).addTo(overlay)
    }
    if (fit && positions.length) map.fitBounds(L.latLngBounds(positions), { paddingTopLeft: [Math.min(380, map.getSize().x / 3), 30], paddingBottomRight: [30, 30], maxZoom: 7 })
  }

  function choose(end: End, point: ChosenPoint): void {
    if (end === 'from') from = point
    else to = point
    setPicking(null)
    searched = false
    options = []
    message = ''
    draw()
    render()
  }

  function inputField(end: End): HTMLElement {
    const point = end === 'from' ? from : to
    const wrapper = document.createElement('div')
    wrapper.className = 'route-field'
    const label = document.createElement('label')
    label.htmlFor = `route-${end}`
    label.textContent = t(end === 'from' ? 'routeFrom' : 'routeTo')
    const row = document.createElement('div')
    row.className = 'route-input-row'
    const search = document.createElement('div')
    search.className = 'route-search'
    const input = document.createElement('input')
    input.id = `route-${end}`
    input.type = 'search'
    input.autocomplete = 'off'
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-expanded', 'false')
    input.setAttribute('aria-controls', `route-${end}-suggestions`)
    input.placeholder = t('routeSearchPlace')
    input.value = point ? pointName(point) : ''
    const list = document.createElement('ul')
    list.id = `route-${end}-suggestions`
    list.className = 'search-results route-suggestions'
    list.setAttribute('role', 'listbox')
    let listInteracted = false
    let activeIndex = -1
    let matches: { point: ChosenPoint; name: string; detail: string }[] = []
    function show(): void {
      const query = input.value.trim().toLowerCase()
      const special = query ? [...getNetwork().stops.values()].filter((stop) => stop.label && t(stop.label).toLowerCase().includes(query)).map((stop) => ({ point: { x: stop.x, y: stop.y, label: stop.label!, stopId: stop.id }, name: t(stop.label!), detail: t('routeApproximatePoint') })) : []
      const places = findLocations(locations.filter((item) => getSets().has(item.set.id) && item.kind !== 'region'), input.value).map((place) => ({ point: { x: place.x, y: place.y, location: place }, name: place.name, detail: `${kindName(place.kind)} · ${place.set.name}` }))
      matches = [...special, ...places].slice(0, 8)
      activeIndex = -1
      input.removeAttribute('aria-activedescendant')
      list.replaceChildren(...matches.map((place, index) => {
        const item = document.createElement('li')
        item.id = `route-${end}-option-${index}`
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', 'false')
        const button = document.createElement('button')
        button.type = 'button'
        const name = document.createElement('span')
        name.textContent = place.name
        const detail = document.createElement('small')
        detail.textContent = place.detail
        button.append(name, detail)
        button.addEventListener('click', () => choose(end, place.point))
        item.append(button)
        return item
      }))
      if (!matches.length) {
        if (suggestions?.input === input) closeSuggestions()
        return
      }
      if (suggestions?.input !== input) closeSuggestions()
      suggestions = { input, list }
      input.setAttribute('aria-expanded', 'true')
      document.body.append(list)
      positionSuggestions()
    }
    input.addEventListener('input', () => {
      if (end === 'from') from = null
      else to = null
      searched = false
      options = []
      message = ''
      draw()
      element.querySelectorAll('.route-options, .route-steps, .route-message').forEach((item) => item.remove())
      const clear = element.querySelector<HTMLButtonElement>('.route-clear')
      if (clear) clear.disabled = !from && !to && ![...element.querySelectorAll<HTMLInputElement>('.route-search input')].some((field) => field.value.trim())
      show()
    })
    input.addEventListener('focus', () => { listInteracted = false; show() })
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!listInteracted && suggestions?.input === input && !list.contains(document.activeElement)) closeSuggestions()
      }, 150)
    })
    list.addEventListener('pointerdown', (event) => {
      listInteracted = true
      if (event.pointerType === 'mouse' && (event.target as Element).closest('button')) event.preventDefault()
    })
    list.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (suggestions?.input === input && document.activeElement !== input && !list.contains(document.activeElement)) closeSuggestions()
      }, 0)
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && matches[0]) {
        event.preventDefault()
        choose(end, matches[Math.max(activeIndex, 0)].point)
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
        event.preventDefault()
        activeIndex = event.key === 'ArrowDown' ? Math.min(activeIndex + 1, matches.length - 1) : Math.max(activeIndex - 1, 0)
        for (const [index, item] of [...list.children].entries()) item.setAttribute('aria-selected', String(index === activeIndex))
        const active = list.children[activeIndex] as HTMLElement
        input.setAttribute('aria-activedescendant', active.id)
        active.scrollIntoView({ block: 'nearest' })
      } else if (event.key === 'Escape') {
        matches = []
        closeSuggestions()
      }
    })
    const pick = document.createElement('button')
    pick.type = 'button'
    pick.className = 'route-button'
    pick.textContent = t(picking === end ? 'routeCancelPick' : 'routePickMap')
    pick.setAttribute('aria-pressed', String(picking === end))
    pick.addEventListener('click', () => {
      setPicking(picking === end ? null : end)
      render()
    })
    search.append(input)
    row.append(search, pick)
    wrapper.append(label, row)
    return wrapper
  }

  function calculate(fit: boolean): void {
    options = []
    selected = 0
    if (!from || !to) message = t('routeChooseBoth')
    else if ((from.location && !getSets().has(from.location.set.id)) || (to.location && !getSets().has(to.location.set.id))) message = t('routeDisabledPlace')
    else if (Math.hypot(from.x - to.x, from.y - to.y) < 0.05) message = t('routeSamePlace')
    else {
      const network = getNetwork()
      if (!network.routes.length) message = t(getModes().size ? 'routeNoResults' : 'routeNoTransport')
      else {
        options = findRoutes(network, from, to)
        message = options.length ? '' : t('routeNoResults')
      }
    }
    draw(fit)
  }

  function scrollToResults(): void {
    requestAnimationFrame(() => {
      const container = element.closest<HTMLElement>('.legend')
      const start = element.querySelector<HTMLElement>('.route-options, .route-message')
      if (!container || !start || !element.open) return
      const end = element.querySelector<HTMLElement>('.route-steps li') ?? start
      const bounds = container.getBoundingClientRect()
      const needed = Math.max(0, end.getBoundingClientRect().bottom - bounds.bottom + 8)
      const maximum = Math.max(0, start.getBoundingClientRect().top - bounds.top - 8)
      const amount = Math.min(needed, maximum)
      if (amount > 0) container.scrollBy({ top: amount, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    })
  }

  function render(): void {
    closeSuggestions()
    const summary = document.createElement('summary')
    summary.textContent = t('routePlanner')
    const content = document.createElement('div')
    content.className = 'route-planner-content'
    content.append(inputField('from'), inputField('to'))
    if (picking) {
      const instruction = document.createElement('div')
      instruction.className = 'route-hint'
      instruction.setAttribute('role', 'status')
      instruction.textContent = t(picking === 'from' ? 'routeClickFrom' : 'routeClickTo')
      content.append(instruction)
    }
    const controls = document.createElement('div')
    controls.className = 'route-controls'
    const find = document.createElement('button')
    find.type = 'button'
    find.className = 'route-button route-button-primary'
    find.textContent = t('routeFind')
    find.addEventListener('click', () => {
      setPicking(null)
      searched = true
      calculate(true)
      render()
      scrollToResults()
    })
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'route-button route-clear'
    clear.textContent = t('routeClear')
    clear.disabled = !from && !to && !searched
    clear.addEventListener('click', () => {
      from = null
      to = null
      searched = false
      options = []
      message = ''
      setPicking(null)
      draw()
      render()
    })
    controls.append(find, clear)
    content.append(controls)
    const hint = document.createElement('div')
    hint.className = 'route-hint'
    hint.textContent = t('routeCaveat')
    content.append(hint)
    if (message) {
      const status = document.createElement('div')
      status.className = 'route-message'
      status.setAttribute('role', 'status')
      status.textContent = message
      content.append(status)
    }
    if (options.length) {
      const network = getNetwork()
      const list = document.createElement('div')
      list.className = 'route-options'
      options.forEach((option, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'route-option'
        button.setAttribute('aria-pressed', String(selected === index))
        button.textContent = t('routeOption', { number: index + 1, walking: option.walking.toFixed(1), rides: option.rides })
        button.addEventListener('click', () => { selected = index; draw(true); render() })
        list.append(button)
      })
      content.append(list)
      const steps = document.createElement('ol')
      steps.className = 'route-steps'
      for (const step of options[selected].steps) {
        const walking = Math.hypot(step.to.x - step.from.x, step.to.y - step.from.y)
        if (!step.route && walking < 0.03) continue
        const item = document.createElement('li')
        const title = document.createElement('span')
        title.textContent = step.route
          ? `${transportName(step.route.mode)}: ${named(step.from, network)} → ${named(step.to, network)}`
          : t('routeWalkStep', { from: named(step.from, network), to: named(step.to, network), distance: walking.toFixed(1) })
        item.append(title)
        if (step.route?.provider) {
          const provider = document.createElement('small')
          provider.textContent = t('transportProvider') + ': ' + step.route.provider
          item.append(provider)
        }
        const noteKey = step.route && transportNote(step.route)
        if (noteKey) {
          const note = document.createElement('small')
          note.textContent = t(noteKey)
          item.append(note)
        }
        steps.append(item)
      }
      content.append(steps)
    }
    element.replaceChildren(summary, content)
  }

  map.on('click', (event: L.LeafletMouseEvent) => {
    if (!picking) return
    const point = { x: event.latlng.lng, y: event.latlng.lat }
    const special = [...getNetwork().stops.values()].find((stop) => stop.approximate && stop.label && Math.hypot(stop.x - point.x, stop.y - point.y) < 0.15)
    choose(picking, special ? { x: special.x, y: special.y, label: special.label!, stopId: special.id } : point)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picking) { setPicking(null); render() }
  })
  document.addEventListener('pointerdown', (event) => {
    if (suggestions && event.target !== suggestions.input && !suggestions.list.contains(event.target as Node)) closeSuggestions()
  })
  document.addEventListener('scroll', positionSuggestions, true)
  window.addEventListener('resize', positionSuggestions)
  window.visualViewport?.addEventListener('resize', positionSuggestions)
  window.visualViewport?.addEventListener('scroll', positionSuggestions)
  render()
  return {
    element,
    refresh() { if (searched) { calculate(false); render() } },
    localize() { setPicking(null); if (searched) calculate(false); render() },
    pickLocation(place) {
      if (!picking) return false
      choose(picking, { x: place.x, y: place.y, location: place })
      return true
    },
    pickStop(stop) {
      if (!picking) return false
      choose(picking, { x: stop.x, y: stop.y, stop, label: stop.label ?? undefined, stopId: stop.approximate ? stop.id : undefined })
      return true
    },
    cancelPicking() { if (picking) { setPicking(null); render() } },
  }
}
