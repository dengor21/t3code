import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS flake_maintenance (
      project_id TEXT NOT NULL PRIMARY KEY,
      terminal_owner_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      exit_code INTEGER,
      exit_signal INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_flake_maintenance_status
    ON flake_maintenance (status)
  `;
});
