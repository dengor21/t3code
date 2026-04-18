import type { FlakeHost } from "@t3tools/contracts";

export function buildHostThreadPrompt(host: FlakeHost): string {
  const lines = [
    "Host context:",
    `- name: ${host.name}`,
    `- target: ${host.target}`,
    ...(host.system ? [`- system: ${host.system}`] : []),
    ...(host.type ? [`- type: ${host.type}`] : []),
    "",
    "Please scope the next change to this host unless I say otherwise.",
  ];

  return lines.join("\n");
}
