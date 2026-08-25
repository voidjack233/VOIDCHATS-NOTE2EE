import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['**/*.{js,mjs,cjs,ts,mts,cts}'];
const ignoredFiles = [
  'bin/**',
  'cmd/**',
  'dist/**',
  'internal/**',
  'node_modules/**',
  'void_gateway/**',
];

export default tseslint.config(
  { ignores: ignoredFiles },
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    rules: {
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      'no-unused-vars': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      'no-control-regex': 'off',
      'no-undef': 'off',
      // Preserve intentional local secret/state clearing during the language migration.
      'no-useless-assignment': 'off',
    },
  },
);
