import { defineConfig, type Connect, type Plugin } from 'vite'

/**
 * Lets the browser keep map tiles. Their address carries the build they belong to, so a tile
 * never changes under the same address.
 */
function cacheTiles(): Plugin {
  const handle: Connect.NextHandleFunction = (request, response, next) => {
    if (request.url?.includes('/data/tiles/')) {
      const setHeader = response.setHeader.bind(response)
      response.setHeader = (name, value) =>
        setHeader(name, name.toLowerCase() === 'cache-control' ? 'public, max-age=31536000, immutable' : value)
    }
    next()
  }
  return {
    name: 'cache-tiles',
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  }
}

export default defineConfig({
  // Relative paths, so the site works both under a GitHub Pages subfolder and on its own domain.
  base: './',
  plugins: [cacheTiles()],
  server: {
    // The map data is a hundred thousand files; watching them stalls the dev server for a minute.
    watch: { ignored: ['**/public/data/**'] },
  },
})
