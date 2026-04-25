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
    `- The scoped host is the default for investigation, planning, implementation, and answers.`,
    `- Before asking which host is meant, use ${scopedHostName}. If tools are available, call hal_current_scope before asking the user.`,
    "- Before touching other hosts or shared cross-host configuration, call out the wider impact explicitly and require scope expansion or approval.",
  ];
}

export function buildScopedHostInstructionBlock(
  providerContext?: ProviderTurnContext,
): string | null {
  const lines = buildScopedHostInstructionLines(providerContext);
  return lines.length > 0 ? ["Host scope:", ...lines].join("\n") : null;
}
