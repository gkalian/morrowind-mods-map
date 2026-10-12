import { KIND_NAMES, type Kind, type Location } from './locations'

const MAX_RESULTS = 30
const KIND_RANK: Kind[] = ['settlement', 'region', 'entrance']

/** Finds Locations whose name contains the text; names that start with it come first. */
export function findLocations(locations: Location[], text: string): Location[] {
  const query = text.trim().toLowerCase()
  if (query.length === 0) return []

  const found: { location: Location; rank: number }[] = []
  for (const location of locations) {
    const at = location.name.toLowerCase().indexOf(query)
    if (at < 0) continue
    found.push({ location, rank: (at === 0 ? 0 : 10) + KIND_RANK.indexOf(location.kind) })
  }
  found.sort((a, b) => a.rank - b.rank || a.location.name.localeCompare(b.location.name))
  return found.slice(0, MAX_RESULTS).map((entry) => entry.location)
}

/** The search box: searches every Location of every Plugin Set, shown or not. */
export function createSearch(locations: Location[], onPick: (location: Location) => void): HTMLElement {
  const box = document.createElement('div')
  box.className = 'search'

  const input = document.createElement('input')
  input.type = 'search'
  input.placeholder = 'Search location'
  input.setAttribute('aria-label', 'Search location')
  input.autocomplete = 'off'
  input.spellcheck = false

  const list = document.createElement('ul')
  list.className = 'search-results'
  box.append(input, list)

  let results: Location[] = []

  function pick(location: Location): void {
    input.value = location.name
    list.replaceChildren()
    input.blur()
    onPick(location)
  }

  function show(): void {
    results = findLocations(locations, input.value)
    list.replaceChildren(
      ...results.map((location) => {
        const item = document.createElement('li')
        const button = document.createElement('button')
        button.type = 'button'
        const name = document.createElement('span')
        name.textContent = location.name
        const detail = document.createElement('small')
        detail.textContent = `${KIND_NAMES[location.kind]} · ${location.set.name}`
        button.append(name, detail)
        button.addEventListener('click', () => pick(location))
        item.append(button)
        return item
      }),
    )
  }

  input.addEventListener('input', show)
  input.addEventListener('focus', show)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && results.length > 0) pick(results[0])
    if (event.key === 'Escape') {
      input.value = ''
      list.replaceChildren()
    }
  })
  document.addEventListener('pointerdown', (event) => {
    if (!box.contains(event.target as Node)) list.replaceChildren()
  })

  return box
}
