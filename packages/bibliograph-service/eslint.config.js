import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-restricted-types': ['error', {
        types: {
          never: {
            message: 'Avoid `never`. Use a runtime `default:` throw for unhandled cases.',
          },
        },
      }],
      'no-restricted-syntax': ['error',
        {
          selector: 'TSAsExpression > TSAnyKeyword',
          message: 'Avoid `as any` — use a precise type.',
        },
        {
          selector: 'TSAsExpression[typeAnnotation.typeName.name="never"]',
          message: 'Avoid `as never` — use a precise type.',
        },
      ],
      // Noise rules — out of scope for the any/never hardening goal.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'prefer-const': 'off',
      'no-constant-condition': 'off',
      'no-empty': 'off',
    },
  },
  {
    ignores: [
      '.svelte-kit/**',
      'build/**',
      'node_modules/**',
      'lexicons/**',
      'data/**',
      'logs/**',
      'drizzle/**',
      // Auto-generated lex types use empty interfaces and patterns out of our control.
      'src/lib/server/lexicons/types/**',
    ],
  },
);
