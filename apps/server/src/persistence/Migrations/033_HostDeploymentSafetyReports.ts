import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hostDeploymentColumns = yield* sql<{ name: string }>`
    PRAGMA table_info(host_deployments)
  `;

  if (!hostDeploymentColumns.some((column) => column.name === "activation_strategy")) {
    yield* sql`
      ALTER TABLE host_deployments
      ADD COLUMN activation_strategy TEXT NOT NULL DEFAULT 'switch'
    `;
  }

  if (!hostDeploymentColumns.some((column) => column.name === "preflight_report_json")) {
    yield* sql`
      ALTER TABLE host_deployments
      ADD COLUMN preflight_report_json TEXT
    `;
  }

  if (!hostDeploymentColumns.some((column) => column.name === "postflight_report_json")) {
    yield* sql`
      ALTER TABLE host_deployments
      ADD COLUMN postflight_report_json TEXT
    `;
  }

  const fleetDeploymentColumns = yield* sql<{ name: string }>`
    PRAGMA table_info(fleet_deployments)
  `;

  if (!fleetDeploymentColumns.some((column) => column.name === "activation_strategy")) {
    yield* sql`
      ALTER TABLE fleet_deployments
      ADD COLUMN activation_strategy TEXT NOT NULL DEFAULT 'switch'
    `;
  }

  const fleetHostColumns = yield* sql<{ name: string }>`
    PRAGMA table_info(fleet_deployment_hosts)
  `;

  if (!fleetHostColumns.some((column) => column.name === "preflight_report_json")) {
    yield* sql`
      ALTER TABLE fleet_deployment_hosts
      ADD COLUMN preflight_report_json TEXT
    `;
  }

  if (!fleetHostColumns.some((column) => column.name === "postflight_report_json")) {
    yield* sql`
      ALTER TABLE fleet_deployment_hosts
      ADD COLUMN postflight_report_json TEXT
    `;
  }
});
