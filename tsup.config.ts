import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/main.mts' },
  format: 'cjs',             // CommonJS output
  target: 'node20',
  outDir: 'dist',
  sourcemap: false,
  bundle: true,
  clean: true,
  splitting: false,
  minify: false,
  skipNodeModulesBundle: false, // very important
  noExternal: [
    '@actions/core',
    '@actions/github',
    '@octokit/action',
    '@octokit/plugin-retry',
    '@octokit/plugin-throttling',
    'p-limit',
    'p-retry',
  ],
})