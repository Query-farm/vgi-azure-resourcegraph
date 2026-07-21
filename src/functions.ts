// The VGI table function: resourcegraph_query. One KQL query over the ARM estate,
// paginated by an in-scan-only $skipToken (SPEC §4). The GraphClient is injected via
// a ClientFactory so the worker wires the real MSAL/ARM-audience client and tests
// inject a fake.
//
// SNAPSHOT archetype (the inverse of directory's delta cursor):
//   - resourcegraph_query IS a table function, so name:=value works on its optional
//     args (subscriptions, page_size) — they live in argDefaults (SPEC conformance).
//   - State is fully serializable: frozen query identity (kql + subscriptions array +
//     top), the opaque skipToken string, a page counter, and a done flag. No Date,
//     no RecordBatch, no live socket, no cross-scan cursor.
//   - The $skipToken paginates ONE snapshot only; it never becomes an output column
//     and never crosses scans. There is NO marker row and NO watermark (SPEC §2/§4).

import { defineTableFunction, secretsOfType, type OutputCollector } from "@query-farm/vgi";
import { Utf8, Int64 } from "@query-farm/apache-arrow";
import {
  fetchPage,
  splitSubscriptions,
  clampTop,
  wouldExceedEdgeBudget,
  EstateTooLargeForEdge,
  type QueryIdentity,
} from "./resource-graph.js";
import { SINGLE_JSON_RESULT_SCHEMA, buildResultBatch } from "./schema.js";
import type { GraphClient } from "@vgi-azure/graph-core";

export type ClientFactory = (secret: Record<string, unknown>) => GraphClient;

// Shown examples for resourcegraph_query. Shared verbatim by the native `examples`
// field (SQL-only — DuckDB's duckdb_functions().examples carrier drops descriptions)
// and the `vgi.example_queries` tag (which preserves the description, VGI515). Keep
// them byte-identical so both surfaces agree.
const RESOURCEGRAPH_EXAMPLES = [
  {
    sql: "SELECT result FROM azure.main.resourcegraph_query('Resources | project name, type, location') LIMIT 100",
    description: "First 100 resources as JSON, projecting name, type, and location",
  },
  {
    sql: "SELECT result ->> 'type' AS type, count(*) AS n FROM azure.main.resourcegraph_query('Resources | project type') GROUP BY 1 ORDER BY n DESC",
    description: "Count resources by type across the whole estate",
  },
  {
    sql: "SELECT result ->> 'name' AS name, result ->> 'resourceGroup' AS resource_group FROM azure.main.resourcegraph_query('Resources | where type =~ ''microsoft.storage/storageaccounts'' | project name, resourceGroup') ORDER BY name",
    description: "List storage account names alongside their resource group",
  },
  {
    sql: "SELECT result FROM azure.main.resourcegraph_query('Resources | project name, location', subscriptions := '00000000-0000-0000-0000-000000000000', page_size := 500)",
    description: "Scope the query to one subscription GUID with a 500-resource page size",
  },
];

export interface Args {
  /** KQL query, e.g. 'Resources | project name, location'. Required (positional). */
  kql: string;
  /** Comma-separated subscription GUIDs; ""/NULL → every subscription the principal
   *  can read (ARG scopes by RBAC). Named (name:=value). */
  subscriptions: string;
  /** options.$top — ARG page size, default & max 1000. Named (name:=value). */
  page_size: number;
}

/** Fully serializable in-scan state (SPEC §4). `skipToken` is in-scan ONLY. */
export interface State {
  /** Frozen query identity, reused verbatim on every continuation page (SPEC §2). */
  query: QueryIdentity;
  /** Opaque ARG continuation token for the NEXT page; null on the first page. */
  skipToken: string | null;
  /** Pages fetched so far — the edge subrequest-budget guard (SPEC §6.1). */
  pages: number;
  /** Snapshot exhausted → next process() call finishes. */
  done: boolean;
}

/**
 * Build the resourcegraph_query table function.
 *
 * `isEdge` selects the runtime profile for the edge-budget guard: on the Cloudflare
 * edge (true) the walk fails loud with EstateTooLargeForEdge before breaching the
 * subrequest budget; on Node/Bun (false, the default) the guard is a no-op (SPEC §6.1).
 */
export function makeResourceGraphFunction(clientFactory: ClientFactory, isEdge = false) {
  const schema = SINGLE_JSON_RESULT_SCHEMA;
  return defineTableFunction<Args, State>({
    name: "resourcegraph_query",
    description:
      "Azure Resource Graph: one KQL query over the ARM estate, returned as one JSON `result` row per resource. " +
      "Point-in-time snapshot paginated by an in-scan $skipToken — no cross-scan cursor, no change tracking.",
    args: { kql: new Utf8(), subscriptions: new Utf8(), page_size: new Int64() },
    // Optional args in argDefaults so they are NAMED (subscriptions:=, page_size:=);
    // kql has no default so it stays positional & required.
    argDefaults: { subscriptions: "", page_size: 1000 },
    argDocs: {
      kql:
        "The Azure Resource Graph KQL (Kusto Query Language) query to run, e.g. " +
        "`'Resources | project name, type, location'`. Required (positional). The query runs across " +
        "the ARM estate and each returned resource becomes one JSON `result` row.",
      subscriptions:
        "Comma-separated Azure subscription GUIDs to scope the query to, e.g. `'<guid1>,<guid2>'`. " +
        "Empty (the default) or NULL queries every subscription the service principal can read (ARG " +
        "scopes by RBAC). Named (subscriptions := '...').",
      page_size:
        "ARG page size (options.$top) — how many resources ARG returns per internal page. Defaults to " +
        "1000, which is also the maximum; larger values are clamped. Paging is transparent (the whole " +
        "snapshot is returned regardless). Named (page_size := 500).",
    },
    examples: RESOURCEGRAPH_EXAMPLES,
    tags: {
      "vgi.category": "resource-inventory",
      "vgi.title": "Azure Resource Graph Query",
      "vgi.keywords": JSON.stringify([
        "azure",
        "resource graph",
        "arg",
        "kql",
        "kusto",
        "inventory",
        "resources",
        "arm",
        "subscriptions",
        "snapshot",
      ]),
      "vgi.doc_llm":
        "Run one Azure Resource Graph (ARG) KQL query across the ARM estate and return one JSON `result` " +
        "row per matching resource. The kql argument is required and positional; optionally pass " +
        "subscriptions (comma-separated GUIDs; empty = every readable subscription) and page_size (ARG " +
        "$top, default & max 1000). This is a point-in-time snapshot: each scan re-runs the query fresh, " +
        "there is no cursor and no marker row. Extract fields from each JSON string with json_extract or " +
        "the -> / ->> operators. Requires an app-only 'azure_graph' secret with Reader on the target subscriptions.",
      "vgi.doc_md":
        "## resourcegraph_query\n\n" +
        "Run one Azure Resource Graph KQL query over the ARM estate; each matching resource comes back " +
        "as one JSON string in the `result` column. It is a point-in-time snapshot — no incremental " +
        "cursor, no marker row. Pull fields out of each JSON string with `json_extract(result, '$.name')` " +
        "or the `->>` operator (e.g. `result ->> 'type'`, `result ->> 'location'`).\n\n" +
        "The single positional argument is the KQL query string; optional named arguments scope the " +
        "scan to specific subscription GUIDs (`subscriptions :=`) and tune the ARG page size " +
        "(`page_size :=`, default and max 1000). Runnable, catalog-qualified queries live in this " +
        "object's `examples` and the schema's `vgi.example_queries`; browse `azure.main.kql_recipes` " +
        "for a credential-free menu of ready-to-paste KQL.",
      // Mirror of the native `examples` field WITH descriptions preserved (VGI515):
      // duckdb_functions().examples carries the SQL only, so the described JSON lives here.
      "vgi.example_queries": JSON.stringify(RESOURCEGRAPH_EXAMPLES),
      "vgi.result_columns_schema": JSON.stringify([
        {
          name: "result",
          type: "VARCHAR",
          description:
            "One matching Azure Resource Graph resource serialized as a JSON object string. Extract fields with json_extract(result, '$.<field>') or the -> / ->> operators (e.g. result ->> 'name'). The available JSON fields are whatever the KQL query projects. There is no marker/cursor row — every row is a resource.",
        },
      ]),
    },
    // DEFAULT path: single Utf8 JSON `result` column — no probe, sound for
    // heterogeneous objectArray, replan-stable (SPEC §4.1).
    onBind: () => ({ outputSchema: schema }),
    initialState: (p): State => ({
      query: {
        kql: p.args.kql,
        subscriptions: splitSubscriptions(p.args.subscriptions),
        top: clampTop(p.args.page_size),
      },
      skipToken: null, // in-scan ONLY — never crosses scans
      pages: 0,
      done: false,
    }),
    process: async (p, state: State, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      // Hard edge-budget guard: fail loud BEFORE issuing a page that would breach
      // the subrequest budget (SPEC §6.1). No-op on Node/Bun.
      if (wouldExceedEdgeBudget(state.pages, isEdge)) {
        throw new EstateTooLargeForEdge(state.pages, state.query.subscriptions);
      }
      const secret = secretsOfType(p.secrets, "azure_graph")[0];
      if (!secret) {
        throw new Error("resourcegraph_query: attach an 'azure_graph' secret (TYPE azure_graph)");
      }
      const client = clientFactory(secret as Record<string, unknown>);

      // Re-POST the SAME body shape every page; only options.$skipToken advances
      // (snapshot-consistency contract, SPEC §2).
      const page = await fetchPage(client, state.query, state.skipToken);
      state.pages++;
      out.emit(buildResultBatch(schema, page.data));

      if (page.skipToken) {
        state.skipToken = page.skipToken; // page again next process() call
        return;
      }
      state.done = true; // snapshot exhausted → next call finishes
    },
  });
}
