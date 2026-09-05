/**
 * ESLint configuration for kahade-backend.
 *
 * Kept intentionally lean: rules cover hygiene that the type-checker doesn't
 * (unused imports/vars, common bug-prone patterns) without enforcing
 * stylistic preferences that conflict with Prettier.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: false,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    jest: true,
    es2022: true,
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    'prisma/',
    '*.js',
    '*.cjs',
    '*.mjs',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-empty-interface': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Stripping control characters is an intentional security pattern in chat/orders
    // sanitization and is by design.
    'no-control-regex': 'off',
    // Style-only escape warnings; not bug-finding.
    'no-useless-escape': 'warn',
    // Constant truthy guards exist as defensive checks (e.g. `if (true)` blocks
    // that are toggled during incident response).
    'no-constant-condition': ['error', { checkLoops: false }],
  },
  overrides: [
    {
      files: ['**/*.spec.ts', '**/tests/**/*.ts', 'test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-var-requires': 'off',
        'no-console': 'off',
        'no-useless-catch': 'off',
      },
    },
  ],
};
