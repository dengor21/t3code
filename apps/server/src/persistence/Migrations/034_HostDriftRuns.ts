import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS host_drift_runs (
      project_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      host_name_normalized TEXT NOT NULL,
      terminal_owner_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      awaiting_auth_phase TEXT,
      exit_code INTEGER,
      exit_signal INTEGER,
      PRIMARY KEY (project_id, host_name_normalized)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_host_drift_runs_status
    ON host_drift_runs (status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_host_drift_runs_project_id
    ON host_drift_runs (project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS host_drift_results (
      project_id TEXT NOT NULL,
      host_name_normalized TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      desired_value_json TEXT,
      observed_value_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, host_name_normalized, category)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_host_drift_results_project_host
    ON host_drift_results (project_id, host_name_normalized)
  `;
});
