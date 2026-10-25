import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * Deliberately focused on finding real bugs rather than enforcing formatting:
 * the goal is to keep `npm run lint` useful and fast enough to run every time,
 * not to bikeshed style. Type-aware rules are enabled for TypeScript because
 * they catch genuine mistakes (floating promises, unsafe awaits) that plain
 * syntax rules miss.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.data/**',
      '*.log',
      'openai-openapi.yaml',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- browser-side TypeScript -------------------------------------------
  {
    files: ['src/client/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // On a live call, a promise nobody awaits is a lost reply or a leaked listener.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },

  // ---- server-side TypeScript -------------------------------------------
  {
    files: ['src/server/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The server logs structured JSON on purpose; console IS the sink here.
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },

  // ---- tests -------------------------------------------------------------
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },

  // ---- node scripts and the extension -----------------------------------
  {
    files: ['scripts/**/*.{mjs,js,cjs}', '*.config.{js,ts,mjs}', 'vite.config.ts'],
    languageOptions: {
      // Browser globals too: Playwright's page.evaluate() callbacks execute in
      // the page, so `document`/`window`/`chrome` are legitimate there.
      globals: { ...globals.node, ...globals.browser, chrome: 'readonly' },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // `cond ? pass('x') : fail('x')` is the terse assertion idiom used by the
      // verification scripts; it is intentional, not a forgotten assignment.
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    files: ['extension/src/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        chrome: 'readonly',
      },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
