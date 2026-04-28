import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "remote_host_access_policy")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN remote_host_access_policy TEXT NOT NULL DEFAULT 'hal-managed-only'
    `;
  }
});
