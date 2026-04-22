# Prelude
The following readme is AI written for now. 
Real docs will follow.

# T3 Code

T3 Code is a local-first UI and runtime for coding agents.

This fork has diverged heavily from the original project. It is no longer just a lightly modified upstream app. The current codebase combines:

- a Node.js WebSocket backend that brokers provider sessions and serves the app
- a React web UI for chat, plans, approvals, diffs, terminal output, and project state
- an Electron desktop shell that runs the same backend locally
- headless and remote flows with pairing links and session auth
- Nix-flake-aware project, maintenance, and deployment workflows for repos that expose them

The repo is still early and moving fast. Performance, reliability, and predictable behavior under reconnects, partial streams, and failures are the main priorities.

## What This Repo Is Now

- Codex-first orchestration around `codex app-server` over JSON-RPC on stdio
- Shared typed contracts between server and client
- A streamed runtime -> orchestration -> UI event pipeline
- Multiple provider surfaces in the workspace: Codex, Claude, Cursor, and OpenCode
- Git-aware UX for changed files, diffs, plans, approvals, and terminal activity
- Headless server mode via `t3 serve`, plus pairing and authenticated remote access
- Flake-specific dashboards for host deployment, flake maintenance, and host-oriented workflows

## Architecture

At a high level:

1. `apps/server` runs the main backend, manages provider sessions, persists orchestration state, and serves the UI.
2. `apps/web` connects to that backend over WebSocket and renders the session/project experience.
3. `apps/desktop` packages the backend and UI into a local Electron app.
4. Shared contracts and runtime utilities live under `packages/*`.

The current architecture is documented in more detail in [.docs/architecture.md](./.docs/architecture.md).

## Workspace Layout

| Path                               | Role                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/server`                      | Node.js WebSocket server, provider orchestration, auth, persistence, static hosting |
| `apps/web`                         | React + Vite frontend for chat, sessions, diffs, terminals, and project views       |
| `apps/desktop`                     | Electron shell that starts a desktop-scoped backend and loads the shared UI         |
| `apps/marketing`                   | Marketing and download site                                                         |
| `packages/contracts`               | Shared effect/Schema contracts and TypeScript types                                 |
| `packages/shared`                  | Shared runtime utilities used by both server and web                                |
| `packages/client-runtime`          | Shared client/runtime environment helpers                                           |
| `packages/effect-acp`              | ACP protocol client/runtime package                                                 |
| `packages/effect-codex-app-server` | Typed Codex app-server client/protocol package                                      |

## Prerequisites

- Bun `1.3.11`
- Node `24.13.1` or newer
- Codex CLI installed and available on `PATH`
- Codex authenticated before running T3 Code

Optional, depending on which workflows you use:

- other provider tooling for non-Codex providers
- `git` and `gh` for git/PR workflows
- `nix` and `deploy-rs` for flake and deployment workflows

Codex-specific setup notes live in [.docs/codex-prerequisites.md](./.docs/codex-prerequisites.md).

## Quick Start

Install dependencies:

```bash
bun install
```

Run the full web development stack:

```bash
bun run dev
```

Run the desktop app in development:

```bash
bun run dev:desktop
```

Build and run the production server:

```bash
bun run build
bun run start
```

## Nix Flake Usage

Enter the development shell:

```bash
nix develop
```

Run the packaged flake app:

```bash
nix run . -- --help
```

Start the server through the flake wrapper:

```bash
nix run . -- start
```

The `nix run` entrypoint bootstraps a cached workspace under
`${XDG_CACHE_HOME:-~/.cache}/t3code-flake`, installs Bun dependencies on first
run, builds the web and server bundles, and then executes the `t3` CLI from
that cache.

## Common Commands

```bash
# Full dev stack
bun run dev

# Individual surfaces
bun run dev:server
bun run dev:web
bun run dev:desktop
bun run dev:marketing

# Build
bun run build
bun run build:desktop

# Validation
bun run fmt
bun run lint
bun run typecheck
bun run test
```

More script notes live in [.docs/scripts.md](./.docs/scripts.md).

## CLI And Remote Use

The published CLI binary is `t3`.

Key commands:

- `t3 start` to run the local server and open the browser
- `t3 serve` to run headless and print pairing details for remote clients
- `t3 auth` to manage pairing links and bearer sessions
- `t3 project` to add, rename, or remove projects

Remote access, pairing, and network exposure are documented in [REMOTE.md](./REMOTE.md).

## Notes On Flake Workflows

This fork includes a substantial amount of Nix-flake-specific product surface. When a project is recognized as a flake, the UI and server can expose flake-aware views and workflows such as:

- flake dashboards
- host deployment views
- flake maintenance runs
- host creation and related project workflows

If you are looking at old upstream docs or screenshots, assume those are outdated for this repo.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. The project is still early and the bar for accepted changes is intentionally high.
