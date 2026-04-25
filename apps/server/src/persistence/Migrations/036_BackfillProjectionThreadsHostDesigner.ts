import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET designer_json = json_object(
      'kind',
      'host',
      'hostName',
      trim(scoped_host_name)
    )
    WHERE scoped_host_name IS NOT NULL
      AND trim(scoped_host_name) <> ''
      AND (
        designer_json IS NULL
        OR json_extract(designer_json, '$.kind') <> 'host'
        OR lower(trim(json_extract(designer_json, '$.hostName'))) <> lower(trim(scoped_host_name))
      )
  `;
});
