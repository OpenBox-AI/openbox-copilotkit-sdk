import { OpenBoxConfigError } from "../../types/errors.js";

/**
 * Env-var alias resolution primitives shared by `config-translator.ts`. Split
 * out purely to keep that file at orchestration-level (module split, no
 * behavior change) — mirrors how `lifecycle-telemetry.ts` splits queue
 * mechanics from `lifecycle-telemetry-payload-bounds.ts`.
 *
 * Every resolver here implements ONE tier pair of the phase-06 alias
 * resolution order: explicit value (checked by the caller before calling
 * in) -> `OPENBOX_COPILOTKIT_<suffix>` env -> `OPENBOX_<suffix>` env ->
 * `undefined` (caller applies its own default). `ENV_PREFIX`/
 * `GLOBAL_ENV_PREFIX` match `base-runtime-builder.ts`'s own
 * `envPrefix: "OPENBOX_COPILOTKIT"` passed to `OpenBoxConfig.resolve`, so a
 * field resolved here and a field base resolves itself honor the SAME
 * env-var naming scheme.
 */

export const ENV_PREFIX = "OPENBOX_COPILOTKIT";
export const GLOBAL_ENV_PREFIX = "OPENBOX";

export function readAliasEnv(suffix: string, env: NodeJS.ProcessEnv): string | undefined {
  return env[`${ENV_PREFIX}_${suffix}`] ?? env[`${GLOBAL_ENV_PREFIX}_${suffix}`];
}

export function resolveBooleanAlias(
  explicit: boolean | undefined,
  suffix: string,
  env: NodeJS.ProcessEnv
): boolean | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = readAliasEnv(suffix, env);
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new OpenBoxConfigError(`Invalid boolean value for ${suffix}: ${raw}`);
}

export function resolveNumberAlias(
  explicit: number | undefined,
  suffix: string,
  env: NodeJS.ProcessEnv
): number | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = readAliasEnv(suffix, env);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new OpenBoxConfigError(`Invalid numeric value for ${suffix}: ${raw}`);
  }
  return parsed;
}

export function resolveIntegerAlias(
  explicit: number | undefined,
  suffix: string,
  env: NodeJS.ProcessEnv
): number | undefined {
  const parsed = resolveNumberAlias(explicit, suffix, env);
  if (parsed !== undefined && !Number.isInteger(parsed)) {
    throw new OpenBoxConfigError(`Invalid integer value for ${suffix}: ${parsed}`);
  }
  return parsed;
}

export function resolveStringSetAlias(
  explicit: Iterable<string> | undefined,
  suffix: string,
  env: NodeJS.ProcessEnv
): Set<string> | undefined {
  if (explicit !== undefined) {
    return new Set(explicit);
  }
  const raw = readAliasEnv(suffix, env);
  if (raw === undefined) {
    return undefined;
  }
  return new Set(
    raw
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
  );
}
