// Lints the MCP server (mcp/). The rest of the repo is not linted yet.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'dist/**', 'apps/**', 'public/**', 'tmp/**'] },
  {
    files: ['mcp/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Adapters implement async ports without awaiting anything; that is the point of the port.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: 'error',
      'no-console': 'error',
    },
  },
  {
    // The runtime bundle must not pull in build-time code: parse5, the registry and the
    // filesystem crawl stay in mcp/build/.
    files: ['mcp/src/**/*.ts', 'mcp/search-index/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'parse5', message: 'HTML extraction is build-time only (mcp/build/).' }],
          patterns: [
            { group: ['**/build/**', '**/build/*.ts'], message: 'Runtime code must not import mcp/build/.' },
            { group: ['**/src/utils/**'], message: 'Runtime code must not import the Astro build utilities.' },
          ],
        },
      ],
    },
  },
);
