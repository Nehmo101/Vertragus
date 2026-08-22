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
     * The phone bundle may take TYPES from the wire schemas and nothing else.
     * `protocol.ts` imports zod, so a single value import — one integer — puts
     * 57 kB (13 kB gzipped) of a validator the client never runs into the entry
     * chunk of a page loaded over a tailnet. That regression shipped once,
     * passed every typecheck, every test and every lint, and was found by
     * weighing the bundle. Constants both sides need live in
     * `@shared/remote/limits`, which has no dependencies; types stay here and
     * cost nothing, because they erase.
     */
    files: ['src/remoteClient/**/*.{ts,tsx}'],
    ignores: ['src/remoteClient/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@shared/remote/protocol',
              allowTypeImports: true,
              message:
                'Import types only. A value import pulls zod into the phone bundle — put shared constants in @shared/remote/limits.'
            }
          ]
        }
      ]
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
