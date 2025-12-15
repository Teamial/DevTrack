// eslint.config.mjs
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';

const mochaGlobals = {
  suite: 'readonly',
  test: 'readonly',
  setup: 'readonly',
  teardown: 'readonly',
  suiteSetup: 'readonly',
  suiteTeardown: 'readonly',
};

export default [
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', 'temp-test/**'],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      // Prefer TS-aware unused vars rule for TS files
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // VS Code extensions run on Node; avoid noisy JS-only undefined checks in TS
      'no-undef': 'off',

      'no-console': 'warn',
      'no-empty': 'warn',
      'no-debugger': 'warn',
      'no-alert': 'warn',
      'no-eval': 'warn',
      'no-implied-eval': 'warn',
      'no-multi-str': 'warn',
      'no-template-curly-in-string': 'warn',
      'no-unreachable': 'warn',
      'no-useless-escape': 'warn',

      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      semi: ['warn', 'always'],

      // Formatting: keep as warn locally; CI can choose to treat warnings as failures later.
      'prettier/prettier': 'warn',
    },
  },
  {
    files: ['src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: mochaGlobals,
    },
  },
];
