import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  FlakeMaintenanceLookup,
  FlakeMaintenanceRepository,
  type FlakeMaintenanceRepositoryShape,
  PersistedFlakeMaintenance,
} from "../Services/FlakeMaintenance.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeFlakeMaintenanceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertFlakeMaintenanceRow = SqlSchema.void({
    Request: PersistedFlakeMaintenance,
    execute: (row) =>
      sql`
        INSERT INTO flake_maintenance (
          project_id,
          terminal_owner_id,
          cwd,
          command,
          status,
          started_at,
          finished_at,
          updated_at,
          exit_code,
          exit_signal
        )
        VALUES (
          ${row.projectId},
          ${row.terminalOwnerId},
          ${row.cwd},
          ${row.command},
          ${row.status},
          ${row.startedAt},
          ${row.finishedAt},
          ${row.updatedAt},
          ${row.exitCode},
          ${row.exitSignal}
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
          terminal_owner_id = excluded.terminal_owner_id,
          cwd = excluded.cwd,
          command = excluded.command,
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at,
          exit_code = excluded.exit_code,
          exit_signal = excluded.exit_signal
      `,
  });

  const getFlakeMaintenanceRow = SqlSchema.findOneOption({
    Request: FlakeMaintenanceLookup,
    Result: PersistedFlakeMaintenance,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          command,
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM flake_maintenance
        WHERE project_id = ${projectId}
        LIMIT 1
      `,
  });

  const listActiveFlakeMaintenanceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PersistedFlakeMaintenance,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          command,
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM flake_maintenance
        WHERE status IN ('starting', 'running')
        ORDER BY updated_at ASC, project_id ASC
      `,
  });

  const upsert: FlakeMaintenanceRepositoryShape["upsert"] = (row) =>
    upsertFlakeMaintenanceRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FlakeMaintenanceRepository.upsert:query",
          "FlakeMaintenanceRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByProjectId: FlakeMaintenanceRepositoryShape["getByProjectId"] = (input) =>
    getFlakeMaintenanceRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FlakeMaintenanceRepository.getByProjectId:query",
          "FlakeMaintenanceRepository.getByProjectId:decodeRow",
        ),
      ),
    );

  const listActive: FlakeMaintenanceRepositoryShape["listActive"] = () =>
    listActiveFlakeMaintenanceRows(void 0).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "FlakeMaintenanceRepository.listActive:query",
          "FlakeMaintenanceRepository.listActive:decodeRows",
        ),
      ),
    );

  return {
    upsert,
    getByProjectId,
    listActive,
  } satisfies FlakeMaintenanceRepositoryShape;
});

export const FlakeMaintenanceRepositoryLive = Layer.effect(
  FlakeMaintenanceRepository,
  makeFlakeMaintenanceRepository,
);
