import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_STATUS, fail, ok } from "@/contracts/envelope";

describe("response envelope", () => {
  it("wraps success as success/data/error/message", () => {
    const envelope = ok({ value: 1 });
    assert.deepEqual(envelope, { success: true, data: { value: 1 }, error: null, message: "OK" });
  });

  it("wraps failure with a null payload and a stable error code", () => {
    const envelope = fail("NOT_AUTHORISED", "Admin only");
    assert.equal(envelope.success, false);
    assert.equal(envelope.data, null);
    assert.equal(envelope.error, "NOT_AUTHORISED");
    assert.equal(envelope.message, "Admin only");
  });
});

describe("http status mapping", () => {
  it("maps unauthenticated and unauthorised to 401 and 403", () => {
    assert.equal(ERROR_STATUS.INVALID_EMPLOYEE_ACCOUNT, 401);
    assert.equal(ERROR_STATUS.NOT_AUTHORISED, 403);
  });

  it("maps expired and already-used tokens to 410", () => {
    assert.equal(ERROR_STATUS.TOKEN_EXPIRED, 410);
    assert.equal(ERROR_STATUS.TOKEN_ALREADY_USED, 410);
  });

  it("maps duplicate email, rate limit and weak password to their statuses", () => {
    assert.equal(ERROR_STATUS.DUPLICATE_EMAIL, 409);
    assert.equal(ERROR_STATUS.RATE_LIMITED, 429);
    assert.equal(ERROR_STATUS.PASSWORD_TOO_WEAK, 400);
  });

  it("has a status for every declared error code", () => {
    const codes = Object.keys(ERROR_STATUS);
    assert.ok(codes.length >= 15);
    for (const code of codes) {
      const status = ERROR_STATUS[code as keyof typeof ERROR_STATUS];
      assert.equal(typeof status, "number");
      assert.ok(status >= 400 && status < 600, code);
    }
  });
});
