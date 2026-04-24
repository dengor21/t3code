import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  HostImportAuthPhase,
  HostImportSubmitSecretInput,
  HostImportSummary,
  HostImportTerminalEvent,
} from "./hostImport.ts";

const decodeHostImportAuthPhase = Schema.decodeUnknownSync(HostImportAuthPhase);
const decodeHostImportSummary = Schema.decodeUnknownSync(HostImportSummary);
const decodeHostImportSubmitSecretInput = Schema.decodeUnknownSync(HostImportSubmitSecretInput);
const decodeHostImportTerminalEvent = Schema.decodeUnknownSync(HostImportTerminalEvent);

describe("hostImport contracts", () => {
  it("accepts valid host import summaries", () => {
    const parsed = decodeHostImportSummary({
      projectId: "project-1",
      threadId: "thread-1",
      hostName: "nexus",
      sshTarget: "root@nexus.example",
      status: "awaiting-sudo-password",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      updatedAt: "2026-01-01T00:01:00.000Z",
      lastError: "Remote sudo access is required.",
      findingsSummary: null,
      exitCode: null,
      exitSignal: null,
    });

    expect(parsed.status).toBe("awaiting-sudo-password");
    expect(parsed.lastError).toBe("Remote sudo access is required.");
  });

  it("accepts both auth phases", () => {
    expect(decodeHostImportAuthPhase("ssh-login")).toBe("ssh-login");
    expect(decodeHostImportAuthPhase("remote-sudo")).toBe("remote-sudo");
  });

  it("preserves password whitespace instead of trimming it", () => {
    const parsed = decodeHostImportSubmitSecretInput({
      projectId: "project-1",
      threadId: "thread-1",
      phase: "ssh-login",
      secret: "  not-trimmed  ",
    });

    expect(parsed.secret).toBe("  not-trimmed  ");
  });

  it("rejects oversized secrets", () => {
    expect(() =>
      decodeHostImportSubmitSecretInput({
        projectId: "project-1",
        threadId: "thread-1",
        phase: "remote-sudo",
        secret: "x".repeat(4_097),
      }),
    ).toThrow();
  });

  it("accepts started terminal events", () => {
    const parsed = decodeHostImportTerminalEvent({
      type: "started",
      terminalOwnerId: "host-import:project-1:thread-1",
      terminalId: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      snapshot: {
        terminalOwnerId: "host-import:project-1:thread-1",
        terminalId: "default",
        cwd: "/workspace",
        worktreePath: null,
        status: "running",
        pid: 123,
        history: "connected",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(parsed.type).toBe("started");
    if (parsed.type !== "started") {
      throw new Error("Expected started event");
    }
    expect(parsed.snapshot.pid).toBe(123);
  });
});
