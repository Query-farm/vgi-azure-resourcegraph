// vgi-azure-resourcegraph stdio worker entry. DuckDB spawns this and ATTACHes it:
//   ATTACH 'arg' AS arg (TYPE vgi, LOCATION '/path/to/worker.ts');
//   CREATE SECRET a (TYPE azure_graph, TENANT_ID '…', CLIENT_ID '…', CLIENT_SECRET '…');
//   SELECT * FROM arg.resourcegraph_query(kql := 'Resources | project name, location');
//   SELECT * FROM arg.resourcegraph_query(
//     kql := 'Resources | project name', subscriptions := '<guid1>,<guid2>', page_size := 500);
//
// AUDIENCE = arm: ARG lives on the ARM control plane, so the clientFactory below hands
// the query a https://management.azure.com/.default token — NEVER a graph.microsoft.com
// token. The (tenant, client, audience) cache key in graph-core enforces the binding.

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { TokenCache, makeGraphClient, type Fetch } from "@vgi-azure/graph-core";
import { makeMsalMinter } from "@vgi-azure/node-auth";
import { makeResourceGraphFunction } from "./functions.js";
import { makeCatalog } from "./catalog.js";

const cache = new TokenCache(makeMsalMinter());

const clientFactory = (secret: Record<string, unknown>) =>
  makeGraphClient({
    fetch: globalThis.fetch as unknown as Fetch,
    cache,
    cred: {
      tenantId: String(secret.tenant_id ?? ""),
      clientId: String(secret.client_id ?? ""),
      clientSecret: secret.client_secret != null ? String(secret.client_secret) : undefined,
    },
    audience: "arm", // ARM control plane — https://management.azure.com/.default
  });

// Node/Bun runtime → isEdge=false, so the subrequest-budget guard is a no-op here.
const functions = [makeResourceGraphFunction(clientFactory, /*isEdge*/ false)];

const registry = new FunctionRegistry();
for (const f of functions) registry.register(f);

const catalogInterface = new ReadOnlyCatalogInterface(makeCatalog(functions), registry);

new Worker({ functions, catalogInterface }).run();
