import { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.e2e-spec.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/../src/common/$1',
    '^@config/(.*)$': '<rootDir>/../src/config/$1',
    '^@modules/(.*)$': '<rootDir>/../src/modules/$1',
    '^@prisma-service/(.*)$': '<rootDir>/../src/prisma/$1',
  },
};

export default config;
