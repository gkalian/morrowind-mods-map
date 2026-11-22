import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadManifest } from './manifest'
import { fakeFetch, manifest } from './test-helpers'

afterEach(() => vi.unstubAllGlobals())

describe('loadManifest', () => {
  it('always asks the server, as it names the build of the tiles', async () => {
    const fetch = vi.fn(fakeFetch({ 'data/manifest.json': manifest(['morrowind']) }))
    vi.stubGlobal('fetch', fetch)
    expect((await loadManifest()).sets[0].id).toBe('morrowind')
    expect(fetch).toHaveBeenCalledWith('data/manifest.json', { cache: 'no-cache' })
  })

  it('tells to run the pipeline when there is no map data', async () => {
    vi.stubGlobal('fetch', fakeFetch({}))
    await expect(loadManifest()).rejects.toThrow('Could not load the map data (404). Run the pipeline first.')
  })
})
