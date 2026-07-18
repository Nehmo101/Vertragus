import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // `.vertragus-worktrees/**` is the canonical runtime worktree root;
    // `.orca-worktrees/**` is the legacy root still recognized (see docs/BRAND.md).
    ignores: ['node_modules/**', 'out/**', 'release/**', 'dist/**', '**/dist/**', 'coverage/**', '.vertragus-worktrees/**', '.orca-worktrees/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  }
)
