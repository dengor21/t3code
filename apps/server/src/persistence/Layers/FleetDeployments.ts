import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  FleetDeploymentHostLookup,
  FleetDeploymentLookup,
  FleetDeploymentRepository,
  type FleetDeploymentRepositoryShape,
  PersistedFleetDeployment,
  PersistedFleetDeploymentHost,
} from "../Services/FleetDeployments.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeFleetDeploymentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertFleetDeploymentRow = SqlSchema.void({
    Request: PersistedFleetDeployment,
    execute: (row) =>
      sql`
        INSERT INTO fleet_deployments (
          rollout_id,
          project_id,
          status,
          max_parallelism,
          stop_on_first_failure,
          deploy_on_server,
          magic_rollback,
          confirm_timeout_seconds,
          started_at,
          finished_at,
          updated_at,
          last_error
        )
        VALUES (
          ${row.rolloutId},
          ${row.projectId},
          ${row.status},
          ${row.maxParallelism},
          ${row.stopOnFirstFailure ? 1 : 0},
          ${row.deployOnServer ? 1 : 0},
          ${row.magicRollback === null ? null : row.magicRollback ? 1 : 0},
          ${row.confirmTimeoutSeconds},
          ${row.startedAt},
          ${row.finishedAt},
          ${row.updatedAt},
          ${row.lastError}
        )
        ON CONFLICT (rollout_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          status = excluded.status,
          max_parallelism = excluded.max_parallelism,
          stop_on_first_failure = excluded.stop_on_first_failure,
          deploy_on_server = excluded.deploy_on_server,
          magic_rollback = excluded.magic_rollback,
          confirm_timeout_seconds = excluded.confirm_timeout_seconds,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at,
          last_error = excluded.last_error
      `,
  });

  const upsertFleetDeploymentHostRow = SqlSchema.void({
    Request: PersistedFleetDeploymentHost,
    execute: (row) =>
      sql`
        INSERT INTO fleet_deployment_hosts (
          rollout_id,
          host_name,
          host_name_normalized,
          host_order,
          status,
          terminal_owner_id,
          started_at,
          finished_at,
          updated_at,
          exit_code,
          exit_signal
        )
        VALUES (
          ${row.rolloutId},
          ${row.hostName},
          ${row.hostNameNormalized},
          ${row.order},
          ${row.status},
          ${row.terminalOwnerId},
          ${row.startedAt},
          ${row.finishedAt},
          ${row.updatedAt},
          ${row.exitCode},
          ${row.exitSignal}
        )
        ON CONFLICT (rollout_id, host_name_normalized)
        DO UPDATE SET
          host_name = excluded.host_name,
          host_order = excluded.host_order,
          status = excluded.status,
          terminal_owner_id = excluded.terminal_owner_id,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at,
          exit_code = excluded.exit_code,
          exit_signal = excluded.exit_signal
      `,
  });

  const FleetDeploymentDbRow = Schema.Struct({
    ...PersistedFleetDeployment.fields,
    stopOnFirstFailure: Schema.Number,
    deployOnServer: Schema.Number,
    magicRollback: Schema.NullOr(Schema.Number),
  });

  const getLatestFleetDeploymentRow = SqlSchema.findOneOption({
    Request: FleetDeploymentLookup,
    Result: FleetDeploymentDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          rollout_id AS "rolloutId",
          project_id AS "projectId",
          status,
          max_parallelism AS "maxParallelism",
          stop_on_first_failure AS "stopOnFirstFailure",
          deploy_on_server AS "deployOnServer",
          magic_rollback AS "magicRollback",
          confirm_timeout_seconds AS "confirmTimeoutSeconds",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          last_error AS "lastError"
        FROM fleet_deployments
        WHERE project_id = ${projectId}
        ORDER BY started_at DESC, rollout_id DESC
        LIMIT 1
      `,
  });

  const FleetDeploymentHostDbRow = Schema.Struct({
    ...PersistedFleetDeploymentHost.fields,
  });

  const listFleetDeploymentHostRows = SqlSchema.findAll({
    Request: FleetDeploymentHostLookup,
    Result: FleetDeploymentHostDbRow,
    execute: ({ rolloutId }) =>
      sql`
        SELECT
          rollout_id AS "rolloutId",
          host_name AS "hostName",
          host_name_normalized AS "hostNameNormalized",
          host_order AS "order",
          status,
          terminal_owner_id AS "terminalOwnerId",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM fleet_deployment_hosts
        WHERE rollout_id = ${rolloutId}
        ORDER BY host_order ASC, host_name_normalized ASC
      `,
  });

  const listActiveFleetDeploymentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: FleetDeploymentDbRow,
    execute: () =>
      sql`
        SELECT
          rollout_id AS "rolloutId",
          project_id AS "projectId",
          status,
          max_parallelism AS "maxParallelism",
          stop_on_first_failure AS "stopOnFirstFailure",
          deploy_on_server AS "deployOnServer",
          magic_rollback AS "magicRollback",
          confirm_timeout_seconds AS "confirmTimeoutSeconds",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          last_error AS "lastError"
        FROM fleet_deployments
        WHERE status IN ('starting', 'running')
        ORDER BY updated_at ASC, project_id ASC, rollout_id ASC
      `,
  });

  const mapRolloutRow = (row: typeof FleetDeploymentDbRow.Type): PersistedFleetDeployment => ({
    ...row,
    stopOnFirstFailure: row.stopOnFirstFailure === 1,
    deployOnServer: row.deployOnServer === 1,
    magicRollback: row.magicRollback === null ? null : row.magicRollback === 1 ? true : false,
  });

  const upsertRollout: FleetDeploymentRepositoryShape["upsertRollout"] = (row) =>
    upsertFleetDeploymentRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FleetDeploymentRepository.upsertRollout:query",
          "FleetDeploymentRepository.upsertRollout:encodeRequest",
        ),
      ),
    );

  const upsertHostEntry: FleetDeploymentRepositoryShape["upsertHostEntry"] = (row) =>
    upsertFleetDeploymentHostRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FleetDeploymentRepository.upsertHostEntry:query",
          "FleetDeploymentRepository.upsertHostEntry:encodeRequest",
        ),
      ),
    );

  const getLatestByProjectId: FleetDeploymentRepositoryShape["getLatestByProjectId"] = (input) =>
    getLatestFleetDeploymentRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FleetDeploymentRepository.getLatestByProjectId:query",
          "FleetDeploymentRepository.getLatestByProjectId:decodeRow",
        ),
      ),
      Effect.map(Option.map(mapRolloutRow)),
    );

  const listHostEntriesByRolloutId: FleetDeploymentRepositoryShape["listHostEntriesByRolloutId"] = (
    input,
  ) =>
    listFleetDeploymentHostRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FleetDeploymentRepository.listHostEntriesByRolloutId:query",
          "FleetDeploymentRepository.listHostEntriesByRolloutId:decodeRows",
        ),
      ),
    );

  const listActive: FleetDeploymentRepositoryShape["listActive"] = () =>
    listActiveFleetDeploymentRows(void 0).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FleetDeploymentRepository.listActive:query",
          "FleetDeploymentRepository.listActive:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(mapRolloutRow)),
    );

  return {
    upsertRollout,
    upsertHostEntry,
    getLatestByProjectId,
    listHostEntriesByRolloutId,
    listActive,
  } satisfies FleetDeploymentRepositoryShape;
});

export const FleetDeploymentRepositoryLive = Layer.effect(
  FleetDeploymentRepository,
  makeFleetDeploymentRepository,
);
