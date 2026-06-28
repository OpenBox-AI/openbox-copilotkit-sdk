# Copied Modules Manifest

Source repo: `openbox-mastra-sdk` at commit `33214f7d4b42d1047700b009ae74ae927bec8333`
Source repo path (for reference only — NOT read at CI time): `/Users/phuongvu/Code/openbox/openbox-mastra-sdk/`

## Independence rule

This SDK is fully independent of `openbox-mastra-sdk`. The drift script (`scripts/check-copied-drift.mjs`) validates LOCAL copy integrity only — it never reads `openbox-mastra-sdk/src/...` at CI time. The "Source SHA-256" column below is informational metadata embedded at copy time, not validated at CI time. Re-sync to upstream is a manual operator-initiated procedure (see "Re-sync procedure" at the bottom of this file).

## Per-file status

| Path | Source path | Source commit | Source SHA-256 (embedded at copy time) | Local SHA-256 | Status | Notes |
|---|---|---|---|---|---|---|
| `src/client/index.ts` | `openbox-mastra-sdk/src/client/index.ts` | `33214f7d4b42` | `e7107b39cafe9009c5c758a4c46b287812d4c9510c29ba5416249a19793e1fa0` | `e7107b39cafe9009c5c758a4c46b287812d4c9510c29ba5416249a19793e1fa0` | Verbatim |  |
| `src/client/openbox-client.ts` | `openbox-mastra-sdk/src/client/openbox-client.ts` | `33214f7d4b42` | `b0b138361c3a68fea4aff78a4923aee1c6d89e2c9cf21d89e90c5f64869441ff` | `b0b138361c3a68fea4aff78a4923aee1c6d89e2c9cf21d89e90c5f64869441ff` | Verbatim |  |
| `src/config/index.ts` | `openbox-mastra-sdk/src/config/index.ts` | `33214f7d4b42` | `b6bbb9091e91366f647a25d557e58ed226976b9310d861a7645c1ba4f7f8c8a9` | `b6bbb9091e91366f647a25d557e58ed226976b9310d861a7645c1ba4f7f8c8a9` | Verbatim |  |
| `src/config/openbox-config.ts` | `openbox-mastra-sdk/src/config/openbox-config.ts` | `33214f7d4b42` | `17496864609a2e8cc1c5df3e8458c8dcd771f1d8b9ab864cac0e102c13afda10` | `17496864609a2e8cc1c5df3e8458c8dcd771f1d8b9ab864cac0e102c13afda10` | Verbatim |  |
| `src/governance/activity-runtime.ts` | `openbox-mastra-sdk/src/governance/activity-runtime.ts` | `33214f7d4b42` | `eb3d6f641acca82f66f7d8871dd023be549a50cf5fc5a0d76581bca503b2117f` | `1e170d3357d33b5cb3c8b7e1600ecae172a470d1f7e8e9c5e1cb2f6f58b40cd4` | Modified (Phase 1) | Replaced `@mastra/core/tools` type import with local structural `ToolExecutionContextLike` (re-sync requires re-applying this patch by hand). |
| `src/governance/approval-registry.ts` | `openbox-mastra-sdk/src/governance/approval-registry.ts` | `33214f7d4b42` | `ea71bed3095da1d711ba339b7c9f208d063d4bf3b5d98e1fd73651e41b259a2d` | `ea71bed3095da1d711ba339b7c9f208d063d4bf3b5d98e1fd73651e41b259a2d` | Verbatim |  |
| `src/governance/context.ts` | `openbox-mastra-sdk/src/governance/context.ts` | `33214f7d4b42` | `18c7d07cfea6f0c4497caaa3c880cd1e510f8377376bb06e0b45ffe735e3279a` | `1420a891e0ecdf47a14addf4dada1d8482241f3ca6b8ba9584366e0bc93e73aa` | Modified (Phase 4) | Added `enterOpenBoxExecutionContext` export wrapping `executionContextStore.enterWith` for the CopilotKit before-request middleware path (no callback to `runWithOpenBoxExecutionContext` over; v2's fetch-handler continues after the middleware await). Merges over any active context and metadata. Re-sync requires re-applying this patch by hand. |
| `src/governance/index.ts` | `openbox-mastra-sdk/src/governance/index.ts` | `33214f7d4b42` | `8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881` | `8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881` | Verbatim |  |
| `src/identity/agent-identity.ts` | `openbox-mastra-sdk/src/identity/agent-identity.ts` | `33214f7d4b42` | `4d383ce68e9c2995d788f654cd75ff70fb228cd14bd285629a35d5e1da5cfa2a` | `4d383ce68e9c2995d788f654cd75ff70fb228cd14bd285629a35d5e1da5cfa2a` | Verbatim |  |
| `src/identity/index.ts` | `openbox-mastra-sdk/src/identity/index.ts` | `33214f7d4b42` | `0369027a145a3693995a1c16498fffe1a6ea982dedd4eab2c88dfec01cac3a65` | `0369027a145a3693995a1c16498fffe1a6ea982dedd4eab2c88dfec01cac3a65` | Verbatim |  |
| `src/otel/index.ts` | `openbox-mastra-sdk/src/otel/index.ts` | `33214f7d4b42` | `ac7713340c08422ba5b856f490f9e6b2296936b252bd50731a9b93db0e4ba693` | `ac7713340c08422ba5b856f490f9e6b2296936b252bd50731a9b93db0e4ba693` | Verbatim | Barrel only — Phase 2 modifications live in `setup-openbox-opentelemetry.ts`. |
| `src/otel/setup-openbox-opentelemetry.ts` | `openbox-mastra-sdk/src/otel/setup-openbox-opentelemetry.ts` | `33214f7d4b42` | `ec1b413d0ef2977cb20934e56aeb038948a6614fa89ba31a7de4c20f25a74c70` | `14ac89d319f54f5a10ba36b92d4179b00d1b382d65ea63e029f22dd464fb6f15` | Modified (Phase 2) | Added module-private `installedController` / `installedConfigKey` slots, self-call idempotency (same-config returns same controller; different-config throws), peer `ProxyTracerProvider.getDelegate()` detection that emits a no-op controller without patching `globalThis.fetch`. Independence rule: no `globalThis[Symbol.for("openbox.*")]` writes. Re-sync requires re-applying this patch by hand. |
| `src/span/index.ts` | `openbox-mastra-sdk/src/span/index.ts` | `33214f7d4b42` | `cda613c8fdec737001c9314c6f712184539593b72dbb7be136486d848a38c100` | `cda613c8fdec737001c9314c6f712184539593b72dbb7be136486d848a38c100` | Verbatim |  |
| `src/span/openbox-span-processor.ts` | `openbox-mastra-sdk/src/span/openbox-span-processor.ts` | `33214f7d4b42` | `ca4bcf1764c35eaa3015ff598c42b3cd5cbb1157d7afcbb396c142d02f380849` | `ca4bcf1764c35eaa3015ff598c42b3cd5cbb1157d7afcbb396c142d02f380849` | Verbatim |  |
| `src/types/errors.ts` | `openbox-mastra-sdk/src/types/errors.ts` | `33214f7d4b42` | `6ecaf303461e7949fabe464cf95f3ee3ddd1916c49345e67f7dc27c94274b913` | `6ecaf303461e7949fabe464cf95f3ee3ddd1916c49345e67f7dc27c94274b913` | Verbatim |  |
| `src/types/governance-verdict-response.ts` | `openbox-mastra-sdk/src/types/governance-verdict-response.ts` | `33214f7d4b42` | `4dbf03785612621484557b0aebc86cc6938d94e046db562c544cdc06299befeb` | `4dbf03785612621484557b0aebc86cc6938d94e046db562c544cdc06299befeb` | Verbatim |  |
| `src/types/guardrails.ts` | `openbox-mastra-sdk/src/types/guardrails.ts` | `33214f7d4b42` | `8db4f0388dee4a20046565d4412ae4cc8c17d47dd18677f133798a885fa6f1db` | `8db4f0388dee4a20046565d4412ae4cc8c17d47dd18677f133798a885fa6f1db` | Verbatim |  |
| `src/types/index.ts` | `openbox-mastra-sdk/src/types/index.ts` | `33214f7d4b42` | `c4eaf2f3d0bbf25fe521dc03e6268b167474a4026fed95e713c29a6be71a7338` | `c4eaf2f3d0bbf25fe521dc03e6268b167474a4026fed95e713c29a6be71a7338` | Verbatim |  |
| `src/types/verdict.ts` | `openbox-mastra-sdk/src/types/verdict.ts` | `33214f7d4b42` | `58ccade98ce13d05171b4f24ef478e6d08d9b9c58f6186bde33f3811abab258f` | `58ccade98ce13d05171b4f24ef478e6d08d9b9c58f6186bde33f3811abab258f` | Verbatim |  |
| `src/types/workflow-event-type.ts` | `openbox-mastra-sdk/src/types/workflow-event-type.ts` | `33214f7d4b42` | `6b98a5fef2dc1aadbd071d661a9ea95cac2de0ca4b6f4948ca1ac8e5cc691821` | `219786f55b313056e926e7460bf52cd6131ff9838896b6c60d795d182f1e8e9a` | Modified (multi-agent) | Added `HANDOFF = "Handoff"` enum member for the multi-agent delegation marker. Upstream `openbox-mastra-sdk` gains the same member when its receiver-side handoff support lands; re-sync requires re-applying this addition by hand. |
| `src/types/workflow-span-buffer.ts` | `openbox-mastra-sdk/src/types/workflow-span-buffer.ts` | `33214f7d4b42` | `50b635926ed62c7a83a4ccda918913f45a3df57c41b04cadf75c1b0e8dcc478f` | `50b635926ed62c7a83a4ccda918913f45a3df57c41b04cadf75c1b0e8dcc478f` | Verbatim |  |
| `test/contract/openbox-client.test.ts` | `openbox-mastra-sdk/test/contract/openbox-client.test.ts` | `33214f7d4b42` | `1ca11e0e1c8fe34a3d8ec69564c463db8b8cc6421de11794a1df6b570fd7cd8a` | `1ca11e0e1c8fe34a3d8ec69564c463db8b8cc6421de11794a1df6b570fd7cd8a` | Verbatim |  |
| `test/helpers/openbox-server.ts` | `openbox-mastra-sdk/test/helpers/openbox-server.ts` | `33214f7d4b42` | `301a5867efcb143cb6a7d4f9ba7db78564cc7c6ad7160ae1cf9f0cd31b75f770` | `301a5867efcb143cb6a7d4f9ba7db78564cc7c6ad7160ae1cf9f0cd31b75f770` | Verbatim |  |
| `test/privacy/otel-privacy.test.ts` | `openbox-mastra-sdk/test/privacy/otel-privacy.test.ts` | `33214f7d4b42` | `30063f7eec8fc188f015701a323f4baac337b2e38c4fac10a01ef5dabdac59df` | `30063f7eec8fc188f015701a323f4baac337b2e38c4fac10a01ef5dabdac59df` | Verbatim |  |
| `test/unit/agent-identity.test.ts` | `openbox-mastra-sdk/test/unit/agent-identity.test.ts` | `33214f7d4b42` | `b9d0ff4894f1f284884ffe7b5cdf3043f543b9cac90a37656d34b3c8648619db` | `b9d0ff4894f1f284884ffe7b5cdf3043f543b9cac90a37656d34b3c8648619db` | Verbatim |  |
| `test/unit/config.test.ts` | `openbox-mastra-sdk/test/unit/config.test.ts` | `33214f7d4b42` | `c39ff3448eb9ff146b650f6674962d0584b676f09c064246f925fdeb830b4c3b` | `c39ff3448eb9ff146b650f6674962d0584b676f09c064246f925fdeb830b4c3b` | Verbatim |  |
| `test/unit/errors.test.ts` | `openbox-mastra-sdk/test/unit/errors.test.ts` | `33214f7d4b42` | `3a92054c5b09a9db94d6c8cd36cd8fa74be514decb0408e2fc2caa9d19db8d72` | `3a92054c5b09a9db94d6c8cd36cd8fa74be514decb0408e2fc2caa9d19db8d72` | Verbatim |  |
| `test/unit/otel-setup.test.ts` | `openbox-mastra-sdk/test/unit/otel-setup.test.ts` | `33214f7d4b42` | `f34e0e45a9929085f8a30afa124fee7a8be8380ff1bffc8d8d6d8118b7301121` | `f34e0e45a9929085f8a30afa124fee7a8be8380ff1bffc8d8d6d8118b7301121` | Verbatim |  |
| `test/unit/span-processor.test.ts` | `openbox-mastra-sdk/test/unit/span-processor.test.ts` | `33214f7d4b42` | `97094b0774650eb83ead438437d1706822b244feb44838e1a5386977afd22027` | `97094b0774650eb83ead438437d1706822b244feb44838e1a5386977afd22027` | Verbatim |  |
| `test/unit/types.test.ts` | `openbox-mastra-sdk/test/unit/types.test.ts` | `33214f7d4b42` | `c9cb4b135eb9df45c40fb4b4714045cfcfcf3a4cf22312a1a3080f1eb32d12b1` | `c9cb4b135eb9df45c40fb4b4714045cfcfcf3a4cf22312a1a3080f1eb32d12b1` | Verbatim |  |

## Fixture directories (copied verbatim, hashed per-file below)

| Path | Source path | Source SHA-256 | Local SHA-256 | Status |
|---|---|---|---|---|
| `test/fixtures/approvals/.gitkeep` | `openbox-mastra-sdk/test/fixtures/approvals/.gitkeep` | `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b` | `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b` | Verbatim |
| `test/fixtures/approvals/approval-allow.json` | `openbox-mastra-sdk/test/fixtures/approvals/approval-allow.json` | `3d2da90c666c94984a7d9ff73d81090834125d349f7e74551a921ddc0fcaf58e` | `3d2da90c666c94984a7d9ff73d81090834125d349f7e74551a921ddc0fcaf58e` | Verbatim |
| `test/fixtures/approvals/require-approval-suspend.json` | `openbox-mastra-sdk/test/fixtures/approvals/require-approval-suspend.json` | `c0a945fd3109ca6a26e157c5e6e8435010a165dd7843505ec5a9d35704262770` | `c0a945fd3109ca6a26e157c5e6e8435010a165dd7843505ec5a9d35704262770` | Verbatim |
| `test/fixtures/events/.gitkeep` | `openbox-mastra-sdk/test/fixtures/events/.gitkeep` | `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b` | `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b` | Verbatim |
| `test/fixtures/events/activity-completed.json` | `openbox-mastra-sdk/test/fixtures/events/activity-completed.json` | `238cec38c1d990ffb9abf8aa01e2625ea3f8e40964152aac28be4e64b57d0c90` | `238cec38c1d990ffb9abf8aa01e2625ea3f8e40964152aac28be4e64b57d0c90` | Verbatim |
| `test/fixtures/events/signal-received.json` | `openbox-mastra-sdk/test/fixtures/events/signal-received.json` | `1f0cb4d5fcaa269423e1f1db4ef1d9723b38da15423b7602a8f3690633934345` | `1f0cb4d5fcaa269423e1f1db4ef1d9723b38da15423b7602a8f3690633934345` | Verbatim |
| `test/fixtures/events/workflow-started.json` | `openbox-mastra-sdk/test/fixtures/events/workflow-started.json` | `ad10417f1b7bc2722cfad76ebd6037380776ab82be8a81e8c3f533b908ac94f8` | `ad10417f1b7bc2722cfad76ebd6037380776ab82be8a81e8c3f533b908ac94f8` | Verbatim |
| `test/fixtures/guardrails/.gitkeep` | `openbox-mastra-sdk/test/fixtures/guardrails/.gitkeep` | `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b` | `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b` | Verbatim |
| `test/fixtures/guardrails/redacted-input.json` | `openbox-mastra-sdk/test/fixtures/guardrails/redacted-input.json` | `99e4a19bc09c50afc9b101a28daca8626a2593547a7182ff41346a35d5db66ba` | `99e4a19bc09c50afc9b101a28daca8626a2593547a7182ff41346a35d5db66ba` | Verbatim |
| `test/fixtures/guardrails/redacted-output.json` | `openbox-mastra-sdk/test/fixtures/guardrails/redacted-output.json` | `8291adb2990db466ce9cdbdad58674b0ac6ca0ff0793beb013672ae78af2c39f` | `8291adb2990db466ce9cdbdad58674b0ac6ca0ff0793beb013672ae78af2c39f` | Verbatim |

## Excluded from copy

| Path | Reason |
|---|---|
| `src/mastra/` | Mastra-specific layer; not relevant in CopilotKit SDK. |
| `test/contract/wrap-tool.test.ts` | Tests Mastra wrap-tool — implementation not present in this SDK. |
| `test/integration/wrap-agent.test.ts` | Tests Mastra wrap-agent — implementation not present. |
| `test/integration/wrap-workflow.test.ts` | Tests Mastra wrap-workflow — implementation not present. |
| `test/integration/with-openbox.test.ts` | Tests Mastra with-openbox — implementation not present. |
| `test/unit/a2a-peer.test.ts` | Tests src/mastra/a2a-peer.ts helpers (buildOpenBoxA2AOutboundContext, parseOpenBoxA2AInboundMetadata) — Mastra-specific, not relevant in CopilotKit SDK. |

## Re-sync procedure (manual, operator-initiated)

1. Clone or pull `openbox-mastra-sdk` at the desired commit (`HEAD` or a specific tag/SHA).
2. For each row above, recompute the source-file SHA-256: `shasum -a 256 path/in/openbox-mastra-sdk`.
3. If the new source SHA-256 differs from the row, re-copy the file (re-applying the Modified-row patch by hand).
4. Re-run `npm run check:copied` after re-copying — it validates the new local SHA-256 matches the recorded local SHA-256 (you must update both columns in this file after re-copy).
5. Re-run `npm run check:no-mastra` — any new `@mastra/*` import in copied modules must be patched out at copy time.
6. Commit the manifest changes (new commit SHA, new SHAs, any patch-of-record entries) in the same commit as the file changes.

## Tech debt

- Copy-first approach (vs. peer-dep on `openbox-mastra-sdk`) accepts ~1,500 LOC of immediate duplication.
- Extraction of a shared `@openbox-ai/openbox-core` is targeted for one OpenBox API revision cycle (Tx).
- Until extraction, drift between this repo and `openbox-mastra-sdk` is operator-managed; CI does not auto-detect upstream changes (per the independence rule, which forbids CI-time reads of the sibling repo).
