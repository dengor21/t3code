import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS host_imports (
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      ssh_target TEXT NOT NULL,
      terminal_owner_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      findings_summary TEXT,
      exit_code INTEGER,
      exit_signal INTEGER,
      PRIMARY KEY (project_id, thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_host_imports_status
    ON host_imports (status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_host_imports_thread_id
    ON host_imports (thread_id)
  `;
});
