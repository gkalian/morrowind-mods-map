import { afterEach, describe, expect, it, vi } from 'vitest'
import { LabelLayer } from './labels'
import type { Location } from './locations'
import { location, testMap } from './test-helpers'

afterEach(() => document.body.replaceChildren())

/** The names the layer draws, and the bare dots without a name. */
function drawn(map: L.Map) {
  const marks = [...map.getContainer().querySelectorAll('.loc')]
  return {
    names: marks.filter((mark) => mark.querySelector('span')).map((mark) => mark.textContent),
    dots: marks.filter((mark) => !mark.querySelector('span')).map((mark) => (mark as HTMLElement).title),
    selected: marks.filter((mark) => mark.classList.contains('loc-selected')).map((mark) => mark.textContent),
  }
}

describe('the names on the Map', () => {
  const balmora = location('settlement', 'Balmora', 0.5, 0.5, { size: 4 })
  const places: Location[] = [
    balmora,
    location('settlement', 'Pelagiad', 2, 0.5),
    location('region', 'West Gash', 0, 0),
    // Just below Balmora at zoom 8: its name would run into Balmora's.
    location('entrance', 'Balmora, Temple', 0.5, 0.45),
    location('settlement', 'Far Away', 500, 500),
  ]

  it('draws the kinds that belong to the zoom, within the view', () => {
    const map = testMap()
    new LabelLayer(map, places, () => true, () => {})
    expect(drawn(map).names).toEqual(['Balmora', 'Pelagiad'])
    map.setZoom(3)
    expect(drawn(map).names).toEqual(['West Gash'])
  })

  it('draws an Interior Entrance as a bare dot where its name would cover another', () => {
    const map = testMap()
    map.setZoom(8)
    new LabelLayer(map, places, () => true, () => {})
    expect(drawn(map)).toMatchObject({ names: ['Balmora'], dots: ['Balmora, Temple'] })
  })

  it('leaves out what is switched off, and always draws the selected Location, before the names it covers', () => {
    const map = testMap()
    const layer = new LabelLayer(map, places, (place) => place !== balmora, () => {})
    expect(drawn(map).names).toEqual(['Pelagiad'])
    map.setZoom(3)
    layer.select(balmora)
    expect(drawn(map)).toMatchObject({ names: ['Balmora'], selected: ['Balmora'] })
    layer.select(null)
    expect(drawn(map).names).toEqual(['West Gash'])
  })

  it('picks a Location when its name is clicked', () => {
    const map = testMap()
    const onPick = vi.fn()
    new LabelLayer(map, places, () => true, onPick)
    map.getContainer().querySelector<HTMLElement>('.loc')!.parentElement!.click()
    expect(onPick).toHaveBeenCalledWith(balmora)
  })
})
