// Private — un-registered. External code cannot lookup or squat the symbol
// via Symbol.for("openbox.copilotkit.runtime"). The runtime attachment is an
// internal SDK concern and not part of the public surface.
export const OPENBOX_COPILOTKIT_RUNTIME_SYMBOL = Symbol("openbox.copilotkit.runtime");

type RuntimeStash = Record<symbol, unknown>;

export function attachOpenBoxRuntime<TController>(
  runtime: object,
  controller: TController
): void {
  (runtime as RuntimeStash)[OPENBOX_COPILOTKIT_RUNTIME_SYMBOL] = controller;
}

export function getOpenBoxRuntime<TController = unknown>(
  runtime: object
): TController | undefined {
  return (runtime as RuntimeStash)[OPENBOX_COPILOTKIT_RUNTIME_SYMBOL] as
    | TController
    | undefined;
}
