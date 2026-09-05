import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // Collect coverage from implementation files whose spec files exist in this repo.
  // auth.service, token.service, wallet.service, payment.service are covered by
  // E2E tests (jest-e2e.config.ts) rather than unit tests, so they are intentionally
  // excluded here to keep the 70% threshold meaningful.
  collectCoverageFrom: [
    'modules/auth/otp.service.ts',
    'modules/orders/orders.service.ts',
    'modules/orders/order-state.service.ts',
    'modules/orders/fee-calculator.service.ts',
    'common/utils/crypto.util.ts',
    'common/dto/pagination.dto.ts',
    'config/env.validation.ts',
  ],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/common/$1',
    '^@config/(.*)$': '<rootDir>/config/$1',
    '^@modules/(.*)$': '<rootDir>/modules/$1',
    '^@prisma-service/(.*)$': '<rootDir>/prisma/$1',
  },
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};

export default config;
