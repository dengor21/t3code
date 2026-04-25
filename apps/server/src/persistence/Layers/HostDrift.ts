import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { HostDriftCategoryResult } from "@t3tools/contracts";

import {
  HostDriftLookup,
  HostDriftRepository,
  type HostDriftRepositoryShape,
  ListHostDriftByProjectIdInput,
  PersistedHostDrift,
} from "../Services/HostDrift.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeHostDriftRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertHostDriftRow = SqlSchema.void({
    Request: PersistedHostDrift,
    execute: (row) =>
      sql`
        INSERT INTO host_drift_runs (
          project_id,
          host_name,
          host_name_normalized,
          terminal_owner_id,
          cwd,
          status,
          started_at,
          finished_at,
          updated_at,
          last_error,
          awaiting_auth_phase,
          exit_code,
          exit_signal
        )
        VALUES (
          ${row.projectId},
          ${row.hostName},
          ${row.hostNameNormalized},
          ${row.terminalOwnerId},
          ${row.cwd},
          ${row.status},
          ${row.startedAt},
          ${row.finishedAt},
          ${row.updatedAt},
          ${row.lastError},
          ${row.awaitingAuthPhase},
          ${row.exitCode},
          ${row.exitSignal}
        )
        ON CONFLICT (project_id, host_name_normalized)
        DO UPDATE SET
          host_name = excluded.host_name,
          terminal_owner_id = excluded.terminal_owner_id,
          cwd = excluded.cwd,
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          updated_at = excluded.updated_at,
          last_error = excluded.last_error,
          awaiting_auth_phase = excluded.awaiting_auth_phase,
          exit_code = excluded.exit_code,
          exit_signal = excluded.exit_signal
      `,
  });

  const HostDriftRunDbRow = Schema.Struct({
    projectId: PersistedHostDrift.fields.projectId,
    hostName: PersistedHostDrift.fields.hostName,
    hostNameNormalized: PersistedHostDrift.fields.hostNameNormalized,
    terminalOwnerId: PersistedHostDrift.fields.terminalOwnerId,
    cwd: PersistedHostDrift.fields.cwd,
    status: PersistedHostDrift.fields.status,
    startedAt: PersistedHostDrift.fields.startedAt,
    finishedAt: PersistedHostDrift.fields.finishedAt,
    updatedAt: PersistedHostDrift.fields.updatedAt,
    lastError: PersistedHostDrift.fields.lastError,
    awaitingAuthPhase: PersistedHostDrift.fields.awaitingAuthPhase,
    exitCode: PersistedHostDrift.fields.exitCode,
    exitSignal: PersistedHostDrift.fields.exitSignal,
  });

  const HostDriftCategoryResultDbRow = HostDriftCategoryResult.mapFields(
    Struct.assign({
      desiredValue: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
      observedValue: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    }),
  );

  const listCategoryResultRowsByProjectAndHost = SqlSchema.findAll({
    Request: HostDriftLookup,
    Result: HostDriftCategoryResultDbRow,
    execute: ({ projectId, hostNameNormalized }) =>
      sql`
        SELECT
          category,
          status,
          summary,
          detail,
          desired_value_json AS "desiredValue",
          observed_value_json AS "observedValue",
          updated_at AS "updatedAt"
        FROM host_drift_results
        WHERE project_id = ${projectId}
          AND host_name_normalized = ${hostNameNormalized}
        ORDER BY category ASC
      `,
  });

  const getHostDriftRunRow = SqlSchema.findOneOption({
    Request: HostDriftLookup,
    Result: HostDriftRunDbRow,
    execute: ({ projectId, hostNameNormalized }) =>
      sql`
        SELECT
          project_id AS "projectId",
          host_name AS "hostName",
          host_name_normalized AS "hostNameNormalized",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          last_error AS "lastError",
          awaiting_auth_phase AS "awaitingAuthPhase",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM host_drift_runs
        WHERE project_id = ${projectId}
          AND host_name_normalized = ${hostNameNormalized}
        LIMIT 1
      `,
  });

  const listHostDriftRunRowsByProjectId = SqlSchema.findAll({
    Request: ListHostDriftByProjectIdInput,
    Result: HostDriftRunDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          host_name AS "hostName",
          host_name_normalized AS "hostNameNormalized",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          last_error AS "lastError",
          awaiting_auth_phase AS "awaitingAuthPhase",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM host_drift_runs
        WHERE project_id = ${projectId}
        ORDER BY host_name_normalized ASC
      `,
  });

  const listActiveHostDriftRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: HostDriftRunDbRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          host_name AS "hostName",
          host_name_normalized AS "hostNameNormalized",
          terminal_owner_id AS "terminalOwnerId",
          cwd,
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt",
          last_error AS "lastError",
          awaiting_auth_phase AS "awaitingAuthPhase",
          exit_code AS "exitCode",
          exit_signal AS "exitSignal"
        FROM host_drift_runs
        WHERE status IN ('starting', 'running')
        ORDER BY updated_at ASC, project_id ASC, host_name_normalized ASC
      `,
  });

  const deleteCategoryResultRows = (input: HostDriftLookup) =>
    sql`
      DELETE FROM host_drift_results
      WHERE project_id = ${input.projectId}
        AND host_name_normalized = ${input.hostNameNormalized}
    `;

  const insertCategoryResultRow = (input: {
    readonly projectId: string;
    readonly hostNameNormalized: string;
    readonly row: HostDriftCategoryResult;
  }) =>
    sql`
      INSERT INTO host_drift_results (
        project_id,
        host_name_normalized,
        category,
        status,
        summary,
        detail,
        desired_value_json,
        observed_value_json,
        updated_at
      )
      VALUES (
        ${input.projectId},
        ${input.hostNameNormalized},
        ${input.row.category},
        ${input.row.status},
        ${input.row.summary},
        ${input.row.detail},
        ${input.row.desiredValue === null ? null : JSON.stringify(input.row.desiredValue)},
        ${input.row.observedValue === null ? null : JSON.stringify(input.row.observedValue)},
        ${input.row.updatedAt}
      )
    `;

  const attachCategoryResults = (row: typeof HostDriftRunDbRow.Type) =>
    listCategoryResultRowsByProjectAndHost({
      projectId: row.projectId,
      hostNameNormalized: row.hostNameNormalized,
    }).pipe(
      Effect.map(
        (categoryResults) =>
          ({
            ...row,
            categoryResults,
          }) satisfies PersistedHostDrift,
      ),
    );

  const upsert: HostDriftRepositoryShape["upsert"] = (row) =>
    upsertHostDriftRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostDriftRepository.upsert:query",
          "HostDriftRepository.upsert:encodeRequest",
        ),
      ),
    );

  const replaceCategoryResults: HostDriftRepositoryShape["replaceCategoryResults"] = (input) =>
    sql
      .withTransaction(
        deleteCategoryResultRows(input).pipe(
          Effect.flatMap(() =>
            Effect.forEach(
              input.categoryResults,
              (row) =>
                insertCategoryResultRow({
                  projectId: input.projectId,
                  hostNameNormalized: input.hostNameNormalized,
                  row,
                }),
              { discard: true },
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "HostDriftRepository.replaceCategoryResults:query",
            "HostDriftRepository.replaceCategoryResults:encodeRequest",
          ),
        ),
      );

  const getByProjectAndHost: HostDriftRepositoryShape["getByProjectAndHost"] = (input) =>
    getHostDriftRunRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostDriftRepository.getByProjectAndHost:query",
          "HostDriftRepository.getByProjectAndHost:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) =>
            attachCategoryResults(value).pipe(
              Effect.map(Option.some),
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "HostDriftRepository.getByProjectAndHost:categoryResults",
                  "HostDriftRepository.getByProjectAndHost:decodeCategoryRows",
                ),
              ),
            ),
        }),
      ),
    );

  const listByProjectId: HostDriftRepositoryShape["listByProjectId"] = (input) =>
    listHostDriftRunRowsByProjectId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostDriftRepository.listByProjectId:query",
          "HostDriftRepository.listByProjectId:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          attachCategoryResults(row).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "HostDriftRepository.listByProjectId:categoryResults",
                "HostDriftRepository.listByProjectId:decodeCategoryRows",
              ),
            ),
          ),
        ),
      ),
    );

  const listActive: HostDriftRepositoryShape["listActive"] = () =>
    listActiveHostDriftRows(void 0).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HostDriftRepository.listActive:query",
          "HostDriftRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          attachCategoryResults(row).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "HostDriftRepository.listActive:categoryResults",
                "HostDriftRepository.listActive:decodeCategoryRows",
              ),
            ),
          ),
        ),
      ),
    );

  return {
    upsert,
    replaceCategoryResults,
    getByProjectAndHost,
    listByProjectId,
    listActive,
  } satisfies HostDriftRepositoryShape;
});

export const HostDriftRepositoryLive = Layer.effect(HostDriftRepository, makeHostDriftRepository);
