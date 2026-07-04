// Arrow output schema + row→batch mapping for resourcegraph_query.
//
// SNAPSHOT archetype: there is NO cursor column and NO marker row (SPEC §4). Unlike
// the directory delta worker, nothing round-trips through the client, so the schema
// carries ONLY business columns — no _row_kind, no _delta_next, no _watermark_next.
//
// DEFAULT schema = a single Utf8 `result` column carrying each ARG row serialized as
// JSON (SPEC §4.1). objectArray is heterogeneous, so probe-and-widen is UNSOUND — a
// column absent from a single probe row would be permanently dropped from the bound
// schema. The single-JSON default is loss-free and replan-stable; the caller pulls
// fields with json_extract.

import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";

/** The default output column name (SPEC §4.1). */
export const RESULT_COL = "result";

/** The default single-Utf8-JSON schema — one `result` column, one JSON string per
 *  ARG resource row. Binds instantly (no probe) and is stable across replans. */
export const SINGLE_JSON_RESULT_SCHEMA: Schema = new Schema([new Field(RESULT_COL, new Utf8(), true)]);

/**
 * Build one Arrow batch from a page of ARG `data` rows. Each heterogeneous JSON
 * object becomes one row in the single `result` Utf8 column, serialized as JSON.
 * No marker row is appended — snapshot workers have no cursor to carry (SPEC §4).
 */
export function buildResultBatch(schema: Schema, rows: Record<string, unknown>[]) {
  const result: (string | null)[] = rows.map((r) => (r == null ? null : JSON.stringify(r)));
  return batchFromColumns({ [RESULT_COL]: result } as Record<string, unknown[]>, schema);
}
