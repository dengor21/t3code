import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS host_deployments (
      project_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      host_name_normalized TEXT NOT NULL,
      terminal_owner_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      command TEXT NOT NULL,
      deploy_on_server INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      exit_code INTEGER,
      exit_signal INTEGER,
      PRIMARY KEY (project_id, host_name_normalized)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_host_deployments_project_id
    ON host_deployments (project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_host_deployments_status
    ON host_deployments (status)
  `;
});
