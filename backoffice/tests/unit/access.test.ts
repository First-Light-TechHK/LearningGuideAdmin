import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideEmployeeAccountAccess,
  decideMenuAccess,
} from "@/modules/rbac/access";

describe("employee account guard", () => {
  it("rejects an unauthenticated caller with 401 semantics", () => {
    const decision = decideEmployeeAccountAccess(null);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "INVALID_EMPLOYEE_ACCOUNT");
  });

  it("rejects an authenticated non-admin with 403 semantics", () => {
    const decision = decideEmployeeAccountAccess({ role: "OPERATION_ADMIN" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "NOT_AUTHORISED");
  });

  it("allows Admin", () => {
    assert.equal(decideEmployeeAccountAccess({ role: "ADMIN" }).allowed, true);
  });
});

describe("menu guard", () => {
  it("rejects an unauthenticated caller", () => {
    const decision = decideMenuAccess(null, "course");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "INVALID_EMPLOYEE_ACCOUNT");
  });

  it("rejects Operation Admin on Knowledge and AI Tutor", () => {
    assert.equal(decideMenuAccess({ role: "OPERATION_ADMIN" }, "knowledge").allowed, false);
    assert.equal(decideMenuAccess({ role: "OPERATION_ADMIN" }, "aiTutor").allowed, false);
  });

  it("allows Operation Admin on Order and HelpDesk", () => {
    assert.equal(decideMenuAccess({ role: "OPERATION_ADMIN" }, "order").allowed, true);
    assert.equal(decideMenuAccess({ role: "OPERATION_ADMIN" }, "helpDesk").allowed, true);
  });

  it("allows every role to reach Course and Settings", () => {
    for (const role of [
      "ADMIN",
      "COURSE_CREATOR",
      "GRAPHIC_DESIGNER",
      "FINANCE",
      "OPERATION_ADMIN",
      "OPERATION_AI",
    ] as const) {
      assert.equal(decideMenuAccess({ role }, "course").allowed, true, role);
      assert.equal(decideMenuAccess({ role }, "settings").allowed, true, role);
    }
  });
});
