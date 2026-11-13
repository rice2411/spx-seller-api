// CommonJS on purpose: the package has no "type": "module", and this keeps Node from guessing the module format.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const { defineConfig } = require('eslint/config');

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  require: 'readonly',
  module: 'writable',
};

module.exports = defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: nodeGlobals },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['eslint.config.js'],
    rules: {
      // This file is CommonJS (see top) — `require` is the only way to load its dependencies.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
