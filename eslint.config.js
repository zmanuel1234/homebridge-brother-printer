'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

const style = {
  'quotes': ['error', 'single', { avoidEscape: true }],
  'semi': ['error', 'always'],
  'comma-dangle': ['error', 'always-multiline'],
  'eqeqeq': ['error', 'always'],
  'curly': ['error', 'all'],
  'no-var': 'error',
  'prefer-const': 'error',
};

module.exports = tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: style,
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: style,
  },
);
