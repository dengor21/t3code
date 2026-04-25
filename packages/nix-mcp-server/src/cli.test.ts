import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { defaultIndexManifest } from "@t3tools/nix-knowledge";

import { NIX_MCP_SERVER_NAME, NIX_MCP_SERVER_VERSION } from "./index.ts";

interface JsonRpcResponse {
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

function encodeMessage(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8"), body]);
}

function parseMessages(buffer: Buffer): {
  readonly messages: ReadonlyArray<JsonRpcResponse>;
  readonly remainder: Buffer;
} {
  const messages: JsonRpcResponse[] = [];
  let remaining = buffer;

  while (true) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return { messages, remainder: remaining };
    }
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const contentLengthMatch = /content-length:\s*(\d+)/i.exec(header);
    if (!contentLengthMatch) {
      throw new Error("Missing Content-Length header in MCP response.");
    }
    const contentLength = Number(contentLengthMatch[1]);
    const bodyStart = headerEnd + 4;
    if (remaining.byteLength < bodyStart + contentLength) {
      return { messages, remainder: remaining };
    }
    const body = remaining.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
    messages.push(JSON.parse(body) as JsonRpcResponse);
    remaining = remaining.subarray(bodyStart + contentLength);
  }
}

function createClient(child: ChildProcessWithoutNullStreams) {
  let nextId = 1;
  let stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const pending = new Map<
    number,
    {
      readonly resolve: (response: JsonRpcResponse) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  const rejectPending = (error: Error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    const parsed = parseMessages(stdoutBuffer);
    stdoutBuffer = parsed.remainder;
    for (const message of parsed.messages) {
      if (typeof message.id !== "number") {
        continue;
      }
      const request = pending.get(message.id);
      if (!request) {
        continue;
      }
      pending.delete(message.id);
      request.resolve(message);
    }
  });

  child.on("error", (error) => {
    rejectPending(error);
  });
  child.on("exit", (code, signal) => {
    rejectPending(new Error(`MCP CLI exited before responding (code=${code}, signal=${signal}).`));
  });

  return {
    request(method: string, params?: Record<string, unknown>) {
      const id = nextId;
      nextId += 1;
      const response = new Promise<JsonRpcResponse>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          id,
          method,
          ...(params ? { params } : {}),
        }),
      );
      return response;
    },
    notify(method: string, params?: Record<string, unknown>) {
      child.stdin.write(
        encodeMessage({
          jsonrpc: "2.0",
          method,
          ...(params ? { params } : {}),
        }),
      );
    },
  };
}

async function createIndexFixture() {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-nix-mcp-test-"));
  const workspaceRoot = join(baseDir, "workspace");
  const indexDir = join(baseDir, "index");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(indexDir, { recursive: true });

  const manifest = {
    ...defaultIndexManifest({
      revision: "abc123",
      channel: "nixos-unstable",
      builtAt: "2026-01-01T00:00:00.000Z",
    }),
    optionCount: 1,
    packageCount: 1,
  };

  await writeFile(join(indexDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(
    join(indexDir, "options.json"),
    `${JSON.stringify({
      "services.nginx.enable": {
        description: "Enable nginx.",
        type: "boolean",
        declarations: ["/workspace/modules/nginx.nix"],
      },
    })}\n`,
  );
  await writeFile(
    join(indexDir, "packages.json"),
    `${JSON.stringify({
      "legacyPackages.x86_64-linux.nginx": {
        pname: "nginx",
        version: "1.27.0",
        description: "HTTP and reverse proxy server",
        license: "BSD-2-Clause",
      },
    })}\n`,
  );

  return {
    workspaceRoot,
    indexDir,
    cleanup: () => rm(baseDir, { recursive: true, force: true }),
  };
}

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

async function startCli(envOverrides?: Record<string, string>) {
  const fixture = await createIndexFixture();
  cleanupTasks.push(fixture.cleanup);

  const child = spawn(process.execPath, [cliPath], {
    cwd: dirname(cliPath),
    env: {
      ...process.env,
      T3_NIX_PROJECT_ROOT: fixture.workspaceRoot,
      T3_NIX_INDEX_DIR: fixture.indexDir,
      T3_NIX_VALIDATION_BUDGET: "5",
      T3_NIX_VALIDATION_TIMEOUT_MS: "30000",
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  cleanupTasks.push(async () => {
    child.kill("SIGKILL");
  });

  return {
    ...fixture,
    child,
    client: createClient(child),
  };
}

describe("nix MCP CLI", () => {
  it("initializes and lists the expected tools", async () => {
    const { client } = await startCli();

    const initialize = await client.request("initialize");
    expect(initialize.error).toBeUndefined();
    expect(initialize.result).toEqual({
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: NIX_MCP_SERVER_NAME,
        version: NIX_MCP_SERVER_VERSION,
      },
    });

    client.notify("notifications/initialized");

    const toolList = await client.request("tools/list");
    expect(toolList.error).toBeUndefined();
    expect(
      ((toolList.result as { tools: ReadonlyArray<{ name: string }> }).tools ?? []).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "search_options",
      "get_option",
      "search_packages",
      "flake_check",
      "flake_eval",
      "flake_show",
    ]);
  });

  it("serves indexed option and package lookups", async () => {
    const { client } = await startCli();

    await client.request("initialize");

    const optionSearch = await client.request("tools/call", {
      name: "search_options",
      arguments: {
        query: "nginx",
      },
    });
    expect(optionSearch.error).toBeUndefined();
    expect(
      (
        optionSearch.result as {
          structuredContent: {
            results: ReadonlyArray<{ name: string }>;
          };
        }
      ).structuredContent.results[0]?.name,
    ).toBe("services.nginx.enable");

    const optionDetail = await client.request("tools/call", {
      name: "get_option",
      arguments: {
        name: "services.nginx.enable",
      },
    });
    expect(optionDetail.error).toBeUndefined();
    expect(
      (
        optionDetail.result as {
          structuredContent: {
            option: { name: string } | null;
          };
        }
      ).structuredContent.option?.name,
    ).toBe("services.nginx.enable");

    const packageSearch = await client.request("tools/call", {
      name: "search_packages",
      arguments: {
        query: "nginx",
      },
    });
    expect(packageSearch.error).toBeUndefined();
    expect(
      (
        packageSearch.result as {
          structuredContent: {
            results: ReadonlyArray<{ attr: string }>;
          };
        }
      ).structuredContent.results[0]?.attr,
    ).toBe("legacyPackages.x86_64-linux.nginx");
  });

  it("rejects validation paths outside the workspace root", async () => {
    const { client } = await startCli();

    await client.request("initialize");

    const response = await client.request("tools/call", {
      name: "flake_check",
      arguments: {
        path: "../outside",
      },
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Requested path must stay within the workspace root.",
    );
  });

  it("enforces the per-session validation budget", async () => {
    const { client } = await startCli({
      T3_NIX_VALIDATION_BUDGET: "0",
    });

    await client.request("initialize");

    const response = await client.request("tools/call", {
      name: "flake_check",
      arguments: {
        path: ".",
      },
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Validation budget exhausted for this session.");
  });
});
