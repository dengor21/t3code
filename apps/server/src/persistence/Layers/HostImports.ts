import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import {
  HostImportLookup,
  HostImportRepository,
  type HostImportRepositoryShape,
  PersistedHostImport,
} from "../Services/HostImports.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeHostImportRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertHostImportRow = SqlSchema.void({
    Request: PersistedHostImport,
    execute: (row) =>
      sql`
        INSERT INTO host_imports (
          project_id,
          thread_id,
          host_name,
          ssh_target,
          terminal_owner_id,
          cwd,
          status,
          started_at,
          finished_at,
          updated_at,
          last_error,
          findings_summary,
          exit_code,
          exit_signal
        )
        VALUES (
          ${row.projectId},
          ${row.threadId},
          ${row.hostName},
          ${row.sshTarget},
          ${row.terminalOwnerId},
          ${row.cwd},
          ${row.status},
          ${row.startedAt},
          ${row.finishedAt},
          ${row.updatedAt},
          ${row.lastError},
          ${row.findingsSummary},
          ${row.exitCode},
          ${row.exitSignal}
        )
        ON CONFLICT (project_id, thread_id)
        DO UPDATE SET
          host_name = excluded.host_name,
          ssh_target = excluded.ssh_target,
          terminal_owner_id = excluded.terminal_owner_id,
          cwd = excluded.cwd,
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at,
          last_error = excluded.last_error,
          findings_summary = excluded.findings_summary,
          exit_code = excluded.exit_code,
          exit_signal = excluded.exit_signal
      `,
  });

  const getHostImportRow = SqlSchema.findOneOption({
    Request: HostImportLookup,
    Result: PersistedHostImport,
    execute: ({ projectId, threadId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          thread_id AS "threadId",
          host_name AS "hostName",
          ssh_target AS "sshTarget",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          last_error AS "lastError",
          findings_summary AS "findingsSummary",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM host_imports
        WHERE project_id = ${projectId}
          AND thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const listActiveHostImportRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PersistedHostImport,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          thread_id AS "threadId",
          host_name AS "hostName",
          ssh_target AS "sshTarget",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          last_error AS "lastError",
          findings_summary AS "findingsSummary",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM host_imports
        WHERE status IN ('starting', 'running')
        ORDER BY updated_at ASC, project_id ASC, thread_id ASC
      `,
  });

  const upsert: HostImportRepositoryShape["upsert"] = (row) =>
    upsertHostImportRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostImportRepository.upsert:query",
          "HostImportRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByProjectAndThread: HostImportRepositoryShape["getByProjectAndThread"] = (input) =>
    getHostImportRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostImportRepository.getByProjectAndThread:query",
          "HostImportRepository.getByProjectAndThread:decodeRow",
        ),
      ),
    );

  const listActive: HostImportRepositoryShape["listActive"] = () =>
    listActiveHostImportRows(void 0).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostImportRepository.listActive:query",
          "HostImportRepository.listActive:decodeRows",
        ),
      ),
    );

  return {
    upsert,
    getByProjectAndThread,
    listActive,
  } satisfies HostImportRepositoryShape;
});

export const HostImportRepositoryLive = Layer.effect(
  HostImportRepository,
  makeHostImportRepository,
);
