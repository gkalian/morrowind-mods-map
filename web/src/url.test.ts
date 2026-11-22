import { afterEach, describe, expect, it } from 'vitest'
import { updateUrl } from './url'

afterEach(() => history.replaceState(null, '', '/'))

describe('updateUrl', () => {
  it('changes the query in place and keeps the rest of it', () => {
    history.replaceState(null, '', '/?lang=ru&x=1')
    const entries = history.length
    updateUrl((params) => {
      params.set('x', '2')
      params.delete('lang')
      params.set('transport', 'land,water')
    })
    expect(location.search).toBe('?x=2&transport=land%2Cwater')
    expect(history.length, 'no new history entry').toBe(entries)
  })
})
