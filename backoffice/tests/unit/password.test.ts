import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashPassword, verifyPassword } from "@/modules/user-authentication/services/password";

describe("password hashing", () => {
  it("verifies a matching password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("wrong password value", stored), false);
  });

  it("never stores the plaintext and uses a unique salt per account", async () => {
    const first = await hashPassword("same-password-value");
    const second = await hashPassword("same-password-value");

    assert.equal(first.includes("same-password-value"), false);
    assert.notEqual(first, second);

    const [, , , , firstSalt] = first.split("$");
    const [, , , , secondSalt] = second.split("$");
    assert.notEqual(firstSalt, secondSalt);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    assert.equal(await verifyPassword("anything", "not-a-hash"), false);
    assert.equal(await verifyPassword("anything", "scrypt$16384$8$1$"), false);
  });
});
