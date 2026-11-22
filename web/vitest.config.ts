import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests live next to the code they test.
    include: ['src/**/*.test.ts'],
    // The modules read the address, the browser's language and storage as they load, and
    // Leaflet needs a window: a light browser stands in for the real one.
    environment: 'happy-dom',
    environmentOptions: { happyDOM: { url: 'http://localhost/' } },
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/test-helpers.ts'],
      // A table in the console, a page to browse, and a summary the CI turns into its report.
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
