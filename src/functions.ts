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
