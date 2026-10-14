import { t } from './i18n'
import { kindPlural, type Kind, type Location } from './locations'
import type { PluginSet } from './manifest'

/** What the viewer has switched on. */
export interface Shown {
  sets: Set<string>
  kinds: Record<Kind, boolean>
  regionColours: boolean
  cellGrid: boolean
}

export interface Legend {
  element: HTMLElement
  /** Brings the tick boxes in line with `shown` after it was changed from outside. */
  sync(): void
}

const LIST_ORDER: Kind[] = ['settlement', 'region', 'entrance']

function checkbox(label: string, read: () => boolean, write: (on: boolean) => void): { row: HTMLLabelElement; sync: () => void } {
  const row = document.createElement('label')
  row.className = 'check'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = read()
  input.addEventListener('change', () => write(input.checked))
  const text = document.createElement('span')
  text.textContent = label
  row.append(input, text)
  return { row, sync: () => (input.checked = read()) }
}

/** A collapsed list of Locations that is filled in the first time it is opened. */
function locationList(title: string, locations: Location[], onPick: (location: Location) => void): HTMLDetailsElement {
  const details = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = `${title} (${locations.length})`
  details.append(summary)

  details.addEventListener('toggle', () => {
    if (!details.open || details.childElementCount > 1) return
    const list = document.createElement('ul')
    for (const location of locations) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = location.name
      button.addEventListener('click', () => onPick(location))
      item.append(button)
      list.append(item)
    }
    details.append(list)
  })
  return details
}

/** The legend: Plugin Sets with their Locations, and what is drawn on the Map. */
export function createLegend(
  sets: PluginSet[],
  locations: Location[],
  shown: Shown,
  onChange: () => void,
  onPick: (location: Location) => void,
): Legend {
  const element = document.createElement('div')
  element.className = 'legend'
  const syncs: (() => void)[] = []

  for (const set of sets) {
    const block = document.createElement('div')
    block.className = 'legend-set'

    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = shown.sets.has(set.id)
    toggle.disabled = set.locked
    toggle.title = t(set.locked ? 'alwaysShown' : 'showSet', { set: set.name })
    toggle.setAttribute('aria-label', toggle.title)
    toggle.addEventListener('change', () => {
      if (toggle.checked) shown.sets.add(set.id)
      else shown.sets.delete(set.id)
      onChange()
    })
    syncs.push(() => (toggle.checked = shown.sets.has(set.id)))

    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = set.name
    if (set.version) {
      const version = document.createElement('small')
      version.textContent = set.version
      summary.append(' ', version)
    }
    details.append(summary)

    const own = locations.filter((location) => location.set === set)
    for (const kind of LIST_ORDER) {
      const ofKind = own.filter((location) => location.kind === kind).sort((a, b) => a.name.localeCompare(b.name))
      if (ofKind.length > 0) details.append(locationList(kindPlural(kind), ofKind, onPick))
    }

    block.append(toggle, details)
    element.append(block)
  }

  const show = document.createElement('div')
  show.className = 'legend-show'
  const options = [
    checkbox(t('showSettlements'), () => shown.kinds.settlement, (on) => (shown.kinds.settlement = on)),
    checkbox(t('showEntrances'), () => shown.kinds.entrance, (on) => (shown.kinds.entrance = on)),
    checkbox(t('showRegionNames'), () => shown.kinds.region, (on) => (shown.kinds.region = on)),
    checkbox(t('showRegionColours'), () => shown.regionColours, (on) => (shown.regionColours = on)),
    checkbox(t('showCellGrid'), () => shown.cellGrid, (on) => (shown.cellGrid = on)),
  ]
  for (const option of options) {
    option.row.addEventListener('change', onChange)
    show.append(option.row)
    syncs.push(option.sync)
  }
  element.append(show)

  return { element, sync: () => syncs.forEach((sync) => sync()) }
}
