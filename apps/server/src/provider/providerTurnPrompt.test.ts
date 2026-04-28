import assert from "node:assert/strict";

import { ThreadId } from "@t3tools/contracts";
import { describe, it } from "vitest";

import {
  applyProviderTurnPromptPreamble,
  buildProviderTurnPromptPreamble,
} from "./providerTurnPrompt.ts";

describe("providerTurnPrompt", () => {
  it("builds a nix flake planning preamble for host-creation workflows", () => {
    const preamble = buildProviderTurnPromptPreamble({
      interactionMode: "plan",
      providerContext: {
        projectKind: "nix-flake",
        remoteHostAccessPolicy: "hal-managed-only",
        scopedHostName: "nexus",
        flake: {
          flakePath: "flake.nix",
          hostFlakeAttr: "nixosConfigurations.nexus",
          documentationPaths: {
            generalChanges: "docs/general-changes.md",
            hostDoc: "docs/hosts/nexus.md",
            repoStyle: ".hal/repo-style.json",
          },
        },
        workflow: {
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          bootstrapMode: "existing-via-ssh",
          sourceSshTarget: "root@nexus.example",
          hostType: "server",
          status: "planning",
        },
      },
    });

    assert.ok(preamble?.startsWith("Use the following HAL runtime context for this request."));
    assert.ok(preamble?.includes('<hal_context version="1">'));
    assert.ok(preamble?.includes("scope: host"));
    assert.ok(preamble?.includes("host: nexus"));
    assert.ok(preamble?.includes("scope_status: locked"));
    assert.ok(preamble?.includes("host_flake_attr: nixosConfigurations.nexus"));
    assert.ok(preamble?.includes("repo_style: .hal/repo-style.json"));
    assert.ok(preamble?.includes("Host scope:"));
    assert.ok(preamble?.includes("Remote host access:"));
    assert.ok(preamble?.includes("Remote host access policy: hal-managed-only."));
    assert.ok(preamble?.includes("HAL deploy actions:"));
    assert.ok(
      preamble?.includes(
        "HAL deploy actions are available in this session for flake-backed deploy requests.",
      ),
    );
    assert.ok(
      preamble?.includes("Use `hal_open_host_deploy_dialog` for a single clear host deploy."),
    );
    assert.ok(preamble?.includes("Use `hal_open_fleet_rollout` for multi-host deploys."));
    assert.ok(preamble?.includes("This thread is scoped to host nexus."));
    assert.ok(preamble?.includes("This workspace is a Nix flake repository."));
    assert.ok(preamble?.includes("Repository style guide path: .hal/repo-style.json."));
    assert.ok(
      preamble?.includes(
        "The repository style guide includes the local halHosts and deploy.nodes bootstrap contract.",
      ),
    );
    assert.ok(
      preamble?.includes(
        "planning creation of host nexus by importing an existing system over SSH.",
      ),
    );
    assert.ok(preamble?.includes("SSH discovery target: root@nexus.example."));
    assert.ok(preamble?.includes("halHosts.nexus and hosts/nexus/default.nix"));
    assert.ok(preamble?.includes("secure password prompt UI"));
    assert.ok(preamble?.includes("Never ask the user to paste passwords into chat"));
    assert.ok(
      preamble?.includes("Present a findings summary before locking the translation plan."),
    );
    assert.ok(preamble?.includes("Keep the thread planning-only"));
  });

  it("wraps the user request with an implementation preamble when the workflow is ready", () => {
    const prepared = applyProviderTurnPromptPreamble({
      threadId: ThreadId.make("thread-1"),
      input: "Apply the approved removal plan",
      interactionMode: "default",
      providerContext: {
        projectKind: "nix-flake",
        remoteHostAccessPolicy: "hal-managed-only",
        workflow: {
          kind: "host-removal",
          hostName: "nexus",
          status: "ready-to-implement",
        },
      },
    });

    assert.ok(prepared.input?.includes("implementing the approved host-removal plan for nexus."));
    assert.ok(prepared.input?.includes('<hal_context version="1">'));
    assert.ok(prepared.input?.includes("User request:\nApply the approved removal plan"));
    assert.ok(!prepared.input?.includes("Keep the thread planning-only"));
  });

  it("builds a host-scope preamble for generic host-scoped threads", () => {
    const preamble = buildProviderTurnPromptPreamble({
      providerContext: {
        projectKind: "generic",
        remoteHostAccessPolicy: "hal-managed-only",
        scopedHostName: "router",
      },
    });

    assert.equal(
      preamble,
      [
        "Use the following HAL runtime context for this request. Treat it as authoritative for scope resolution.",
        "",
        '<hal_context version="1">',
        "project_kind: generic",
        "remote_host_access_policy: hal-managed-only",
        "scope: host",
        "host: router",
        "scope_status: locked",
        'default_reference_rule: When the user says "it", "this host", "the machine", or omits a host, use router.',
        "cross_host_rule: Do not modify or deploy other hosts unless the user explicitly broadens scope and approves the wider impact.",
        "</hal_context>",
        "",
        "Host scope:",
        "- This thread is scoped to host router.",
        "- The scoped host is the default for investigation, planning, implementation, and answers.",
        "- Before asking which host is meant, use router. If tools are available, call hal_current_scope before asking the user.",
        "- Before touching other hosts or shared cross-host configuration, call out the wider impact explicitly and require scope expansion or approval.",
        "",
        "Remote host access:",
        "- Remote host access policy: hal-managed-only.",
        "- Do not initiate direct remote host access from chat. This includes ssh, scp, sftp, rsync, mosh, nixos-rebuild --target-host, nixos-anywhere, or direct deploy-rs commands against a target host.",
        "- Use HAL-managed deployment actions instead of remote shell deployment commands.",
        "- If the request is to deploy but the target is not one clear host, ask whether the user wants a single host deploy or a fleet rollout before proceeding.",
        "- HAL-managed SSH import workflows are exempt because they run outside the agent terminal.",
      ].join("\n"),
    );
  });

  it("builds a flake-creation planning preamble", () => {
    const preamble = buildProviderTurnPromptPreamble({
      interactionMode: "plan",
      providerContext: {
        projectKind: "nix-flake",
        remoteHostAccessPolicy: "hal-managed-only",
        flake: {
          flakePath: "flake.nix",
          documentationPaths: {
            generalChanges: ".hal/changes.md",
            repoStyle: ".hal/repo-style.json",
          },
        },
        workflow: {
          kind: "flake-creation",
          hostScale: "6+",
          platformMatrix: "mixed",
          homeManager: true,
          moduleStyle: "explicit-modules",
          moduleNamespace: "fleet",
          layoutPattern: "fleet-layered",
          status: "planning",
        },
      },
    });

    assert.ok(
      preamble?.includes("This thread is planning the initial flake scaffold for this project."),
    );
    assert.ok(preamble?.includes("HAL already created a minimal bootstrap flake"));
    assert.ok(preamble?.includes("Selected layout pattern: fleet-layered."));
    assert.ok(preamble?.includes("Module namespace: fleet."));
    assert.ok(preamble?.includes("Keep halHosts and deploy.nodes present in flake.nix."));
    assert.ok(
      preamble?.includes(
        "Use .hal/repo-style.json as the local source of truth for the halHosts contract.",
      ),
    );
  });
});
