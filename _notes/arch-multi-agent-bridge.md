---
type: arch
date: 2026-06-29
tags: [multi-agent, handoff, copilotkit, governance, openbox-core]
status: active
---

# Multi-Agent Bridge (CopilotKit parent → subagent child)

How CopilotKit runs represent themselves as the PARENT of an OpenBox multi-agent
session. Opt-in via `middlewareOptions.multiAgent.enabled` (default off → payloads
byte-identical to before). Implemented copilotkit-sdk side only; Mastra child + backend
are separate repos (see "Remaining").

## Wire contract (verified in `openbox-core/internal/content/governance.go`)

- Top-level payload fields: `multi_agent_session_id`, `parent_workflow_id` (*string), `from_agent_did` — all `omitempty`.
- Handoff `event_type` is exactly `"Handoff"`.
- `ValidateHandoffPayload` REQUIRES non-empty `multi_agent_session_id` AND `from_agent_did`.
- **Core derives the handoff's `to_agent` from the AUTHENTICATED emitter** (signed AIP headers). The wire carries `from_agent_did` (parent) but never `to_agent_did`. ⇒ the Handoff request MUST be sent with the CHILD's identity.

## Design decisions

- **Identity**: parent (CopilotKit) and child (e.g. Mastra) are DISTINCT OpenBox agents, each with own API key + DID. Same identity → self-to-self handoff (broken).
- **Handoff emission = parent-side + context-export** (`OpenBoxCopilotKitEmitter.emitHandoff(input, client?)`):
  - child creds configured → SDK builds a child-scoped `OpenBoxClient` and emits the Handoff signed as the child (so Core resolves `to_agent`). Self-contained.
  - no child creds → does NOT send (would mis-auth as parent); instead surfaces `OpenBoxMultiAgentContext` via `onEvent` (embedded at `metadata.openbox_multi_agent_context`) for a remote child to emit.
- **Where**: emitted right after the parent delegate-tool `ActivityStarted`, only on a non-blocking verdict, in `#maybeEmitHandoff`. Matches expected order: parent ActivityStarted → child Handoff → child WorkflowStarted.
- **Dedup** key: `mas::parentDid::childAgentName::parentActivityId` (`PerRunState.emittedHandoffs`). Backstop on top of `entry.activityStarted` early-return.
- **`multiAgentSessionId`** default = `mas:${runId}` (string or `(ctx) => string` override). Stored once per run in `PerRunState`.
- **parent_workflow_id** is NEVER set on the CopilotKit parent stream (it IS the parent). The field exists in emitter inputs for the child/wire shape; the child (Mastra) sets it. Structurally impossible on signal/activity inputs (field absent there).
- Handoff marker carries ONLY reserved keys (`delegate_tool_name`, `child_agent_name`, `child_workflow_type`, `child_task_queue`, `parent_activity_id`, `parent_workflow_id`, `openbox_multi_agent_context`) — request ALS metadata is intentionally NOT spread in (trust boundary; matches plan spec).

## Gotchas (would burn an hour to rediscover)

- **`src/types/workflow-event-type.ts` is a COPIED-VERBATIM file** (tracked in `COPIED_FROM.md` by SHA). Editing it fails `check:copied` until you update the Local SHA-256 column + flip status to Modified. Adding `HANDOFF` made it Modified. Same applies to any `src/types/*`, `src/client/*`, `test/unit/types.test.ts`, etc. — check `COPIED_FROM.md` before editing. Prefer adding tests in NON-copied files (e.g. `test/unit/copilotkit/*`).
- **`createOpenBoxMiddleware` runs per-request at `clone()` time**, inside `wrap-agent-in-proxy.ts attachOpenBoxToClone`'s catch-all that swallows→warns. So a constructor `throw` does NOT surface to the operator — it silently disables ALL governance for that agent. That's why multi-agent misconfig (enabled w/o parent DID) is validated EAGERLY in `wrapCopilotRuntimeOptions` (fails loud at `withOpenBoxRuntime()` setup); the constructor throw is kept only for the Pattern-2 manual path + as a unit-test seam.
- Multi-agent logic is fully error-isolated: `#maybeEmitHandoff` + `#buildChildClient` swallow→warn, never throw into the AG-UI observable (a bad child key degrades to context-export, doesn't drop the tool-call event).
- `middlewareOptions` flows to the middleware untouched via `wrap-agent-in-proxy.ts:135` — no wiring needed in the wrap layer for new options.

## Remaining (NOT done — separate repos)

- `openbox-mastra-sdk` (Phase 3): add `HANDOFF`, accept multi-agent context, stamp same `multi_agent_session_id` + `parent_workflow_id`. Without it the child session won't join the group.
- `openbox-backend` (Phase 4): `extractSignalText` must accept object-shaped `{ value }` signal args (this SDK's shape) in addition to the array shape.

See `plans/reports/implementation-260629-0455-copilotkit-multi-agent-bridge-report.md`.
