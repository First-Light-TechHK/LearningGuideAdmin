import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyTokenState,
  tokenStateToErrorCode,
} from "@/modules/user-authentication/services/verificationTokens";

const NOW = new Date("2026-10-22T12:00:00Z").getTime();
const FUTURE = new Date(NOW + 60 * 60 * 1000);
const PAST = new Date(NOW - 1000);

describe("token state classification", () => {
  it("treats a missing record as NOT_FOUND", () => {
    assert.equal(classifyTokenState(null, NOW), "NOT_FOUND");
  });

  it("classifies an unconsumed, unrevoked, future token as USABLE", () => {
    assert.equal(
      classifyTokenState({ consumedAt: null, revokedAt: null, expiresAt: FUTURE }, NOW),
      "USABLE"
    );
  });

  it("classifies an expired token as EXPIRED", () => {
    assert.equal(
      classifyTokenState({ consumedAt: null, revokedAt: null, expiresAt: PAST }, NOW),
      "EXPIRED"
    );
  });

  it("treats a token expiring exactly now as EXPIRED", () => {
    assert.equal(
      classifyTokenState(
        { consumedAt: null, revokedAt: null, expiresAt: new Date(NOW) },
        NOW
      ),
      "EXPIRED"
    );
  });

  it("prefers USED over EXPIRED for an already consumed token", () => {
    assert.equal(
      classifyTokenState({ consumedAt: new Date(NOW - 5000), revokedAt: null, expiresAt: PAST }, NOW),
      "USED"
    );
  });

  it("prefers REVOKED over EXPIRED for a replaced token", () => {
    assert.equal(
      classifyTokenState(
        { consumedAt: null, revokedAt: new Date(NOW - 5000), expiresAt: PAST },
        NOW
      ),
      "REVOKED"
    );
  });
});

describe("token state to error code", () => {
  it("maps EXPIRED to a dedicated code (PORT-ACT-003)", () => {
    assert.equal(tokenStateToErrorCode("EXPIRED"), "TOKEN_EXPIRED");
  });

  it("maps USED and REVOKED to already-used", () => {
    assert.equal(tokenStateToErrorCode("USED"), "TOKEN_ALREADY_USED");
    assert.equal(tokenStateToErrorCode("REVOKED"), "TOKEN_ALREADY_USED");
  });

  it("maps NOT_FOUND and USABLE to the generic invalid code", () => {
    assert.equal(tokenStateToErrorCode("NOT_FOUND"), "INVALID_TOKEN");
    assert.equal(tokenStateToErrorCode("USABLE"), "INVALID_TOKEN");
  });
});
