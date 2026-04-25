import type { ProviderTurnContext } from "@t3tools/contracts";

function isBlank(value: string | null | undefined): boolean {
  return (value?.trim() ?? "").length === 0;
}

export function buildThreadScopeCapsule(input: {
  readonly providerContext: ProviderTurnContext;
}): string | null {
  const { providerContext } = input;
  const scopedHostName = providerContext.scopedHostName?.trim() ?? "";
  const sections = ['<hal_context version="1">'];

  if (!isBlank(providerContext.projectKind)) {
    sections.push(`project_kind: ${providerContext.projectKind}`);
  }
  if (!isBlank(providerContext.workspaceRoot)) {
    sections.push(`workspace_root: ${providerContext.workspaceRoot}`);
  }

  if (scopedHostName.length > 0) {
    sections.push("scope: host");
    sections.push(`host: ${scopedHostName}`);
    sections.push("scope_status: locked");
    sections.push(
      `default_reference_rule: When the user says "it", "this host", "the machine", or omits a host, use ${scopedHostName}.`,
    );
    if (!isBlank(providerContext.flake?.flakePath)) {
      sections.push(`flake_entrypoint: ${providerContext.flake?.flakePath}`);
    }
    if (!isBlank(providerContext.flake?.hostFlakeAttr)) {
      sections.push(`host_flake_attr: ${providerContext.flake?.hostFlakeAttr}`);
    }
    if (!isBlank(providerContext.flake?.documentationPaths?.hostDoc)) {
      sections.push(`host_doc: ${providerContext.flake?.documentationPaths?.hostDoc}`);
    }
    sections.push(
      "cross_host_rule: Do not modify or deploy other hosts unless the user explicitly broadens scope and approves the wider impact.",
    );
  } else {
    sections.push("scope: project");
    sections.push("scope_status: unlocked");
    if (!isBlank(providerContext.flake?.flakePath)) {
      sections.push(`flake_entrypoint: ${providerContext.flake?.flakePath}`);
    }
    sections.push(
      "cross_host_rule: Ask before choosing a host-specific write or deployment target.",
    );
  }

  sections.push("</hal_context>");
  return sections.length > 2 ? sections.join("\n") : null;
}
