import assert from 'node:assert/strict';

import {
  EMPLOYEE_ROLES,
  deriveDisplayStatus,
  isSignInEligible,
  isValidEmail,
  normaliseEmail,
} from '../contracts/employee';

describe('employee display status', () => {
  it('maps inactive accounts to Inactive regardless of verification', () => {
    assert.equal(deriveDisplayStatus('INACTIVE', 'VERIFIED'), 'Inactive');
    assert.equal(
      deriveDisplayStatus('INACTIVE', 'PENDING_VERIFICATION'),
      'Inactive',
    );
  });

  it('maps unverified active accounts to Pending', () => {
    assert.equal(
      deriveDisplayStatus('ACTIVE', 'PENDING_VERIFICATION'),
      'Pending',
    );
  });

  it('maps verified active accounts to Active', () => {
    assert.equal(deriveDisplayStatus('ACTIVE', 'VERIFIED'), 'Active');
  });
});

describe('sign-in eligibility', () => {
  it('requires both Active status and Verified email', () => {
    assert.equal(isSignInEligible('ACTIVE', 'VERIFIED'), true);
    assert.equal(isSignInEligible('ACTIVE', 'PENDING_VERIFICATION'), false);
    assert.equal(isSignInEligible('INACTIVE', 'VERIFIED'), false);
    assert.equal(isSignInEligible('INACTIVE', 'PENDING_VERIFICATION'), false);
  });
});

describe('email normalisation', () => {
  it('trims and lowercases so comparison is case-insensitive', () => {
    assert.equal(
      normaliseEmail('  Employee@Example.COM '),
      'employee@example.com',
    );
  });

  it('accepts ordinary addresses and rejects malformed ones', () => {
    assert.equal(isValidEmail('employee@example.com'), true);
    assert.equal(isValidEmail('employee@example'), false);
    assert.equal(isValidEmail('employee example.com'), false);
    assert.equal(isValidEmail(''), false);
  });

  it('rejects malformed domains and dotted local parts', () => {
    for (const bad of [
      'a@b..c',
      'a@.b.c',
      'a@b.c.',
      'a@-b.com',
      'a@b-.com',
      'a@b.c',
      'a@b.c0m',
      '.a@b.com',
      'a.@b.com',
      'a..b@b.com',
    ]) {
      assert.equal(isValidEmail(bad), false, bad);
    }
    for (const good of [
      'first.last+tag@sub.example.co.uk',
      'admin@ilovelearningguide.com',
      'x@xn--fiqs8s.com',
      ' Mixed.Case@Example.COM ',
    ]) {
      assert.equal(isValidEmail(good), true, good);
    }
  });
});

describe('role catalogue', () => {
  it('exposes exactly the six PRD roles in fixed order', () => {
    assert.deepEqual(
      [...EMPLOYEE_ROLES],
      [
        'ADMIN',
        'COURSE_CREATOR',
        'GRAPHIC_DESIGNER',
        'FINANCE',
        'OPERATION_ADMIN',
        'OPERATION_AI',
      ],
    );
  });
});
