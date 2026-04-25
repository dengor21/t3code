import type { ProviderTurnContext } from "@t3tools/contracts";

function resolveScopedHostName(providerContext?: ProviderTurnContext): string | null {
  const scopedHostName = providerContext?.scopedHostName?.trim() ?? "";
  return scopedHostName.length > 0 ? scopedHostName : null;
}

export function buildScopedHostInstructionLines(
  providerContext?: ProviderTurnContext,
): ReadonlyArray<string> {
  const scopedHostName = resolveScopedHostName(providerContext);
  if (!scopedHostName) {
    return [];
  }

  return [
    `- This thread is scoped to host ${scopedHostName}.`,
    `- Unless the user explicitly broadens the request, treat ${scopedHostName} as the default host for investigation, planning, implementation, and answers.`,
    "- Before touching other hosts or shared cross-host configuration, call out that wider impact explicitly.",
  ];
}

export function buildScopedHostInstructionBlock(
  providerContext?: ProviderTurnContext,
): string | null {
  const lines = buildScopedHostInstructionLines(providerContext);
  return lines.length > 0 ? ["Host scope:", ...lines].join("\n") : null;
}
