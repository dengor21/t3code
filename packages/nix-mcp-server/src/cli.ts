#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { NixValidationResult } from "@t3tools/contracts";
import {
  buildSearchIndex,
  findOptionDoc,
  parseNixDiagnostics,
  searchOptionDocs,
  searchPackageDocs,
  type NixDesignerIndexManifest,
} from "@t3tools/nix-knowledge";
import { normalizeNixOptionDocs, normalizeNixPackageDocs } from "@t3tools/nix-knowledge";

import { NIX_MCP_SERVER_NAME, NIX_MCP_SERVER_VERSION } from "./index.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

interface LoadedIndex {
  readonly manifest: NixDesignerIndexManifest;
  readonly options: ReturnType<typeof normalizeNixOptionDocs>;
  readonly packages: ReturnType<typeof normalizeNixPackageDocs>;
}

const PROJECT_ROOT = process.env.T3_NIX_PROJECT_ROOT
  ? resolve(process.env.T3_NIX_PROJECT_ROOT)
  : process.cwd();
const INDEX_DIR = process.env.T3_NIX_INDEX_DIR ? resolve(process.env.T3_NIX_INDEX_DIR) : null;
const VALIDATION_BUDGET_LIMIT = Number(process.env.T3_NIX_VALIDATION_BUDGET ?? "5");
const VALIDATION_TIMEOUT_MS = Number(process.env.T3_NIX_VALIDATION_TIMEOUT_MS ?? "30000");

let validationBudgetRemaining = VALIDATION_BUDGET_LIMIT;
let loadedIndexPromise: Promise<LoadedIndex> | null = null;

function toolContent(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError,
  };
}

function sendMessage(payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

function sendResult(id: JsonRpcRequest["id"], result: unknown) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}

function parseHeaderBlock(headerBlock: string): number | null {
  const lines = headerBlock.split("\r\n");
  const contentLengthLine = lines.find((line) => line.toLowerCase().startsWith("content-length:"));
  if (!contentLengthLine) {
    return null;
  }
  const value = Number(contentLengthLine.split(":")[1]?.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function loadIndex(): Promise<LoadedIndex> {
  if (!INDEX_DIR) {
    throw new Error("T3_NIX_INDEX_DIR is not configured.");
  }

  const [manifestText, optionsText, packagesText] = await Promise.all([
    readFile(resolve(INDEX_DIR, "manifest.json"), "utf8"),
    readFile(resolve(INDEX_DIR, "options.json"), "utf8"),
    readFile(resolve(INDEX_DIR, "packages.json"), "utf8"),
  ]);

  const manifest = JSON.parse(manifestText) as NixDesignerIndexManifest;
  const options = normalizeNixOptionDocs(JSON.parse(optionsText));
  const packages = normalizeNixPackageDocs(JSON.parse(packagesText));
  return { manifest, options, packages };
}

async function getIndex(): Promise<LoadedIndex> {
  if (loadedIndexPromise === null) {
    loadedIndexPromise = loadIndex();
  }
  return loadedIndexPromise;
}

function ensurePathWithinWorkspace(candidatePath: string | undefined): string {
  const resolvedPath = resolve(PROJECT_ROOT, candidatePath ?? ".");
  if (resolvedPath !== PROJECT_ROOT && !resolvedPath.startsWith(`${PROJECT_ROOT}/`)) {
    throw new Error("Requested path must stay within the workspace root.");
  }
  return resolvedPath;
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`${command} timed out after ${VALIDATION_TIMEOUT_MS}ms.`));
    }, VALIDATION_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr, code });
    });
  });
}

async function runValidationCommand(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<NixValidationResult> {
  if (validationBudgetRemaining <= 0) {
    throw new Error("Validation budget exhausted for this session.");
  }
  validationBudgetRemaining -= 1;
  const result = await runCommand(command, args, cwd);
  return {
    command: [command, ...args].join(" "),
    success: result.code === 0,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    diagnostics: parseNixDiagnostics(result.stderr, PROJECT_ROOT),
  };
}

function getToolDefinitions() {
  return [
    {
      name: "search_options",
      description: "Search indexed NixOS option documentation.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: "get_option",
      description: "Get one indexed NixOS option by exact name.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
        },
      },
    },
    {
      name: "search_packages",
      description: "Search indexed nixpkgs packages.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: "flake_check",
      description: "Run a guarded nix flake check inside the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    },
    {
      name: "flake_eval",
      description: "Evaluate a flake attribute with nix eval.",
      inputSchema: {
        type: "object",
        required: ["attribute"],
        properties: {
          attribute: { type: "string" },
          path: { type: "string" },
        },
      },
    },
    {
      name: "flake_show",
      description: "Show flake outputs as JSON.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    },
  ];
}

async function handleToolCall(toolCall: ToolCallRequest) {
  const args = toolCall.arguments ?? {};
  switch (toolCall.name) {
    case "search_options": {
      const index = await getIndex();
      const query = String(args.query ?? "").trim();
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10) || 10));
      const searchIndex = buildSearchIndex(index.options, (document) => ({
        key: document.name,
        searchText: [
          document.name,
          document.description,
          document.type,
          ...(document.declarations ?? []),
        ]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .join(" "),
      }));
      return toolContent({
        query,
        results: searchOptionDocs(searchIndex, query, limit),
      });
    }

    case "get_option": {
      const index = await getIndex();
      const name = String(args.name ?? "").trim();
      return toolContent({
        name,
        option: findOptionDoc(index.options, name),
      });
    }

    case "search_packages": {
      const index = await getIndex();
      const query = String(args.query ?? "").trim();
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10) || 10));
      const searchIndex = buildSearchIndex(index.packages, (document) => ({
        key: document.attr,
        searchText: [
          document.attr,
          document.pname,
          document.version,
          document.description,
          ...(document.license ?? []),
        ]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .join(" "),
      }));
      return toolContent({
        query,
        results: searchPackageDocs(searchIndex, query, limit),
      });
    }

    case "flake_check": {
      const cwd = ensurePathWithinWorkspace(typeof args.path === "string" ? args.path : ".");
      return toolContent(await runValidationCommand("nix", ["flake", "check", "--no-build"], cwd));
    }

    case "flake_eval": {
      const cwd = ensurePathWithinWorkspace(typeof args.path === "string" ? args.path : ".");
      const attribute = String(args.attribute ?? "").trim();
      if (!attribute) {
        throw new Error("attribute is required.");
      }
      return toolContent(
        await runValidationCommand("nix", ["eval", "--json", `.#${attribute}`], cwd),
      );
    }

    case "flake_show": {
      const cwd = ensurePathWithinWorkspace(typeof args.path === "string" ? args.path : ".");
      const result = await runCommand("nix", ["flake", "show", "--json"], cwd);
      return toolContent({
        command: "nix flake show --json",
        success: result.code === 0,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        diagnostics: parseNixDiagnostics(result.stderr, PROJECT_ROOT),
      });
    }

    default:
      throw new Error(`Unknown tool '${toolCall.name}'.`);
  }
}

async function handleRequest(request: JsonRpcRequest) {
  try {
    switch (request.method) {
      case "initialize":
        sendResult(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: NIX_MCP_SERVER_NAME,
            version: NIX_MCP_SERVER_VERSION,
          },
        });
        return;

      case "notifications/initialized":
        return;

      case "tools/list":
        sendResult(request.id, {
          tools: getToolDefinitions(),
        });
        return;

      case "tools/call":
        sendResult(
          request.id,
          await handleToolCall((request.params ?? {}) as unknown as ToolCallRequest),
        );
        return;

      default:
        sendError(request.id, -32601, `Method '${request.method}' is not supported.`);
    }
  } catch (error) {
    sendError(
      request.id,
      -32000,
      error instanceof Error ? error.message : "Unknown MCP server error.",
    );
  }
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", async (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = parseHeaderBlock(header);
    if (contentLength === null) {
      buffer = Buffer.alloc(0);
      return;
    }
    const bodyStart = headerEnd + 4;
    if (buffer.byteLength < bodyStart + contentLength) {
      return;
    }
    const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
    buffer = buffer.subarray(bodyStart + contentLength);
    try {
      await handleRequest(JSON.parse(body) as JsonRpcRequest);
    } catch (error) {
      sendError(
        null,
        -32700,
        error instanceof Error ? error.message : "Failed to parse JSON-RPC payload.",
      );
    }
  }
});
