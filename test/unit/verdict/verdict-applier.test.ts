import { describe, expect, it, vi } from "vitest";

import type {
  ApplierContext,
  ApplierGateway
} from "../../../src/verdict/applier-context.js";
import type { OpenBoxVerdict } from "../../../src/verdict/openbox-verdict.js";
import {
  applyVerdict,
  VerdictNotImplementedError
} from "../../../src/verdict/verdict-applier.js";

interface BuildContext {
  ctx: ApplierContext;
  envelope: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn> };
}

function buildContext(
  gateway: ApplierGateway = "agui_event"
): BuildContext {
  const envelope = vi.fn();
  const logger = { warn: vi.fn() };
  const ctx: ApplierContext = {
    auditEnvelope: envelope,
    event: {
      activityId: "act-1",
      attempt: 0,
      runId: "run-1",
      workflowId: "wf-1"
    },
    gateway,
    logger,
    subject: { name: "set_theme", type: "tool" }
  };
  return { ctx, envelope, logger };
}

describe("applyVerdict — wired cases", () => {
  it("returns continue and audits pre_execution_allowed for an allow verdict", () => {
    const { ctx, envelope } = buildContext();
    const verdict: OpenBoxVerdict = { reason: "ok", type: "allow" };

    const result = applyVerdict(verdict, ctx);

    expect(result).toEqual({ kind: "continue" });
    expect(envelope).toHaveBeenCalledTimes(1);
    expect(envelope).toHaveBeenCalledWith({
      "openbox.allow_reason": "ok",
      "openbox.enforcement_status": "pre_execution_allowed"
    });
  });

  it("audits without allow_reason when verdict.reason is absent", () => {
    const { ctx, envelope } = buildContext();
    applyVerdict({ type: "allow" }, ctx);
    expect(envelope).toHaveBeenCalledWith({
      "openbox.enforcement_status": "pre_execution_allowed"
    });
  });

  it("returns halt and audits pre_execution_blocked for a block verdict", () => {
    const { ctx, envelope } = buildContext();
    const verdict: OpenBoxVerdict = {
      reason: "policy denied",
      type: "block"
    };

    const result = applyVerdict(verdict, ctx);

    expect(result).toEqual({ kind: "halt", reason: "policy denied" });
    expect(envelope).toHaveBeenCalledTimes(1);
    expect(envelope).toHaveBeenCalledWith({
      "openbox.block_reason": "policy denied",
      "openbox.enforcement_status": "pre_execution_blocked"
    });
  });
});

describe("applyVerdict — deferred cases audit before throwing", () => {
  it("constrain audits late_detection then throws VerdictNotImplementedError", () => {
    const { ctx, envelope } = buildContext();
    let auditCalledFirst = false;
    envelope.mockImplementation(() => {
      auditCalledFirst = true;
    });

    expect(() =>
      applyVerdict(
        {
          constraints: [{ path: "$.x", type: "redact" }],
          reason: "constrain",
          type: "constrain"
        },
        ctx
      )
    ).toThrow(VerdictNotImplementedError);

    expect(auditCalledFirst).toBe(true);
    expect(envelope).toHaveBeenCalledWith({
      "openbox.constraint_count": 1,
      "openbox.deferred_verdict_type": "constrain",
      "openbox.enforcement_status": "late_detection"
    });
  });

  it("require_approval audits late_detection then throws", () => {
    const { ctx, envelope } = buildContext();
    expect(() =>
      applyVerdict(
        {
          approval_id: "appr-1",
          mode: "polling",
          reason: "approval",
          type: "require_approval"
        },
        ctx
      )
    ).toThrow(VerdictNotImplementedError);
    expect(envelope).toHaveBeenCalledWith({
      "openbox.approval_id": "appr-1",
      "openbox.deferred_verdict_type": "require_approval",
      "openbox.enforcement_status": "late_detection"
    });
  });

  it("halt audits halt_requested then throws", () => {
    const { ctx, envelope } = buildContext();
    expect(() =>
      applyVerdict(
        {
          code: "SAFETY",
          halt_scope: "copilot_run",
          reason: "halt",
          type: "halt"
        },
        ctx
      )
    ).toThrow(VerdictNotImplementedError);
    expect(envelope).toHaveBeenCalledWith({
      "openbox.deferred_verdict_type": "halt",
      "openbox.enforcement_status": "halt_requested",
      "openbox.halt_code": "SAFETY",
      "openbox.halt_scope": "copilot_run"
    });
  });

  it("halt audits without optional code/halt_scope when absent", () => {
    const { ctx, envelope } = buildContext();
    expect(() =>
      applyVerdict({ reason: "halt", type: "halt" }, ctx)
    ).toThrow(VerdictNotImplementedError);
    expect(envelope).toHaveBeenCalledWith({
      "openbox.deferred_verdict_type": "halt",
      "openbox.enforcement_status": "halt_requested"
    });
  });
});

describe("applyVerdict — defensive default", () => {
  it("throws VerdictNotImplementedError on an unknown discriminator", () => {
    const { ctx } = buildContext();
    const malformed = { reason: "x", type: "throttle" } as unknown as OpenBoxVerdict;
    expect(() => applyVerdict(malformed, ctx)).toThrow(
      VerdictNotImplementedError
    );
  });
});
