import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_deployments (
      rollout_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      max_parallelism INTEGER NOT NULL,
      stop_on_first_failure INTEGER NOT NULL DEFAULT 1,
      deploy_on_server INTEGER NOT NULL DEFAULT 0,
      magic_rollback INTEGER,
      confirm_timeout_seconds INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      PRIMARY KEY (rollout_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fleet_deployments_project_id
    ON fleet_deployments (project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fleet_deployments_status
    ON fleet_deployments (status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_deployment_hosts (
      rollout_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      host_name_normalized TEXT NOT NULL,
      host_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      terminal_owner_id TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      exit_code INTEGER,
      exit_signal INTEGER,
      PRIMARY KEY (rollout_id, host_name_normalized)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fleet_deployment_hosts_rollout_id
    ON fleet_deployment_hosts (rollout_id)
  `;
});
