import {
  getCronRuntimeSnapshots,
  markCronCompleted,
  markCronFailed,
  markCronStarted,
  registerCronRuntime,
  resetCronRuntimeSnapshots,
} from './cron-runtime.registry';

describe('cron runtime registry', () => {
  beforeEach(() => resetCronRuntimeSnapshots());

  it('tracks a successful invocation and clears failure state', () => {
    registerCronRuntime('job-a');
    markCronStarted('job-a');
    expect(getCronRuntimeSnapshots()[0]).toMatchObject({ name: 'job-a', running: true });
    markCronCompleted('job-a');
    expect(getCronRuntimeSnapshots()[0]).toMatchObject({ name: 'job-a', running: false, consecutiveFailures: 0 });
  });

  it('tracks consecutive failures and bounded error text', () => {
    markCronFailed('job-b', new Error('failure'));
    markCronFailed('job-b', 'second failure');
    expect(getCronRuntimeSnapshots()[0]).toMatchObject({
      name: 'job-b',
      running: false,
      consecutiveFailures: 2,
      lastError: 'second failure',
    });
  });
});
