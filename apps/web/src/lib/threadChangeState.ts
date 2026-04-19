import type { ThreadChangeTracking } from "@t3tools/contracts";

export function resolveThreadChangeTracking(input: {
  readonly changeTracking?: ThreadChangeTracking | null;
}): ThreadChangeTracking | null {
  return input.changeTracking ?? null;
}

export function isThreadChangeCommitted(input: {
  readonly changeTracking?: ThreadChangeTracking | null;
}): boolean {
  return resolveThreadChangeTracking(input)?.state === "committed";
}

export function isThreadChangeOngoing(input: {
  readonly changeTracking?: ThreadChangeTracking | null;
}): boolean {
  return !isThreadChangeCommitted(input);
}
