import {defineConfig, globalIgnores} from 'eslint/config'
import {fixupConfigRules} from '@eslint/compat'
import js from '@eslint/js'
import {FlatCompat} from '@eslint/eslintrc'
import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import globals from 'globals'
import jest from 'eslint-plugin-jest'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all
})

export default defineConfig([
  globalIgnores(['**/dist/**', '**/lib/**', '**/node_modules/**']),
  {
    files: ['**/*.ts', '**/*.mts'],
    extends: fixupConfigRules(
      compat.extends(
        'eslint:recommended',
        'plugin:import/errors',
        'plugin:import/warnings',
        'plugin:import/typescript'
        // prettier config removed!
      )
    ),
    plugins: {
      jest,
      '@typescript-eslint': typescriptEslint
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json'
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...jest.environments.globals.globals,
        globalThis: false
      }
    },
    rules: {
      'import/no-unresolved': 'off', 
      'i18n-text/no-en': 'off',
      'no-empty-pattern': 'off',
    }
  }
])
