// Serve the vgi-azure-resourcegraph worker over HTTP with the standardized VGI
// landing surface.
//
//   GET  /                                     → the shared vendored VGI landing.html
//   GET  /describe.json                        → the worker's catalog introspection
//   GET  /describe/{catalog}/{schema}/{t}.json → lazy per-object columns
//   GET  /health                               → JSON health endpoint (NO azure creds)
//   POST /                                     → the VGI RPC transport (what DuckDB attaches to)
//
// Run it:  PORT=8000 bun run scripts/serve.ts   (default port 8787)
// Attach:  ATTACH 'arg' AS arg (TYPE vgi, LOCATION 'http://localhost:8000');
//
// Everything below the worker's own identity — protocol assembly, state-token
// signing, CORS, the landing surface, Bun.serve — lives in the SDK's
// serveVgiWorker. Set VGI_SIGNING_KEY (64 hex chars) for any real deployment;
// without it the SDK generates an ephemeral key and warns.
//
// The wiring here mirrors src/worker.ts (the stdio entry): same ARM-audience
// Microsoft Graph client factory injected into the same resourcegraph_query
// function, same registry + catalog. serveVgiWorker's /health needs no azure
// creds; resourcegraph_query stays credential-gated at query time (it still
// requires a live azure_graph secret + ARM network call). Adding a function
// means updating BOTH entries.

import { serveVgiWorker } from "@query-farm/vgi/serve";
import { ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { TokenCache, makeGraphClient, type Fetch } from "@vgi-azure/graph-core";
import { makeMsalMinter } from "@vgi-azure/node-auth";
import { makeResourceGraphFunction } from "../src/functions.js";
import { makeCatalog } from "../src/catalog.js";

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

serveVgiWorker({
  name: "azure-resourcegraph",
  doc: "Azure Resource Graph (KQL) queries over your ARM estate, as DuckDB table functions.",
  version: "0.1.0",
  repositoryUrl: "https://github.com/Query-farm/vgi-azure-resourcegraph",
  serverId: "vgi-azure-resourcegraph",
  registry,
  catalogInterface,
});
