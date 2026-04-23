default:
  @just --list

set shell := ["zsh", "-cu"]

# Build the web app so the server can serve it directly as a same-origin remote UI.
remote-build-web:
  cd apps/web && \
  bun run build

# Recommended remote flow: same-origin app served by the T3 server itself.
# Uses the default runtime home unless T3CODE_HOME is set in the caller's shell.
remote-server host port="13773":
  cd apps/server && \
  bun src/bin.ts serve \
    --host "{{host}}" \
    --port "{{port}}"

# Split frontend/backend dev flow. Useful for UI work, but not the preferred
# setup for testing remote pairing/auth across devices.
remote-server-dev host port="13773" web_port="5733":
  cd apps/server && \
  bun src/bin.ts serve \
    --host "{{host}}" \
    --port "{{port}}" \
    --dev-url "http://{{host}}:{{web_port}}"

remote-web host port="13773" web_port="5733":
  cd apps/web && \
  VITE_HTTP_URL="http://{{host}}:{{port}}" \
  VITE_WS_URL="ws://{{host}}:{{port}}" \
  bun run dev -- --host 0.0.0.0 --port "{{web_port}}"

remote-pairing-create host port="13773":
  cd apps/server && \
  bun src/bin.ts auth pairing create \
    --base-url "http://{{host}}:{{port}}"

remote-pairing-create-json host port="13773":
  cd apps/server && \
  bun src/bin.ts auth pairing create \
    --base-url "http://{{host}}:{{port}}" \
    --json

remote-pairing-list:
  cd apps/server && \
  bun src/bin.ts auth pairing list

remote-pairing-list-json:
  cd apps/server && \
  bun src/bin.ts auth pairing list --json

remote-pairing-revoke id:
  cd apps/server && \
  bun src/bin.ts auth pairing revoke "{{id}}"
