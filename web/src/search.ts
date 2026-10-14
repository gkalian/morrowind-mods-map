import { onLangChange, t } from './i18n'
import { kindName, type Kind, type Location } from './locations'

const MAX_RESULTS = 30
const KIND_RANK: Kind[] = ['settlement', 'region', 'entrance']

/**
 * Finds Locations whose name in either language contains the text; names that start with it
 * come first.
 */
export function findLocations(locations: Location[], text: string): Location[] {
  const query = text.trim().toLowerCase()
  if (query.length === 0) return []

  const found: { location: Location; rank: number }[] = []
  for (const location of locations) {
    const at = [location.en, location.ru]
      .map((name) => name?.toLowerCase().indexOf(query) ?? -1)
      .filter((index) => index >= 0)
    if (at.length === 0) continue
    found.push({ location, rank: (at.includes(0) ? 0 : 10) + KIND_RANK.indexOf(location.kind) })
  }
  found.sort((a, b) => a.rank - b.rank || a.location.name.localeCompare(b.location.name))
  return found.slice(0, MAX_RESULTS).map((entry) => entry.location)
}

/** The search box: searches every Location of every Plugin Set, shown or not. */
export function createSearch(locations: Location[], onPick: (location: Location) => void): HTMLElement {
  const box = document.createElement('div')
  box.className = 'search'

  const icon = document.createElement('span')
  icon.className = 'search-icon'
  icon.setAttribute('aria-hidden', 'true')

  const input = document.createElement('input')
  input.type = 'search'
  input.autocomplete = 'off'
  input.spellcheck = false

  const list = document.createElement('ul')
  list.className = 'search-results'
  box.append(icon, input, list)

  let results: Location[] = []
  let picked: Location | null = null

  function label(): void {
    input.placeholder = t('search')
    input.setAttribute('aria-label', t('search'))
  }

  function pick(location: Location): void {
    picked = location
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
        detail.textContent = `${kindName(location.kind)} · ${location.set.name}`
        button.append(name, detail)
        button.addEventListener('click', () => pick(location))
        item.append(button)
        return item
      }),
    )
  }

  label()
  onLangChange(() => {
    label()
    // The picked name stays in the box, now in the other language.
    if (picked && input.value !== '') input.value = picked.name
    if (list.childElementCount > 0) show()
  })
  input.addEventListener('input', () => {
    picked = null
    show()
  })
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
