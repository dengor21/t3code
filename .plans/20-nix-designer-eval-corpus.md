# Plan: Nix Designer Eval Corpus

## Why this plan exists

Plan 19 establishes the eval harness skeleton (Phase 6). It does not specify what an eval prompt actually looks like, what counts as "passing," or how to interpret a regression. Without that, the harness is a script that runs and produces numbers nobody trusts.

This plan defines the corpus: fixture format, categories, scoring rubric, regression policy. It is a companion to Plan 19 and depends on Phases 1–4 of it being landed first.

The corpus is the part of the system that decides whether everything else is working. Treat it like production data: schema-versioned, code-reviewed, and small enough that humans can inspect every entry.

---

## Current constraints to design around

1. The eval runner from Plan 19 Phase 6 lives in `packages/nix-knowledge/eval/` and is invoked through `bun` scripts. It must not depend on `apps/server` or `apps/web`.
2. Acceptance verdicts are computed locally — no model-graded scoring in v1. Models are the thing being measured; using a model to grade introduces a feedback loop the corpus cannot account for.
3. Fixtures are committed to the repo. They must be small enough to review on a PR (target ≤ 80 lines per fixture).
4. `nix flake check` is the source of truth for "does it evaluate." Anything checked beyond that is a layered assertion on top of a passing evaluation.
5. Per `AGENTS.md`: `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` must pass.

---

## Architecture target

A versioned, schema-validated fixture set with three tiers of difficulty, four assertion modes, and a deterministic scoring function. The runner produces a single JSON report per run plus a checked-in golden baseline for regression detection.

Key decisions:

1. **Fixtures are JSON, not TS.** They are data, not code. They get validated by an Effect Schema at load time and at PR-submit time.
2. **Acceptance is layered.** Every prompt has a hard floor (must evaluate cleanly). Optional layers add option-presence, option-absence, package-presence, and shape assertions.
3. **No semantic similarity scoring on output flakes.** Two flakes that produce the same NixOS configuration can look very different textually. Either it evaluates and matches the layered assertions, or it doesn't.
4. **Categories are stable; difficulty is not.** Difficulty is a property of the model, not the prompt. We tag complexity instead — number of services, cross-module references, etc.
5. **A baseline JSON is checked in.** PRs that change retrieval weights must update the baseline and explain regressions in the PR description.

---

## Phase 1: Fixture schema

### 1.1 Add fixture schema to `nix-knowledge`

Create `packages/nix-knowledge/eval/schema.ts`. Schema-only, follows the contracts pattern from Plan 19.

```ts
import { Schema } from "effect";

export const NixEvalCategory = Schema.Literal(
  "service-config",
  "package-install",
  "user-management",
  "networking",
  "boot-and-fs",
  "secrets",
  "module-authoring",
  "flake-structure",
);

export const NixEvalComplexity = Schema.Struct({
  serviceCount: Schema.Number,
  modulesAuthored: Schema.Number,
  crossModuleRefs: Schema.Number,
  requiresSecrets: Schema.Boolean,
});

export const NixOptionAssertion = Schema.Struct({
  path: Schema.String,
  mustEqual: Schema.optional(Schema.Unknown),
  mustExist: Schema.optional(Schema.Boolean),
});

export const NixPackageAssertion = Schema.Struct({
  attr: Schema.String,
  mustBePresent: Schema.Boolean,
});

export const NixShapeAssertion = Schema.Struct({
  attribute: Schema.String,
  jsonPath: Schema.String,
  matches: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("equals"), value: Schema.Unknown }),
    Schema.Struct({ kind: Schema.Literal("regex"), pattern: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("type"), type: Schema.String }),
  ),
});

export const NixEvalAcceptance = Schema.Struct({
  mustEvalCleanly: Schema.Boolean,
  options: Schema.optional(Schema.Array(NixOptionAssertion)),
  forbiddenOptions: Schema.optional(Schema.Array(Schema.String)),
  packages: Schema.optional(Schema.Array(NixPackageAssertion)),
  shape: Schema.optional(Schema.Array(NixShapeAssertion)),
});

export const NixEvalFixture = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String, // kebab-case, matches filename
  channel: Schema.String, // e.g. "25.05"
  category: NixEvalCategory,
  complexity: NixEvalComplexity,
  user: Schema.String, // the prompt
  systemHints: Schema.optional(Schema.String),
  acceptance: NixEvalAcceptance,
  notes: Schema.optional(Schema.String),
});
```

Export through `packages/nix-knowledge/eval/index.ts` (subpath `@t3tools/nix-knowledge/eval`).

### 1.2 Schema validation tests

`packages/nix-knowledge/eval/schema.test.ts`:

1. Round-trip every checked-in fixture through the schema at test time. Failure here blocks merge.
2. Reject fixtures missing `mustEvalCleanly: true` (the hard floor is non-negotiable).
3. Reject `id` values that don't match `^\d{3}-[a-z0-9-]+$`.
4. Reject `channel` values not in the supported set (driven by a constants file you can extend).

---

## Phase 2: Assertion engine

### 2.1 Add `AcceptanceEvaluator`

Create `packages/nix-knowledge/eval/AcceptanceEvaluator.ts`. Pure logic, Effect-native.

```ts
export interface AcceptanceEvaluatorShape {
  readonly evaluate: (
    fixture: NixEvalFixture,
    artifact: GeneratedFlakeArtifact,
  ) => Effect.Effect<AcceptanceVerdict>;
}
```

`GeneratedFlakeArtifact` is the output of one eval run:

```ts
{
  flakePath: string;
  flakeCheck: NixValidationResult;
  evalProbes: ReadonlyMap<string, unknown>;
  toolCallTrace: ReadonlyArray<RecordedToolCall>;
}
```

Evaluation order is fixed:

1. **Hard floor** — `flakeCheck.kind === "ok"`. Failure short-circuits with verdict `failed-to-evaluate`. No further assertions are checked.
2. **Forbidden options** — any forbidden option present yields `forbidden-option-used`.
3. **Required options** — each `NixOptionAssertion` checked against the evaluated configuration via `nix eval`.
4. **Required packages** — each must appear in `environment.systemPackages` or the closure.
5. **Shape** — each `NixShapeAssertion` evaluated by running `nix eval --json <flakePath>#<attribute>` and matching against `jsonPath`.

Verdict is one of:

```ts
"pass" | "failed-to-evaluate" | "forbidden-option-used" |
"missing-option" | "missing-package" | "shape-mismatch"
```

Plus a structured `details` payload pointing to the exact assertion that failed.

### 2.2 Probe execution

The runner pre-computes which `nix eval` probes are needed across all assertions for a given fixture, then runs them in a single batched `nix eval` invocation when possible. This keeps eval-suite runtime tractable on the M4 Max — each `nix eval` cold-start dominates per-assertion cost.

### 2.3 Tests

`AcceptanceEvaluator.test.ts`:

1. Each verdict kind has at least one positive and one negative test.
2. Hard-floor short-circuit is exercised (downstream assertions must not be evaluated when flake-check fails).
3. Shape assertions: golden tests for `equals`, `regex`, `type`.

---

## Phase 3: Initial corpus

Seed with **15 fixtures** spanning the eight categories. This is intentionally small. A corpus that takes 30 minutes to inspect is a corpus that gets reviewed; a corpus of 200 prompts is a corpus that rots.

Layout:

```
packages/nix-knowledge/eval/prompts/
  001-nginx-reverse-proxy.json
  002-postgresql-with-backups.json
  003-systemd-timer-job.json
  004-user-with-ssh-keys.json
  005-tailscale-with-exit-node.json
  006-zfs-root-pool.json
  007-podman-rootless-container.json
  008-secrets-via-sops-nix.json
  009-custom-module-firewall-zone.json
  010-flake-with-deploy-rs-host.json
  011-home-manager-vscode.json
  012-overlay-pin-package-version.json
  013-binary-cache-and-substituters.json
  014-acme-multidomain-tls.json
  015-import-existing-hardware-configuration.json
```

### 3.1 Authoring rules

1. Every fixture targets channel `25.05` for the initial corpus. Channel-bump fixtures get added in their own PR.
2. Every prompt is something a real user would actually ask, not synthetic. Mine NixOS Discourse and the GitHub `nixos/nixpkgs` discussions tag.
3. Acceptance always includes at least one **forbidden option** when the prompt has a known footgun (e.g. `services.nginx.virtualHosts.<name>.enableSSL` is the classic deprecated alias for `forceSSL`/`addSSL`).
4. Prompts do not mention specific option names. The point of the eval is whether the model finds them through retrieval; spoon-feeding option paths defeats the test.

### 3.2 Example fixture (concrete)

```json
{
  "schemaVersion": 1,
  "id": "001-nginx-reverse-proxy",
  "channel": "25.05",
  "category": "service-config",
  "complexity": {
    "serviceCount": 2,
    "modulesAuthored": 0,
    "crossModuleRefs": 1,
    "requiresSecrets": false
  },
  "user": "Configure nginx as a reverse proxy for an app running on localhost port 3000, served at example.com over HTTPS using Let's Encrypt.",
  "acceptance": {
    "mustEvalCleanly": true,
    "options": [
      { "path": "services.nginx.enable", "mustEqual": true },
      { "path": "security.acme.acceptTerms", "mustEqual": true },
      { "path": "services.nginx.virtualHosts.\"example.com\".forceSSL", "mustEqual": true }
    ],
    "forbiddenOptions": [
      "services.nginx.virtualHosts.\"example.com\".enableSSL"
    ],
    "shape": [
      {
        "attribute": "nixosConfigurations.test.config.services.nginx.virtualHosts.\"example.com\".locations.\"/\".proxyPass",
        "jsonPath": "$",
        "matches": { "kind": "regex", "pattern": "^http://(127\\.0\\.0\\.1|localhost):3000/?$" }
      }
    ]
  },
  "notes": "enableSSL is a deprecated alias; forceSSL + enableACME is the current pattern."
}
```

### 3.3 Fixture review checklist (PR template)

When adding or editing a fixture, the PR description must answer:

1. What real-world question does this represent?
2. Why is each assertion necessary — what would a wrong answer look like that this catches?
3. What is the failure mode this fixture is designed to detect (hallucinated option, deprecated pattern, missing import, etc.)?
4. Does the fixture pass when run against the corpus baseline today?

---

## Phase 4: Runner and reporting

### 4.1 Extend the Phase-19 runner

`packages/nix-knowledge/eval/runner.ts`:

1. Loads all fixtures in `prompts/`.
2. Validates each through the schema. Failure halts the run.
3. For each fixture:
   - Spawns the MCP server in a tempdir workspace.
   - Drives an LLM (configurable backend) with the prompt, the `flakePath` of a scaffold flake, and the available MCP tools.
   - Captures the final flake plus the full tool-call trace.
   - Runs `AcceptanceEvaluator`.
4. Aggregates verdicts into a report.

### 4.2 LLM backends

Pluggable via env:

1. `T3_EVAL_LLM=anthropic` — calls Claude (requires `ANTHROPIC_API_KEY`).
2. `T3_EVAL_LLM=openai` — calls GPT (requires `OPENAI_API_KEY`).
3. `T3_EVAL_LLM=local-mlx` — calls a local MLX-served model.
4. `T3_EVAL_LLM=stub` — deterministic stub for CI, returns a canned flake per fixture id. Used to verify the harness, not the model.

The stub backend is what gets exercised in the unit-test suite. Real backends are run on demand.

### 4.3 Report format

`eval/reports/<timestamp>-<commit>.json`:

```ts
{
  runId: string;
  commit: string;
  llm: string;
  channel: string;
  perFixture: Array<{
    id: string;
    verdict: AcceptanceVerdict;
    toolCallCount: number;
    durationMs: number;
    flakeCheckMs: number;
  }>;
  summary: {
    pass: number;
    failedToEvaluate: number;
    forbiddenOption: number;
    missingOption: number;
    missingPackage: number;
    shapeMismatch: number;
    passRate: number;
  };
}
```

Plus a sibling markdown summary auto-generated for human reading.

### 4.4 Baseline file

`packages/nix-knowledge/eval/baseline.json`:

1. Pinned report from a known-good run.
2. Updated only by an explicit PR that includes the new run output and a justification.
3. The runner has a `--compare-baseline` flag that exits non-zero if the current pass rate is **lower** than baseline by more than the configured tolerance (default: any regression on `failedToEvaluate` is fatal; ≥ 1 fixture regression on other verdicts requires explanation).

This is the gate: if you change retrieval weights or tool descriptions, you re-run, you commit the new baseline, you justify the diff in the PR.

---

## Phase 5: Wiring into CI

### 5.1 Local target

Add to `justfile`:

```
eval:
    nix develop -c bun run --filter @t3tools/nix-knowledge eval

eval-stub:
    T3_EVAL_LLM=stub nix develop -c bun run --filter @t3tools/nix-knowledge eval
```

### 5.2 CI behavior

In CI, `eval-stub` runs as part of the standard test gate. It catches:

1. Fixture schema breakage.
2. Acceptance evaluator regressions.
3. Runner-level bugs.

The real-LLM eval is **not** in CI. It is a manual run before merging changes to `nix-knowledge` retrieval, indexer, or tool surface. Cost and nondeterminism rule it out of CI.

### 5.3 Required-checks expansion

Update `.docs/ci.md` to document `eval-stub` as a required check on changes touching:

1. `packages/nix-knowledge/**`
2. `packages/nix-mcp-server/**`
3. `packages/contracts/src/nixDesigner.ts`

---

## Phase 6: Drift monitoring

### 6.1 Channel-bump checklist

When `nixpkgs` 25.11 lands and we want the corpus to cover it:

1. Branch the corpus: copy `prompts/` to `prompts-25.11/` (or extend channels per fixture — decide once on convention).
2. Run the suite against the new channel.
3. Diagnose every regression: did the option get renamed? Deprecated? Did the type change? Update fixture or update knowledge layer accordingly.
4. Bump baseline.

This is the maintenance cost of skipping fine-tuning. It is small, predictable, and entirely under our control.

### 6.2 Stale-fixture detection

Add a quarterly job (manual for v1, possibly automated later) that runs every fixture against the latest stable channel and flags any new failures. Fixtures that go stale because the underlying option changed get patched. Fixtures that go stale because the prompt no longer reflects realistic usage get retired with a note in `notes`.

---

## Phase 7: Tests

`packages/nix-knowledge/eval/**/*.test.ts`:

1. Schema validation (Phase 1.2).
2. Evaluator verdict matrix (Phase 2.3).
3. Runner end-to-end against the stub backend (Phase 4.2).
4. Baseline-compare exit codes (Phase 4.4).

All run through `bun run test`.

---

## Phase 8: Rollout order

1. Phase 1 — schema and validation.
2. Phase 2 — acceptance evaluator.
3. Phase 3 — seed five fixtures (`001` through `005`). Verify pass against a manually-constructed flake to confirm the assertion engine works. Add the remaining ten in a second PR.
4. Phase 4 — runner with the stub backend.
5. Phase 5 — CI wiring.
6. Phase 4 again — real-LLM backends.
7. Establish first baseline.

Ship-able milestone: after step 5, every PR touching the knowledge layer triggers `eval-stub`. After step 7, retrieval-weight changes are quantitatively justified.

---

## Non-goals

1. **Model-graded scoring.** A model judging models is a feedback loop without an anchor. v1 uses only programmatic verdicts.
2. **Pass-rate as a single headline number.** The verdict breakdown matters; collapsing it loses the signal that says *which kind* of failure regressed.
3. **A "leaderboard" comparing models.** This corpus exists to detect regressions in the knowledge stack, not to rank LLM providers. Cross-model comparisons are anecdotes; they should not be reported as benchmarks.
4. **Synthetic prompt generation.** Every fixture is hand-authored from a real user question. Synthetic prompts measure synthetic prompts.
5. **Coverage of every NixOS option.** Coverage of *patterns* — reverse proxy, secrets, module authoring, hardware integration — is the goal. The corpus is a tasting menu, not a phone book.
6. **Eval-driven training data.** Fixtures are evaluation, not training. If Plan 21 happens, its training set is built from a different pipeline. Mixing them produces a model that overfits to the eval and tells you nothing.
