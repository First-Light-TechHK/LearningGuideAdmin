import { stripeLookupKey, stripeRecurring } from './pricing.service';

describe('pricing helpers', () => {
  it('builds lookup keys as CourseID_period', () => {
    expect(stripeLookupKey('C001', 1)).toBe('C001_1m');
    expect(stripeLookupKey('C001', 12)).toBe('C001_12m');
  });

  it('maps 12 months to a yearly Stripe price', () => {
    expect(stripeRecurring(12)).toEqual({
      interval: 'year',
      interval_count: 1,
    });
    expect(stripeRecurring(1)).toEqual({
      interval: 'month',
      interval_count: 1,
    });
    expect(stripeRecurring(3)).toEqual({
      interval: 'month',
      interval_count: 3,
    });
  });
});
