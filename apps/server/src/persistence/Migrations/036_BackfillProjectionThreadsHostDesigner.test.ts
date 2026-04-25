import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_BackfillProjectionThreadsHostDesigner", (it) => {
  it.effect("backfills and normalizes projection thread designers from scoped host name", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          designer_json,
          scoped_host_name,
          workflow_json,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          change_baseline_head_sha,
          last_commit_sha,
          last_commit_subject,
          last_commit_recorded_at,
          last_commit_source,
          change_state,
          deleted_at
        )
        VALUES
          (
            'thread-1',
            'project-1',
            'Thread 1',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            'nexus',
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            'ongoing',
            NULL
          ),
          (
            'thread-2',
            'project-1',
            'Thread 2',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            '{"kind":"host","hostName":"router"}',
            'nexus',
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            'ongoing',
            NULL
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly designer: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          designer_json AS "designer"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-1",
          designer: '{"kind":"host","hostName":"nexus"}',
        },
        {
          threadId: "thread-2",
          designer: '{"kind":"host","hostName":"nexus"}',
        },
      ]);
    }),
  );
});
