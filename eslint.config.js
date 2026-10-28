import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.npm/**', '.cache/**'] },
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,mts}'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      // Dynamic host services, HTTP payloads and test doubles have explicit boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['lib/client.ts'],
    languageOptions: { globals: globals.browser },
    // This entry must remain a browser script without runtime ESM imports.
    rules: { '@typescript-eslint/triple-slash-reference': ['error', { path: 'always' }] },
  },
])
