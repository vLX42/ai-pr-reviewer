import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/main.mts',  // <-- key becomes output file name: dist/index.js
  },
  format: 'cjs',            // <-- CommonJS for GitHub Actions
  outDir: 'dist',
  target: 'node20',
  splitting: false,
  shims: true,
  dts: false,
  sourcemap: false,
  bundle: true,
  minify: false,
  clean: true,
  skipNodeModulesBundle: true,
})