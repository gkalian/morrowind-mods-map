import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLang } from './i18n'
import { createSearch, findLocations } from './search'
import { location, pluginSet } from './test-helpers'

const places = [
  location('entrance', 'Balmora, Guild of Mages', 3, -2),
  location('settlement', 'Balmora', 3, -2, { ru: 'Балмора' }),
  location('region', 'Bitter Coast', -5, -4, { ru: 'Горький Берег' }),
  location('settlement', 'Ald Velothi', -10, 15),
  location('settlement', 'Old Balmora Shack', 0, 0),
]
const names = (found: { en: string }[]) => found.map((item) => item.en)

afterEach(() => {
  setLang('en')
  document.body.replaceChildren()
})

describe('findLocations', () => {
  it('finds nothing for an empty query', () => {
    expect(findLocations(places, '   ')).toEqual([])
  })

  it('puts names that start with the text first, then by kind, then by name', () => {
    expect(names(findLocations(places, 'balm'))).toEqual(['Balmora', 'Balmora, Guild of Mages', 'Old Balmora Shack'])
  })

  it('ignores case and finds the Russian names too', () => {
    expect(names(findLocations(places, 'БАЛМ'))).toEqual(['Balmora'])
    expect(names(findLocations(places, 'горький'))).toEqual(['Bitter Coast'])
  })

  it('gives at most 30 results', () => {
    const many = Array.from({ length: 40 }, (_, index) => location('settlement', `Town ${index}`, index, 0))
    expect(findLocations(many, 'town')).toHaveLength(30)
  })
})

describe('the search box', () => {
  function open() {
    const onPick = vi.fn()
    const box = createSearch(places.map((place) => ({ ...place, set: pluginSet('base', { name: 'Morrowind' }) })), onPick)
    document.body.append(box)
    const input = box.querySelector('input')!
    const type = (text: string) => {
      input.value = text
      input.dispatchEvent(new Event('input'))
    }
    const results = () => [...box.querySelectorAll('.search-results li')].map((item) => item.textContent)
    return { box, input, type, results, onPick }
  }

  it('lists the places it finds with their kind and Plugin Set', () => {
    const { type, results } = open()
    type('bitter')
    expect(results()).toEqual(['Bitter CoastRegion · Morrowind'])
  })

  it('picks the first result on Enter and a result on click', () => {
    const { box, input, type, results, onPick } = open()
    type('balm')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ en: 'Balmora' }))
    expect([input.value, results()]).toEqual(['Balmora', []])
    type('old')
    box.querySelector<HTMLButtonElement>('.search-results button')!.click()
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ en: 'Old Balmora Shack' }))
  })

  it('clears on Escape and closes the list on a click elsewhere', () => {
    const { input, type, results } = open()
    type('balm')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect([input.value, results()]).toEqual(['', []])
    type('balm')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(results()).toEqual([])
  })

  it('relabels itself after a language switch', () => {
    const { input, type, results } = open()
    type('bitter')
    setLang('ru')
    expect(input.placeholder).toBe('Поиск локации')
    expect(results()).toEqual(['Bitter CoastРегион · Morrowind'])
  })

  it('keeps the picked place in the box, by its name in the new language', () => {
    const { input, type, onPick } = open()
    type('balmora')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    // The page gives every Location its name in the new language before the box hears of the switch.
    onPick.mock.lastCall![0].name = 'Балмора'
    setLang('ru')
    expect(input.value).toBe('Балмора')
  })
})
