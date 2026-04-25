import type { NixDesignerScope } from "@t3tools/contracts";

export function normalizeHostName(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function designerFromScopedHostName(
  scopedHostName: string | null | undefined,
): Extract<NixDesignerScope, { kind: "host" }> | null {
  const hostName = normalizeHostName(scopedHostName);
  return hostName === null ? null : { kind: "host", hostName };
}

export function designerScopesEqual(
  left: NixDesignerScope | null | undefined,
  right: NixDesignerScope | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (left == null || right == null) {
    return left == null && right == null;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "project") {
    return true;
  }
  return (
    right.kind === "host" && normalizeHostName(left.hostName) === normalizeHostName(right.hostName)
  );
}
