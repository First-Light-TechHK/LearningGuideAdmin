import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EMPLOYEE_ROLES, deriveDisplayStatus, isSignInEligible, isValidEmail, normaliseEmail } from "@/contracts/employee";

describe("employee display status", () => {
  it("maps inactive accounts to Inactive regardless of verification", () => {
    assert.equal(deriveDisplayStatus("INACTIVE", "VERIFIED"), "Inactive");
    assert.equal(deriveDisplayStatus("INACTIVE", "PENDING_VERIFICATION"), "Inactive");
  });

  it("maps unverified active accounts to Pending", () => {
    assert.equal(deriveDisplayStatus("ACTIVE", "PENDING_VERIFICATION"), "Pending");
  });

  it("maps verified active accounts to Active", () => {
    assert.equal(deriveDisplayStatus("ACTIVE", "VERIFIED"), "Active");
  });
});

describe("sign-in eligibility", () => {
  it("requires both Active status and Verified email", () => {
    assert.equal(isSignInEligible("ACTIVE", "VERIFIED"), true);
    assert.equal(isSignInEligible("ACTIVE", "PENDING_VERIFICATION"), false);
    assert.equal(isSignInEligible("INACTIVE", "VERIFIED"), false);
    assert.equal(isSignInEligible("INACTIVE", "PENDING_VERIFICATION"), false);
  });
});

describe("email normalisation", () => {
  it("trims and lowercases so comparison is case-insensitive", () => {
    assert.equal(normaliseEmail("  Employee@Example.COM "), "employee@example.com");
  });

  it("accepts ordinary addresses and rejects malformed ones", () => {
    assert.equal(isValidEmail("employee@example.com"), true);
    assert.equal(isValidEmail("employee@example"), false);
    assert.equal(isValidEmail("employee example.com"), false);
    assert.equal(isValidEmail(""), false);
  });
});

describe("role catalogue", () => {
  it("exposes exactly the six PRD roles in fixed order", () => {
    assert.deepEqual([...EMPLOYEE_ROLES], [
      "ADMIN",
      "COURSE_CREATOR",
      "GRAPHIC_DESIGNER",
      "FINANCE",
      "OPERATION_ADMIN",
      "OPERATION_AI",
    ]);
  });
});
