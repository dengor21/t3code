import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  HostDeploymentRepository,
  type HostDeploymentRepositoryShape,
  HostDeploymentLookup,
  ListHostDeploymentsByProjectIdInput,
  PersistedHostDeployment,
} from "../Services/HostDeployments.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeHostDeploymentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertHostDeploymentRow = SqlSchema.void({
    Request: PersistedHostDeployment,
    execute: (row) =>
      sql`
        INSERT INTO host_deployments (
          project_id,
          host_name,
          host_name_normalized,
          terminal_owner_id,
          cwd,
          command,
          deploy_on_server,
          status,
          started_at,
          finished_at,
          updated_at,
          exit_code,
          exit_signal
        )
        VALUES (
          ${row.projectId},
          ${row.hostName},
          ${row.hostNameNormalized},
          ${row.terminalOwnerId},
          ${row.cwd},
          ${row.command},
          ${row.deployOnServer ? 1 : 0},
          ${row.status},
          ${row.startedAt},
          ${row.finishedAt},
          ${row.updatedAt},
          ${row.exitCode},
          ${row.exitSignal}
        )
        ON CONFLICT (project_id, host_name_normalized)
        DO UPDATE SET
          host_name = excluded.host_name,
          terminal_owner_id = excluded.terminal_owner_id,
          cwd = excluded.cwd,
          command = excluded.command,
          deploy_on_server = excluded.deploy_on_server,
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at,
          exit_code = excluded.exit_code,
          exit_signal = excluded.exit_signal
      `,
  });

  const HostDeploymentDbRow = Schema.Struct({
    ...PersistedHostDeployment.fields,
    deployOnServer: Schema.Number,
  });

  const getHostDeploymentRow = SqlSchema.findOneOption({
    Request: HostDeploymentLookup,
    Result: HostDeploymentDbRow,
    execute: ({ projectId, hostNameNormalized }) =>
      sql`
        SELECT
          project_id AS "projectId",
          host_name AS "hostName",
          host_name_normalized AS "hostNameNormalized",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          command,
          deploy_on_server AS "deployOnServer",
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM host_deployments
        WHERE project_id = ${projectId}
          AND host_name_normalized = ${hostNameNormalized}
        LIMIT 1
      `,
  });

  const listHostDeploymentRowsByProjectId = SqlSchema.findAll({
    Request: ListHostDeploymentsByProjectIdInput,
    Result: HostDeploymentDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          host_name AS "hostName",
          host_name_normalized AS "hostNameNormalized",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          command,
          deploy_on_server AS "deployOnServer",
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM host_deployments
        WHERE project_id = ${projectId}
        ORDER BY host_name_normalized ASC
      `,
  });

  const listActiveHostDeploymentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: HostDeploymentDbRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          host_name AS "hostName",
          host_name_normalized AS "hostNameNormalized",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          command,
          deploy_on_server AS "deployOnServer",
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM host_deployments
        WHERE status IN ('starting', 'running')
        ORDER BY updated_at ASC, project_id ASC, host_name_normalized ASC
      `,
  });

  const upsert: HostDeploymentRepositoryShape["upsert"] = (row) =>
    upsertHostDeploymentRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostDeploymentRepository.upsert:query",
          "HostDeploymentRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByProjectAndHost: HostDeploymentRepositoryShape["getByProjectAndHost"] = (input) =>
    getHostDeploymentRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostDeploymentRepository.getByProjectAndHost:query",
          "HostDeploymentRepository.getByProjectAndHost:decodeRow",
        ),
      ),
      Effect.map(
        Option.map(
          (row): PersistedHostDeployment => ({
            ...row,
            deployOnServer: row.deployOnServer === 1,
          }),
        ),
      ),
    );

  const listByProjectId: HostDeploymentRepositoryShape["listByProjectId"] = (input) =>
    listHostDeploymentRowsByProjectId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostDeploymentRepository.listByProjectId:query",
          "HostDeploymentRepository.listByProjectId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map(
          (row): PersistedHostDeployment => ({
            ...row,
            deployOnServer: row.deployOnServer === 1,
          }),
        ),
      ),
    );

  const listActive: HostDeploymentRepositoryShape["listActive"] = () =>
    listActiveHostDeploymentRows(void 0).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostDeploymentRepository.listActive:query",
          "HostDeploymentRepository.listActive:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map(
          (row): PersistedHostDeployment => ({
            ...row,
            deployOnServer: row.deployOnServer === 1,
          }),
        ),
      ),
    );

  return {
    upsert,
    getByProjectAndHost,
    listByProjectId,
    listActive,
  } satisfies HostDeploymentRepositoryShape;
});

export const HostDeploymentRepositoryLive = Layer.effect(
  HostDeploymentRepository,
  makeHostDeploymentRepository,
);
