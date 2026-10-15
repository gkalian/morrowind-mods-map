import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Connect, type Plugin } from 'vite'

/**
 * Lets the browser keep map tiles. Their address carries the build they belong to, so a tile
 * never changes under the same address. A tile that is not there, such as one asked for while
 * the pipeline rewrites its folder, is a plain 404 that is not kept: otherwise the server would
 * answer with the page itself, and the browser would keep that as the tile for a year.
 */
function cacheTiles(): Plugin {
  const handler =
    (root: string): Connect.NextHandleFunction =>
    (request, response, next) => {
      const path = request.url?.split('?')[0]
      const at = path?.indexOf('/data/tiles/') ?? -1
      if (path && at >= 0) {
        if (!existsSync(join(root, decodeURIComponent(path.slice(at))))) {
          response.statusCode = 404
          response.setHeader('Cache-Control', 'no-store')
          response.end()
          return
        }
        const setHeader = response.setHeader.bind(response)
        response.setHeader = (name, value) =>
          setHeader(name, name.toLowerCase() === 'cache-control' ? 'public, max-age=31536000, immutable' : value)
      }
      next()
    }
  return {
    name: 'cache-tiles',
    configureServer: (server) => void server.middlewares.use(handler(server.config.publicDir)),
    configurePreviewServer: (server) =>
      void server.middlewares.use(handler(join(server.config.root, server.config.build.outDir))),
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
