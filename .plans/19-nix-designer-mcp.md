# Plan: Nix Designer (Knowledge MCP + Validation Loop)

## Why this plan exists

HAL already has the **deployment half** of a NixOS tool: `FlakeMetadataResolver`, `FlakeMaintenanceService`, `HostDeploymentService`, `HostImportService`, `FleetDeploymentService`, `DeployRsResolver`, plus the `HostDeploymentTerminal`, `FlakeMaintenanceTerminal`, and `flakeDashboardHostMenu` UI surfaces.

The **designer half** — actually authoring and editing NixOS configuration intelligently — does not exist. Today, generation quality depends entirely on whatever Codex or Claude know about Nix from training. That is the weakest part of any general coding agent: hallucinated option paths, deprecated patterns, missing imports, drift between channels.

The original instinct here was "fine-tune a Nix model." That is the wrong primitive. Most Nix authoring failures are factual (does this option exist on this channel? does this evaluator accept this expression?) and factual problems are solved by **retrieval plus a real evaluator in the loop**, not by baking ephemeral knowledge into weights.

This plan adds a Nix knowledge and validation surface that:

1. Stays provider-agnostic (works with both Codex and Claude through the existing adapter pattern).
2. Plugs into the existing orchestration engine without new WS channels.
3. Exposes itself via **MCP** so the existing provider adapters consume it natively, with no provider-specific code paths.
4. Closes the loop with `nix flake check` / `nix eval` rather than relying on model self-correction.

---

## Current constraints to design around

1. Provider adapters consume tools through their SDK-native MCP/tool surfaces. The orchestration layer must not be aware of Nix-specific tool calls.
2. `ProviderSessionStartInput.providerOptions.claudeCode` and `providerOptions.codex` are the only legitimate places to wire provider-side configuration; anything Nix-specific lives under designer-owned services and gets surfaced to providers as MCP server descriptors.
3. The repo already enforces canonical `ProviderRuntimeEvent` ingestion (Plan 17, Phase 1). Tool call/result events from the Nix MCP server must map into existing canonical event kinds (`tool.summary`, `request.opened`, `request.resolved`), not new ones.
4. `apps/server/src/project/Services/*` is the established home for project-scoped services using the Effect `Context.Service` pattern. New services must follow the same shape.
5. Schemas live in `packages/contracts/src/*.ts` and stay schema-only (no runtime logic). Per `AGENTS.md`, this rule is hard.
6. Validation/build commands are `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` (never `bun test`). All four must pass on completed work.

---

## Architecture target

Add a Nix knowledge and validation MCP server, an indexing pipeline for NixOS option/package data, and a designer workflow surface on top of the existing flake dashboard.

Key decisions:

1. **Integration boundary is MCP.** The Nix knowledge layer is exposed as a stdio MCP server. Both Codex and the Claude Agent SDK consume MCP servers natively. No new provider adapter, no provider-specific tool plumbing.
2. **Knowledge is per-channel, content-addressed.** Indices are keyed by `nixpkgs` revision. A given thread/project pins a channel; switching channels re-indexes (or hits cache).
3. **Retrieval is hybrid.** Vector + BM25 + exact-prefix trie over option paths. Prefix trie is non-negotiable for option-path completion; embeddings alone cannot reliably rank `services.nginx.enable` over `services.nginx.virtualHosts.<name>.enableACME`.
4. **Validation is in-loop.** A bounded `flake_check` / `flake_eval` tool is exposed via the MCP server. The agent is expected to call it; an iteration cap (default 3) is enforced server-side.
5. **No fine-tuning in v1.** The plan deliberately ships zero training artifacts. Fine-tuning is reconsidered only after evals show a residual gap that retrieval cannot close.
6. **Designer flow reuses orchestration.** Designer turns are normal threads on the existing `OrchestrationEngine`. The "designer" surface is a UI mode and a project-scoped MCP server descriptor — not a parallel pipeline.

---

## Phase 1: Contracts and shared types

### 1.1 Add `nixDesigner.ts` to contracts

Create `packages/contracts/src/nixDesigner.ts`:

1. `NixChannel` — branded string identifying a `nixpkgs` revision (commit SHA or release tag like `25.05`).
2. `NixOptionRef` — `{ path: string; channel: NixChannel }`.
3. `NixOptionDoc` — `{ path; type; default?; example?; description; declaredIn: ReadonlyArray<string> }`.
4. `NixPackageRef` — `{ attr: string; channel: NixChannel }`.
5. `NixPackageDoc` — `{ attr; pname; version; description?; license?; meta? }`.
6. `NixIndexStatus` — `{ channel; revision; builtAt; optionCount; packageCount; sizeBytes }`.
7. `NixValidationResult` — discriminated union `{ kind: "ok" } | { kind: "error"; diagnostics: ReadonlyArray<NixDiagnostic> }`.
8. `NixDiagnostic` — `{ severity; message; sourceFile?; line?; column?; optionPath?; raw: string }`.

All declared as Effect `Schema` types, exported through `packages/contracts/src/index.ts`. No runtime logic — `AGENTS.md` rule.

### 1.2 Designer command/event surface (orchestration)

Update `packages/contracts/src/orchestration.ts`:

1. Add optional `designer?: { channel: NixChannel; flakePath: string }` to `ThreadTurnStartCommand`. Carries through `ThreadTurnStartRequestedPayload`.
2. Add a `NixDesignerSessionScope` schema (designer is a thread-level mode, not a separate provider).
3. No new WS push channels. Designer activity surfaces through existing `orchestration.domainEvent`.

This mirrors how `provider` was added to turn-start in Plan 17 — designer mode is opt-in, the turn command stays valid without it.

### 1.3 MCP server descriptor in `provider.ts`

Update `packages/contracts/src/provider.ts`:

1. Extend `ProviderSessionStartInput` to accept a `mcpServers?: ReadonlyArray<McpServerDescriptor>` array (provider-agnostic).
2. `McpServerDescriptor` — `{ name; transport: "stdio"; command; args; env? }`.
3. Adapter layer (Codex or Claude) is responsible for translating descriptors into its SDK's MCP-server format.

This is the only point where MCP enters the provider boundary. Designer mode just appends one descriptor.

### 1.4 Contract tests

Add tests in `packages/contracts/src/nixDesigner.test.ts` and extend `orchestration.test.ts`, `provider.test.ts`:

1. Schema round-trips for all new types.
2. Backwards-compat: turn-start without `designer` and start input without `mcpServers` still validate.
3. `NixValidationResult` discriminated-union narrowing.

---

## Phase 2: Nix knowledge package

Create new package `packages/nix-knowledge`. Pure logic, Effect-native, no I/O at the import level. This is the only "library" the rest of the system depends on.

### 2.1 Package skeleton

```
packages/nix-knowledge/
  package.json
  tsconfig.json
  src/
    index.ts                       # subpath exports only, no barrels
    indexer/
      OptionsIndexer.ts            # Service
      PackagesIndexer.ts           # Service
      NixpkgsResolver.ts           # Service
    storage/
      LanceVectorStore.ts          # Service
      BM25Store.ts                 # Service
      OptionPathTrie.ts            # pure
      IndexCache.ts                # Service (XDG cache layout)
    retrieval/
      HybridRetriever.ts           # Service composing vector + BM25 + trie
      Reranker.ts                  # Service (optional, can be no-op v1)
    validate/
      FlakeValidator.ts            # Service wrapping `nix flake check` / `nix eval`
      DiagnosticsParser.ts         # pure
    embedding/
      EmbeddingClient.ts           # Service (interface only, impls injected)
```

Subpath exports per `AGENTS.md` ("no barrel index"): `@t3tools/nix-knowledge/indexer`, `@t3tools/nix-knowledge/retrieval`, etc.

### 2.2 Indexer behavior

`OptionsIndexer.build(channel)`:

1. Resolve `nixpkgs` rev from channel via `NixpkgsResolver` (which calls `nix flake metadata`).
2. Run `nix-instantiate --eval --strict --json -E '(import <nixpkgs/nixos/release.nix> {}).options'` (or equivalent — there is a maintained option-doc JSON path; confirm during implementation).
3. For each option: write a record with `{ path, type, default, example, description, declaredIn }`.
4. Embed `path + " — " + description` via injected `EmbeddingClient`.
5. Persist to LanceDB (vector), an inverted index (BM25), and a serialized prefix trie (option paths only, packed contiguously).
6. Index identity: `sha256(rev || schema_version)`.

`PackagesIndexer.build(channel)`:

1. Source from `nix-env -qaP --json` against the pinned channel, or `meta.json` if available.
2. Same vector + BM25 indexing on `pname + " — " + description`.

### 2.3 Hybrid retrieval

`HybridRetriever.search(query, opts)`:

1. Run vector search, BM25 search, and prefix-trie lookup in parallel via `Effect.all({ ..., concurrency: 3 })`.
2. Merge with reciprocal-rank fusion. Default weights: trie 0.5, BM25 0.3, vector 0.2 — option paths are dominant in this domain.
3. Return at most `opts.limit` (default 8) results, each with `{ doc; sourceLane; score }`.

### 2.4 Validator

`FlakeValidator.check(flakePath)`:

1. Spawn `nix flake check --no-build --json` via the existing `processRunner` utility (`apps/server/src/processRunner.ts`) — do not invent a new process abstraction.
2. Stream stderr through `DiagnosticsParser` to produce structured `NixDiagnostic[]`.
3. Return `NixValidationResult`.

`FlakeValidator.eval(flakePath, attribute)`:

1. `nix eval --json <flakePath>#<attribute>`.
2. Same diagnostic parsing on failure.

`DiagnosticsParser` is pure: regex over Nix's error format extracting `file:line:col`, message, and (when present) the option path mentioned in `attribute 'X' missing` style errors.

### 2.5 Indexer tests

`packages/nix-knowledge/src/**/*.test.ts`:

1. Indexer test against a tiny fixture nixpkgs (committed sample JSON, not a real checkout).
2. Trie correctness: prefix queries, ambiguous prefixes, option-path normalization.
3. Hybrid retrieval: contrived corpus, assert RRF ordering matches expectation.
4. Diagnostics parser: golden tests against captured `nix` error output.

Run with `bun run test`. Never `bun test`.

---

## Phase 3: Nix MCP server

Create new package `packages/nix-mcp-server`. This is the process the providers actually talk to.

### 3.1 Skeleton

```
packages/nix-mcp-server/
  package.json
  src/
    bin.ts          # stdio entrypoint
    server.ts       # MCP server bootstrap (uses official @modelcontextprotocol/sdk)
    tools/
      searchOptions.ts
      getOption.ts
      searchPackages.ts
      readManual.ts
      flakeCheck.ts
      flakeEval.ts
      flakeShow.ts
      listExamples.ts   # optional v1.1
    runtime.ts      # Effect runtime composing nix-knowledge layers
```

`bin.ts` is the binary referenced by the `McpServerDescriptor.command`.

### 3.2 Tool surface (v1)

Each tool is a thin shim over `nix-knowledge` services:

1. `search_options(query, channel?, limit?)` → `NixOptionDoc[]`.
2. `get_option(path, channel?)` → `NixOptionDoc | null`.
3. `search_packages(query, channel?, limit?)` → `NixPackageDoc[]`.
4. `read_manual(section, channel?)` → markdown chunk.
5. `flake_check(flakePath)` → `NixValidationResult`.
6. `flake_eval(flakePath, attribute)` → `{ value: unknown } | NixValidationResult`.
7. `flake_show(flakePath)` → outputs tree.

Each tool input/output schema is defined with `effect/Schema` and reused from `@t3tools/contracts`. No re-declaration.

### 3.3 Bounded validation loop

`flake_check` and `flake_eval` enforce:

1. A per-session call budget (default 5 calls). When exhausted, return a structured `{ kind: "error"; diagnostics: [{ severity: "error"; message: "validation budget exhausted" }] }`. The agent must surface this to the user; do not silently retry.
2. A wall-clock cap per call (default 30s).
3. The flake under check must be inside the project workspace root. Reject paths that escape it.

The budget is the single most important guardrail. Without it, agents will burn evaluator iterations indefinitely.

### 3.4 Configuration

Server reads on startup:

1. `T3_NIX_CHANNEL` — default channel pin.
2. `T3_NIX_INDEX_DIR` — index cache directory (defaults to `${XDG_CACHE_HOME}/t3code/nix-index`).
3. `T3_NIX_PROJECT_ROOT` — workspace root for path validation.
4. `T3_NIX_EMBEDDING_BACKEND` — `local-mlx` | `ollama` | `none` (none disables vector lane, retrieval falls back to BM25 + trie).

Local embedding backends are first-class — this is an Apple Silicon target.

### 3.5 MCP server tests

1. Tool-level unit tests against in-process knowledge layers.
2. End-to-end stdio test: spawn `bin.ts`, send a `tools/list` request, assert advertised schema.
3. Budget exhaustion test on `flake_check`.

---

## Phase 4: Server-side designer service

### 4.1 Add `NixDesignerService`

Create `apps/server/src/project/Services/NixDesignerService.ts` and `apps/server/src/project/Layers/NixDesignerService.ts`, mirroring the shape of `FlakeMetadataResolver`:

```ts
export interface NixDesignerServiceShape {
  readonly resolveDescriptor: (
    project: ProjectRef,
  ) => Effect.Effect<McpServerDescriptor, NixDesignerError>;
  readonly indexStatus: (
    project: ProjectRef,
  ) => Effect.Effect<NixIndexStatus | null>;
  readonly buildIndex: (
    project: ProjectRef,
    channel: NixChannel,
  ) => Effect.Effect<NixIndexStatus, NixDesignerError>;
}

export class NixDesignerService extends Context.Service<
  NixDesignerService,
  NixDesignerServiceShape
>()("t3/project/Services/NixDesignerService") {}
```

Responsibilities:

1. Resolve the channel for a project (from flake metadata via `FlakeMetadataResolver`).
2. Build/look up the index.
3. Produce an `McpServerDescriptor` pointing at `packages/nix-mcp-server` with the right env vars.

### 4.2 Wire descriptor into turn start

Update orchestration command handling so that when `ThreadTurnStartCommand.designer` is present:

1. Resolve descriptor via `NixDesignerService`.
2. Append it to `ProviderSessionStartInput.mcpServers`.
3. Pass through unchanged into the active provider adapter.

This is the only place orchestration touches designer-specific logic. Adapters remain ignorant of "designer mode" as a concept — they just see one more MCP server.

### 4.3 Index lifecycle

1. On first designer turn for a project, check index status. If missing, build synchronously and stream progress as orchestration domain events (existing `tool.summary` channel).
2. On channel change (detected via `FlakeMetadataResolver`), invalidate.
3. Background refresh on a configurable interval is **out of scope** for v1.

### 4.4 Service tests

`apps/server/src/project/Services/NixDesignerService.test.ts`:

1. Descriptor resolution with and without an existing index.
2. Channel-change invalidation.
3. Failure path: nixpkgs unreachable / `nix` binary missing — must produce a `NixDesignerError` that orchestration can surface as `runtime.error`.

---

## Phase 5: Web — Designer surface

### 5.1 Mode toggle on flake dashboard

Extend `apps/web/src/routes/_chat.$environmentId.flake.$projectId.tsx`:

1. Add a "Designer" toggle next to existing flake dashboard tabs.
2. When enabled, new turns include `designer: { channel, flakePath }` in their start command.
3. Persist toggle in project state.

### 5.2 Index status panel

New component `apps/web/src/components/NixDesignerStatusPanel.tsx`:

1. Shows current channel, index revision, option/package counts, build age.
2. Manual rebuild button (wired through orchestration command, not a direct WS RPC).
3. Inline build progress while indexing.

### 5.3 Validation surfacing

Tool-call events from the MCP server already flow as `tool.summary`. Add a small renderer in the existing chat timeline (`apps/web/src/components/chat/MessagesTimeline.tsx`) that recognizes `flake_check` / `flake_eval` tool calls and renders the diagnostics list inline with file/line links.

No new event types. No new WS channels.

### 5.4 No new state machines

Resist adding a "designer flow" component with its own state. Designer mode is just a flag on a thread; everything else is reused.

---

## Phase 6: Eval harness

This is the part most likely to be skipped and most important to keep.

### 6.1 Layout

```
packages/nix-knowledge/eval/
  prompts/
    001-nginx-reverse-proxy.json
    002-postgresql-with-backups.json
    ...
  runner.ts
  fixtures/
    minimal-flake/
```

Each prompt fixture:

```json
{
  "id": "001-nginx-reverse-proxy",
  "channel": "25.05",
  "user": "Configure nginx as a reverse proxy for an app on port 3000 with ACME TLS for example.com.",
  "acceptance": {
    "mustEvalCleanly": true,
    "mustContainOptions": [
      "services.nginx.enable",
      "services.nginx.virtualHosts",
      "security.acme.acceptTerms"
    ],
    "mustNotContainOptions": [
      "services.nginx.virtualHosts.<name>.enableSSL"
    ]
  }
}
```

### 6.2 Runner

`runner.ts`:

1. Loads each prompt.
2. Spawns a thin headless harness that talks directly to the MCP server with a stub LLM (or, optionally, a real provider).
3. Records: tool calls made, final flake produced, `nix flake check` result, acceptance verdict.
4. Outputs JSON report + a short markdown summary.

The runner is invoked via a `bun` script, not through the orchestration engine. It is the only place where the knowledge stack is exercised end-to-end without provider involvement.

### 6.3 What the eval is for

1. Catching index regressions on channel bumps.
2. Comparing retrieval-weight changes (RRF ratios).
3. Sanity-checking before merging knowledge-layer changes.

It is **not** a benchmark for "the model got better." That comparison belongs in a future fine-tuning plan if one materializes.

---

## Phase 7: Testing strategy

Per `AGENTS.md`: `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` must all pass.

### 7.1 Layered coverage

1. **Contract tests** (Phase 1.4) — schema round-trips.
2. **Library tests** (Phase 2.5) — knowledge primitives.
3. **MCP server tests** (Phase 3.5) — tool boundary.
4. **Service tests** (Phase 4.4) — orchestration integration point.
5. **Eval suite** (Phase 6) — end-to-end against canned prompts.

### 7.2 Integration tests through orchestration

Add `apps/server/src/project/integration/nix-designer.integration.test.ts`:

1. Start a thread with `designer: { ... }` against a fake provider adapter that records the `mcpServers` it was handed.
2. Assert the descriptor matches what `NixDesignerService` produced.
3. Assert no orchestration events leak Nix-specific shapes.

### 7.3 Forbidden patterns to assert against

A small lint or codemod check is worth adding:

1. No imports of `@t3tools/nix-knowledge` from `apps/web/*` (UI never touches the indexer).
2. No imports of `@t3tools/nix-mcp-server` from anywhere except its own bin and tests.
3. No new WS push channels for designer events.

---

## Phase 8: Rollout order

Recommended implementation sequence — agents picking this up should not reorder without a strong reason:

1. Phase 1 — contracts (smallest, unblocks everything).
2. Phase 2.1–2.4 — `nix-knowledge` library minus retrieval polish.
3. Phase 3.1–3.3 — MCP server with the seven core tools.
4. Phase 4 — server-side `NixDesignerService` and turn-start wiring.
5. Phase 5.1 + 5.3 — minimum-viable UI toggle and validation rendering.
6. Phase 6 — eval harness (do this **before** declaring v1 done; it is the thing that proves the rest works).
7. Phase 5.2 — index status panel.
8. Phase 2.5 / 7.2 — integration test sweep.

Ship-able milestone: after step 5, a user can flip designer mode and have either Codex or Claude author flakes with the Nix MCP server attached. Step 6 is the gate for declaring it *good*.

---

## Non-goals

1. **Fine-tuning a Nix-specific model.** Reconsidered only when evals show a residual gap retrieval cannot close. Until then, training data and adapters do not exist in this repo.
2. **A separate "designer provider" adapter.** Designer mode is a thread flag plus an MCP descriptor. Adding a provider adapter would re-introduce the bypass paths Plan 17 explicitly forbids.
3. **New WS push channels.** All designer events ride existing `orchestration.domainEvent` shapes.
4. **Deploy automation triggered from designer flow.** Deployment is `HostDeploymentService`'s job. The designer's last step is "produce a validated flake on disk." Deployment is initiated separately by the user from existing surfaces.
5. **Multi-channel concurrent indices.** v1 keeps one active index per project. Channel switches re-index.
6. **Background index refresh.** v1 only rebuilds on explicit request or first designer turn after a channel change.
7. **Fancy reranking.** v1 ships with reciprocal-rank fusion only. Cross-encoder rerankers are a future optimization once evals justify them.
