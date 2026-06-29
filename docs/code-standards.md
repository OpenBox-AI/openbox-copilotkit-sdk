# Code Standards & Conventions

**Last Updated**: 2026-06-29  
**Scope**: TypeScript, ESM, Node ≥24.10.0

## Language & Runtime

### TypeScript

- **Target**: ES2023
- **Module System**: ESNext (ESM-only; CommonJS not supported)
- **Path Alias**: `@/*` → `src/*` (required for imports)
- **File Extension Rule**: Relative imports must use `.js` extension (Node ESM spec requirement)

Example:
```ts
// ✅ Correct
import { OpenBoxClient } from '@/client/openbox-client.js';
import { getOpenBoxConfig } from '@/config/openbox-config.js';

// ❌ Wrong
import { OpenBoxClient } from '@/client/openbox-client';
import { getOpenBoxConfig } from './openbox-config';  // No .js
```

### Type Safety

Strict compiler flags **required**:
- `strict: true` — All strict flags enabled
- `noUncheckedIndexedAccess: true` — Forbid unchecked `obj[key]`
- `exactOptionalPropertyTypes: true` — `prop?: T` is `T | undefined`, not `T | undefined | null`
- `noImplicitOverride: true` — Override methods must use `override` keyword
- `noFallthroughCasesInSwitch: true` — Switch cases must have break/return
- `isolatedModules: true` — Safe for isolated transpilation
- `verbatimModuleSyntax: true` — Preserve import/export distinction
- `resolveJsonModule: true` — Allow JSON imports
- `bundler: true` — Bundler-aware resolution

**No-ops to avoid**:
- `any` — Use `unknown` + narrow, or `type-fest` utilities
- Unsafe casts — Use zod or type guards
- `as const` on non-literals — Use explicit const assertions

### Node.js Version

- **Required**: >= 24.10.0 (Reason: `AsyncLocalStorage`, ES2023 built-ins, native `@` path alias)
- **Engine spec**: `"engines": { "node": ">=24.10.0" }` in package.json

## Naming Conventions

| Category | Convention | Example |
|----------|-----------|---------|
| **Files** | kebab-case + descriptive | `openbox-client.ts`, `wrap-copilot-runtime-options.ts`, `tool-span-synthesizer.ts` |
| **Directories** | kebab-case | `src/copilotkit/`, `src/agent-identity/` |
| **Classes** | PascalCase | `OpenBoxClient`, `SpanBuffer`, `OpenBoxVerdict` |
| **Interfaces** | PascalCase (no `I` prefix) | `GovernanceVerdictResponse`, `MiddlewareInput` |
| **Types** | PascalCase | `Verdict`, `ToolCallTriple`, `SpanData` |
| **Enums** | PascalCase | `WorkflowEventType`, `EnforcementStatus` |
| **Functions** | camelCase | `getOpenBoxConfig()`, `mapVerdict()`, `attachAuditEnvelope()` |
| **Variables** | camelCase | `evaluateRetries`, `maxPayloadBytes`, `isEnforced` |
| **Constants** | UPPER_SNAKE_CASE | `OPENBOX_COPILOTKIT_RUNTIME_SYMBOL`, `DEFAULT_GOVERNANCE_TIMEOUT` |
| **Private members** | `#fieldName` or `_fieldName` (prefer `#`) | `#buffer`, `#context` |

**Boolean naming**: Prefix with `is`, `has`, `should`, `can`
```ts
isBlockingVerdict: true
hasApproval: false
shouldValidate: true
canRetry: boolean
```

## Import Standards

### Module Resolution

- **Local imports**: Always use path alias `@/` + `.js` extension
- **Peer dependencies**: `@ag-ui/client`, `@copilotkit/runtime` (required; listed in peerDependencies)
- **Runtime dependency**: `zod` (config schema validation)
- **Forbidden imports** (CI-enforced):
  - `@opentelemetry/*` — Removed in 0.2.0; fail-open on governance eval instead
  - `@mastra/*` — Co-runs without shared span ownership; SDK owns AG-UI

### Example Patterns

```ts
// ✅ Config import
import { parseOpenBoxConfig, getOpenBoxApiKey } from '@/config/openbox-config.js';

// ✅ Type-only imports
import type { OpenBoxVerdict, GovernanceVerdictResponse } from '@/types/index.js';

// ✅ CopilotKit peer dep
import type { Middleware } from '@ag-ui/client';

// ✅ Zod validation
import { z } from 'zod';

// ❌ No OTel
import { trace } from '@opentelemetry/api';  // FORBIDDEN; CI rejects

// ❌ No Mastra internals
import { MastraSDK } from '@mastra/core';  // FORBIDDEN; co-run pattern only
```

## Public Surface Discipline

### Export Rules

1. **Single entry point**: All public APIs re-exported from `src/index.ts`
2. **Subpath exports**: Mirrored in `package.json` `exports`; each subpath MUST have an `index.ts` barrel
3. **Declaration files**: Generated automatically by tsup (`dts: true`)
4. **Additive only**: New exports never remove or rename old exports

### Structure Example

```
src/client/
├── index.ts              # Barrel: re-exports OpenBoxClient, types
├── openbox-client.ts     # Main implementation
└── types.ts              # Client-specific types

src/index.ts             # Root barrel: re-exports all subpaths
```

**Root barrel** (src/index.ts):
```ts
export * from '@/client/index.js';
export * from '@/config/index.js';
export * from '@/copilotkit/index.js';
export * from '@/governance/index.js';
export * from '@/identity/index.js';
export * from '@/types/index.js';
```

**Subpath barrel** (src/client/index.ts):
```ts
export { OpenBoxClient } from './openbox-client.js';
export * from './types.js';
```

## Error Handling

### Error Class Hierarchy

**Base class**: `OpenBoxError` (extends `Error`)

**Subclasses** (throw only these):
- `OpenBoxConfigError` (extends `OpenBoxError`) — Invalid config, missing env vars
- `OpenBoxAuthError` (extends `OpenBoxConfigError`) — DID validation failed, invalid API key
- `OpenBoxNetworkError` (extends `OpenBoxConfigError`) — Network failure during evaluation
- `OpenBoxInsecureURLError` (extends `OpenBoxConfigError`) — HTTPS required (except localhost)
- `GovernanceAPIError` (extends `OpenBoxError`) — Governance evaluate/approval API call failed
- `GovernanceHaltError` (extends `OpenBoxError`) — Halt verdict received
- `GuardrailsValidationError` (extends `OpenBoxError`) — Guardrail validation failed
- `ApprovalPendingError` (extends `OpenBoxError`) — Tool blocked; approval needed (user-facing)
- `ApprovalRejectedError` (extends `OpenBoxError`) — Approval denied (user-facing)
- `ApprovalExpiredError` (extends `OpenBoxError`) — Approval TTL exceeded (user-facing)
- `VerdictNotImplementedError` (extends `OpenBoxError`) — Deferred verdict (`constrain`, `require_approval`, `halt`) thrown in Phase 1; exported from `./verdict` subpath

**Blocking Events** (not error classes):
- `GovernanceBlockedErrorEvent` — Event emitted when tool is blocked; accessible via `createGovernanceBlockedErrorEvent(correlationId)`

**Pattern**:
```ts
// ❌ Don't throw generic Error
throw new Error('Config invalid');

// ✅ Throw specific subclass
throw new OpenBoxConfigError('OPENBOX_URL is required');

// ✅ Verdict not implemented in Phase 1
import { VerdictNotImplementedError } from '@/verdict';
throw new VerdictNotImplementedError(
  'Constrain verdict deferred to Phase 3'
);
```

## Logging

### Debug Gate

All logging must be gated by `OPENBOX_DEBUG` env var:

```ts
import { getOpenBoxConfig } from '@/config/openbox-config.js';

const config = getOpenBoxConfig();

if (config.openBoxDebug) {
  console.log('[OpenBox] Evaluating governance verdict', verdict);
}
```

**Why**: Prevent log spam in production; adopt `OPENBOX_DEBUG=1` for troubleshooting.

### Logging Style

- **No `console.log` in hot paths** without env gate
- **No `console.error`** for non-fatal errors (log via debug gate only)
- **Do use structured logging** if adopter has structured logger (pass via config callback)
- **Correlation IDs**: Include in all governance-related logs (approval ID, verdict correlation)

## Testing Standards

### Test Framework

- **Runner**: vitest
- **Coverage**: v8
- **Fixtures**: `test/fixtures/` (reusable test data; never in test files)
- **Determinism**: All async tests use deterministic mocked AG-UI streams; no real network calls

### Test Organization

```
test/
├── fixtures/
│   ├── agui-streams/     # Recorded event sequences
│   ├── governance-verdict-responses/  # API wire formats
│   ├── approvals/        # Approval payloads
│   └── evaluate-payloads-baseline.jsonl  # OTel removal proof
├── unit/
│   ├── client.test.ts
│   ├── config.test.ts
│   └── copilotkit/middleware.test.ts
└── integration/
    └── evaluate-snapshot-baseline.test.ts
```

### Test Rules

1. **Unit tests** — Mock external dependencies; test single concern
2. **Integration tests** — Use recorded fixtures; prove OTel-free governance eval
3. **Snapshot tests** — Use for governance evaluation payloads (baseline proof); avoid brittle snapshots
4. **Fixtures** — Store in `test/fixtures/`; commit alongside tests; never generate at runtime
5. **Relaxed lint** in tests — `no-misused-promises`, `no-unsafe-*` disabled

### Coverage Thresholds

| Metric | Target | Phase |
|--------|--------|-------|
| Lines | ≥60% | Phase 1 baseline |
| Statements | ≥60% | Phase 1 baseline |
| Functions | ≥70% | Phase 1 baseline |
| Branches | ≥50% | Phase 1 baseline |

Run: `npm run test` (includes coverage check)

## Linting & Formatting

### ESLint

- **Config**: ts-eslint `recommendedTypeChecked` + prettier
- **Strict rules**: No unused vars, no implicit any, no unsafe type operations
- **Test rules relaxed**: `no-misused-promises`, `no-unsafe-any`, `no-unsafe-assignment` — disabled

Run: `npm run lint`

### Prettier

- **Config**: .prettierrc.json (default 2-space indent, 80-char line length)
- **Run**: `npm run format`

## Commit Standards

### Conventional Commits

Format:
```
type(scope): subject

body (optional)

footer (optional)
```

**Types**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore` (not for SDK code)

**Examples**:
```
feat(middleware): emit verdict signals for approval polling
fix(client): retry evaluate on transient network errors
refactor(spans): extract tool-call-triple into shared type
test(verdict): add applier tests for 5-case union
docs(architecture): document AG-UI boundary
```

**Rules**:
- No AI references (`Claude`, `AI-generated`, etc.)
- Scope: lowercase module name (`client`, `middleware`, `verdict`)
- Subject: imperative, lowercase, no period
- No commit messages in `.claude/` changes (user repo convention)

## Code Comment Standards

- **File headers**: Top 3-5 lines describe purpose, scope, key exports
- **Complex logic**: Comments explain *why*, not *what*; code should be clear enough
- **Type definitions**: JSDoc for public APIs (classes, functions exported)
- **TODOs**: Include `TODO(phase X)` or `TODO(depends-on-issue#123)` for tracking

**Example**:
```ts
/**
 * Maps OpenBox governance verdict response to SDK discriminated union.
 * Only allow/block verdicts apply in Phase 1; others throw VerdictNotImplementedError.
 * @param response - Wire format from /api/v1/governance/evaluate
 * @returns OpenBoxVerdict union
 */
export function mapVerdict(response: GovernanceVerdictResponse): OpenBoxVerdict {
  // ...
}
```

## Build & Package

### Build Command

```bash
npm run build
```

Runs `tsup`:
- ESM-only output to `dist/`
- No bundle, no split
- Declaration files (dts: true)
- Source maps enabled
- Target: node24

### Package Exports

**package.json** defines:
```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" },
    "./config": { "types": "./dist/config/index.d.ts", "import": "./dist/config/index.js" },
    ...
  }
}
```

All subpath exports **must** be additive; breaking changes require major version bump.

## Code Review Checklist

- [ ] Imports use `@/` alias + `.js` extension
- [ ] No `any` types (use `unknown` + narrow)
- [ ] Error throwing uses `OpenBoxError` subclass
- [ ] Public APIs re-exported from `index.ts`
- [ ] Logging gated by `OPENBOX_DEBUG`
- [ ] Tests added for new behavior
- [ ] Commit message follows conventional format
- [ ] No `@opentelemetry/*` or `@mastra/*` imports
- [ ] Types are exported, implementations are not (except classes)
- [ ] JSDoc on public function/class signatures
- [ ] File named in kebab-case if new

## Performance Guidelines

- **Middleware latency**: Evaluate call should complete in <50ms P50 (target; no SLA yet)
- **SpanBuffer**: Capped at 1000 spans/workflow; TTL eviction every 150s
- **Retry budget**: 2 retries max on evaluate call (150ms base delay)
- **No blocking operations**: All I/O async; no `readFileSync`, `require()` at runtime
- **Memory bounds**: AsyncLocalStorage per-request; no module-level mutable state (except Symbol registry)

## TypeScript Compiler Flags Reference

Full `tsconfig.json` compilerOptions:
```json
{
  "compilerOptions": {
    "lib": ["ES2023"],
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "skipLibCheck": true,
    "esModuleInterop": false
  }
}
```

## Deviations & Exceptions

Documented exceptions require issue/RFC and CHANGELOG entry:
- ESM-only is strict; no CommonJS fallback considered
- Node 24.10.0 is hard floor; no backport support
- No `@opentelemetry` per 0.2.0 spec (enforced by CI)
- No Mastra-specific wrapping per co-run pattern (enforced by CI)
