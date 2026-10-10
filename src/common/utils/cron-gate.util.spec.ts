import { isCronJobDisabled } from './cron-gate.util';

describe('isCronJobDisabled (K8 feature-flag cron)', () => {
  it('false bila env kosong', () => {
    expect(isCronJobDisabled('auto-complete-orders', {})).toBe(false);
    expect(isCronJobDisabled('auto-complete-orders', { CRON_DISABLED_JOBS: '' })).toBe(false);
  });

  it('true hanya untuk job yang terdaftar (spasi diabaikan)', () => {
    const env = { CRON_DISABLED_JOBS: ' auto-complete-orders , returns-seller-sla ' };
    expect(isCronJobDisabled('auto-complete-orders', env)).toBe(true);
    expect(isCronJobDisabled('returns-seller-sla', env)).toBe(true);
    expect(isCronJobDisabled('dispute-settlement-sweep', env)).toBe(false);
  });

  it('"*" mematikan semua job', () => {
    expect(isCronJobDisabled('apa-saja', { CRON_DISABLED_JOBS: '*' })).toBe(true);
  });
});
