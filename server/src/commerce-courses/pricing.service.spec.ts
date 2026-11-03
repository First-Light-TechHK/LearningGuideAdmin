import { ConflictException } from '@nestjs/common';
import {
  PricingService,
  describeStripeSyncError,
  stripeLookupKey,
  stripeRecurring,
} from './pricing.service';

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
    expect(stripeRecurring(6)).toEqual({
      interval: 'month',
      interval_count: 6,
    });
  });

  it('explains a duplicate Stripe lookup key from the API error', () => {
    expect(
      describeStripeSyncError(
        new Error('Lookup key `SCI001_1m` has already been used.'),
      ),
    ).toContain('different billing period');
    expect(describeStripeSyncError(new Error('Card declined.'))).toBe(
      'Card declined.',
    );
  });
});

describe('PricingService.save', () => {
  function service() {
    const prisma = {
      commerceCourse: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'course-1', code: 'SCI001' }),
      },
    };
    return new PricingService(prisma as never, {} as never);
  }

  it('rejects two plans that would share one Stripe lookup key', async () => {
    await expect(
      service().save('course-1', [
        { name: '6 months', termMonths: 1, amountMinor: 1500 },
        { name: '12 months', termMonths: 1, amountMinor: 1000 },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
