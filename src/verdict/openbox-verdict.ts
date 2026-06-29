import { z } from "zod";

/**
 * Discriminated-union projection of an OpenBox governance verdict. Some
 * verdicts are exposed before every enforcement mode has a runtime
 * implementation, so appliers may surface `VerdictNotImplementedError`.
 */
export type OpenBoxVerdict =
  | { type: "allow"; reason?: string }
  | { type: "constrain"; reason: string; constraints: OpenBoxConstraint[] }
  | OpenBoxRequireApprovalVerdict
  | { type: "block"; reason: string; replacement?: OpenBoxReplacement }
  | OpenBoxHaltVerdict;

export interface OpenBoxRequireApprovalVerdict {
  approval_id: string;
  constraints?: OpenBoxConstraint[];
  mode: "polling";
  on_approved?: "allow" | "constrain";
  on_expired?: "block" | "halt";
  on_failed?: "block" | "halt";
  on_rejected?: "block" | "halt";
  poll_interval_ms?: number;
  reason: string;
  timeout_ms?: number;
  type: "require_approval";
}

export interface OpenBoxHaltVerdict {
  code?: string;
  halt_scope?: "copilot_run" | "stream" | "tool" | "sub_agent_report";
  reason: string;
  type: "halt";
}

export type OpenBoxConstraint =
  | { path: string; replacement?: unknown; type: "redact" }
  | { path: string; type: "rewrite"; value: unknown }
  | { path: string; type: "remove-context" }
  | { args: Record<string, unknown>; type: "narrow-tool-args" }
  | { key: string; type: "add-metadata"; value: unknown };

export interface OpenBoxReplacement {
  message?: string;
  tool_result?: unknown;
}

const OpenBoxConstraintSchema = z.union([
  z.object({
    path: z.string(),
    replacement: z.unknown().optional(),
    type: z.literal("redact")
  }),
  z.object({
    path: z.string(),
    type: z.literal("rewrite"),
    value: z.unknown()
  }),
  z.object({
    path: z.string(),
    type: z.literal("remove-context")
  }),
  z.object({
    args: z.record(z.string(), z.unknown()),
    type: z.literal("narrow-tool-args")
  }),
  z.object({
    key: z.string(),
    type: z.literal("add-metadata"),
    value: z.unknown()
  })
]);

const OpenBoxReplacementSchema = z.object({
  message: z.string().optional(),
  tool_result: z.unknown().optional()
});

export const OpenBoxVerdictSchema = z.discriminatedUnion("type", [
    z.object({
      reason: z.string().optional(),
      type: z.literal("allow")
    }),
    z.object({
      constraints: z.array(OpenBoxConstraintSchema),
      reason: z.string(),
      type: z.literal("constrain")
    }),
    z.object({
      approval_id: z.string(),
      constraints: z.array(OpenBoxConstraintSchema).optional(),
      mode: z.literal("polling"),
      on_approved: z.enum(["allow", "constrain"]).optional(),
      on_expired: z.enum(["block", "halt"]).optional(),
      on_failed: z.enum(["block", "halt"]).optional(),
      on_rejected: z.enum(["block", "halt"]).optional(),
      poll_interval_ms: z.number().optional(),
      reason: z.string(),
      timeout_ms: z.number().optional(),
      type: z.literal("require_approval")
    }),
    z.object({
      reason: z.string(),
      replacement: OpenBoxReplacementSchema.optional(),
      type: z.literal("block")
    }),
    z.object({
      code: z.string().optional(),
      halt_scope: z
        .enum(["copilot_run", "stream", "tool", "sub_agent_report"])
        .optional(),
      reason: z.string(),
      type: z.literal("halt")
    })
  ]);

export { OpenBoxConstraintSchema, OpenBoxReplacementSchema };
