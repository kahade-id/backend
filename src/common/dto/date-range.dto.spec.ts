import { DateRangePreset, getDateRangeFromPreset } from './date-range.dto';

describe('getDateRangeFromPreset', () => {
  afterEach(() => jest.useRealTimers());

  it('uses the WIB calendar for the today preset near midnight UTC', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T18:30:00.000Z'));

    const range = getDateRangeFromPreset(DateRangePreset.TODAY);

    expect(range.startDate).toEqual(new Date('2026-08-20T17:00:00.000Z'));
    expect(range.endDate).toEqual(new Date('2026-08-21T16:59:59.999Z'));
  });

  it('uses full WIB calendar boundaries for yesterday and last month', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-01T01:00:00.000Z'));

    const yesterday = getDateRangeFromPreset(DateRangePreset.YESTERDAY);
    const lastMonth = getDateRangeFromPreset(DateRangePreset.LAST_MONTH);

    expect(yesterday).toEqual({
      startDate: new Date('2026-02-27T17:00:00.000Z'),
      endDate: new Date('2026-02-28T16:59:59.999Z'),
    });
    expect(lastMonth).toEqual({
      startDate: new Date('2026-01-31T17:00:00.000Z'),
      endDate: new Date('2026-02-28T16:59:59.999Z'),
    });
  });
});
