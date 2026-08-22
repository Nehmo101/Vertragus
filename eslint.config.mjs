import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'out/**', 'release/**', 'dist/**', '**/dist/**', 'coverage/**']
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
    /*
     * Both React surfaces, not just the panel. `RemoteTerminal.tsx` rests on
     * one invariant — nothing outside `agentId` may enter the terminal
     * effect's dependency array, or the terminal is rebuilt on every workspace
     * push and the reader loses the scrollback — and `exhaustive-deps` is the
     * rule that both proves it today and would fail loudly on a regression.
     * Stating it in a comment is not a guard.
     */
    files: ['src/renderer/**/*.{ts,tsx}', 'src/remoteClient/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  }
)
