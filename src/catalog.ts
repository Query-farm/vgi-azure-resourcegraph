// The `azure` catalog descriptor + the azure_graph secret type. The secret shape is
// the frozen app-only client-credentials seam owned by the directory worker and
// reused verbatim across every vgi-azure worker (conformance checklist). ARG requests
// the ARM audience, but that binding lives in the worker's clientFactory (audience:
// 'arm'), NOT in the secret type — the same secret mints tokens for any audience.

import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import type { CatalogDescriptor, SecretTypeDescriptor, VgiFunction } from "@query-farm/vgi";
import { COMPOSED_EXAMPLES } from "./examples.js";

const REPO = "https://github.com/Query-farm/vgi-azure-resourcegraph";
const ISSUES = `${REPO}/issues`;

export const AZURE_GRAPH_SECRET: SecretTypeDescriptor = {
  name: "azure_graph",
  description: "Microsoft Entra app-only (client-credentials) credentials for Azure ARM / Microsoft Graph",
  // vgi_doc (per parameter) and vgi_doc_url (schema) document where each credential
  // comes from (vgi-lint VGI1011 / VGI1012).
  schema: new Schema(
    [
      new Field(
        "tenant_id",
        new Utf8(),
        true,
        new Map([["vgi_doc", "Directory (tenant) ID of the Microsoft Entra tenant, from the app registration's Overview page"]]),
      ),
      new Field(
        "client_id",
        new Utf8(),
        true,
        new Map([["vgi_doc", "Application (client) ID of the Microsoft Entra app registration, from its Overview page"]]),
      ),
      new Field(
        "client_secret",
        new Utf8(),
        true,
        new Map([
          ["redact", "true"],
          ["vgi_doc", "Client secret value created under the app registration's Certificates & secrets page (shown once, at creation)"],
        ]),
      ),
    ],
    new Map([["vgi_doc_url", "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app"]]),
  ),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Azure Resource Graph",
  "vgi.subtitle": "Inventory every Azure resource across your subscriptions with one KQL query from SQL.",
  "vgi.doc_llm":
    "Azure Resource Graph (ARG) as a single SQL table function. Reach for it to inventory a whole " +
    "Azure ARM estate with one KQL (Kusto Query Language) query: it runs the query across every " +
    "subscription the service principal can read and returns one JSON `result` row per matching " +
    "resource. It is a point-in-time snapshot — there is no change tracking, no cross-scan cursor, " +
    "and no marker row; each scan re-runs the query fresh (ARG paginates internally with an in-scan " +
    "$skipToken that never becomes a column). Requires an app-only (client-credentials) 'azure_graph' " +
    "secret (tenant_id, client_id, client_secret) whose principal has at least Reader on the target " +
    "subscriptions. Rows come back as JSON strings, so pull fields with DuckDB's json_extract / -> operators.",
  "vgi.doc_md":
    "## Azure Resource Graph\n\n" +
    "Whole-estate Azure inventory via Azure Resource Graph (ARG), exposed as one DuckDB table function.\n\n" +
    "- **`resourcegraph_query`** — run one KQL query across the ARM estate; returns one JSON `result` " +
    "string per resource (a point-in-time snapshot, no change feed).\n\n" +
    "The KQL string is required (positional); optionally scope to specific subscriptions and tune the " +
    "ARG page size. Each result row is a JSON object — extract fields with `json_extract(result, '$.name')` " +
    "or the `->` / `->>` operators. An app-only `azure_graph` secret (Microsoft Entra client credentials, " +
    "Reader on the target subscriptions) is required to fetch data.",
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
    "cloud inventory",
    "snapshot",
    "infrastructure",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // Guaranteed-runnable, catalog-qualified example (VGI509/VGI906). A LIVE query needs an
  // attached azure_graph secret and a network call to ARM, so this is a credential-free
  // `LIMIT 0` bind probe: onBind runs (returning the schema) without a secret, and
  // process() — where the secret and network live — is never pumped. It verifies the
  // function binds and exposes its result column without fetching (and without credentials).
  // Drop the `LIMIT 0` and attach an azure_graph secret to pull real rows — the fuller,
  // data-returning queries live in the function's `examples` and the schema `example_queries`.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "resourcegraph_bind_probe",
      description:
        "Bind resourcegraph_query and expose its result column (credential-free; drop LIMIT 0 and attach an azure_graph secret to run the KQL against your estate)",
      sql: "SELECT result FROM azure.main.resourcegraph_query('Resources | project name, type, location') LIMIT 0",
    },
  ]),
  // The agent-suitability suite (VGI152), catalog only. Only each task's name + prompt is
  // published here (VGI416); the grader fields (reference_sql / check_sql / success_criteria)
  // live in the private sidecar vgi-agent-tests.yaml, keyed by task name, and are never
  // shown to the analyst.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "count_resources_by_type",
      prompt: "Using Azure Resource Graph, how many resources of each type exist across the estate?",
    },
    {
      name: "list_storage_accounts",
      prompt: "List the Azure storage accounts and the resource group each one lives in.",
    },
    {
      name: "scope_to_subscription",
      prompt: "Run a Resource Graph query but restrict it to a single subscription GUID.",
    },
    {
      name: "storage_accounts_with_subscription_name",
      prompt:
        "List every Azure storage account together with the display name (not the GUID) of the subscription it belongs to.",
    },
    {
      name: "browse_kql_recipes",
      prompt:
        "Before I supply credentials, which ready-made Azure Resource Graph KQL queries can I browse and reuse?",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Resource Graph",
  "vgi.doc_llm":
    "The Azure Resource Graph query surface. The single function runs one KQL query across the ARM " +
    "estate and returns one JSON `result` row per resource — a point-in-time snapshot, not a change " +
    "feed. There is no cursor and no marker row; extract fields from each JSON string with json_extract " +
    "or the -> / ->> operators. Optionally scope to specific subscription GUIDs and tune the ARG page size.",
  "vgi.doc_md":
    "## Azure Resource Graph\n\n" +
    "| Function | Purpose | Returns |\n" +
    "| --- | --- | --- |\n" +
    "| `resourcegraph_query` | Run one KQL query over the ARM estate | one JSON `result` string per resource |\n\n" +
    "The `result` column is a JSON object per resource; pull fields with `json_extract(result, '$.name')` " +
    "or the `->>` operator. Each scan re-runs the query fresh (a snapshot — no incremental cursor). " +
    "Requires an app-only `azure_graph` secret.",
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
  domain: "cloud-inventory",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    {
      name: "resource-inventory",
      title: "Resource Inventory",
      description:
        "Whole-estate Azure resource inventory via Azure Resource Graph KQL queries (point-in-time snapshot).",
    },
    {
      name: "discovery",
      title: "Discovery",
      description:
        "Credential-free browsable entry points that describe how to query the catalog before any secret or KQL is supplied.",
    },
  ]),
  "vgi.example_queries": JSON.stringify([
    {
      description: "Count resources by type across the estate",
      sql: "SELECT result ->> 'type' AS type, count(*) FROM azure.main.resourcegraph_query('Resources | project type') GROUP BY 1 ORDER BY 2 DESC",
    },
    ...COMPOSED_EXAMPLES,
    {
      description: "List storage accounts with their resource group",
      sql: "SELECT result ->> 'name' AS name, result ->> 'resourceGroup' AS resource_group FROM azure.main.resourcegraph_query('Resources | where type =~ ''microsoft.storage/storageaccounts'' | project name, resourceGroup')",
    },
    {
      description: "Query a single subscription by GUID",
      sql: "SELECT result FROM azure.main.resourcegraph_query('Resources | project name, location', subscriptions := '00000000-0000-0000-0000-000000000000')",
    },
  ]),
};

/** The credential-free discovery view: a curated menu of ready-to-run Azure Resource
 *  Graph KQL queries, so an agent has a browsable entry point (VGI146) — `SELECT * FROM
 *  azure.main.kql_recipes` — before it has to hand-write KQL or supply a secret. A
 *  recipe's `kql` value drops straight into resourcegraph_query's first argument.
 *  Self-contained VALUES, no worker RPC, so it binds and scans without an azure_graph
 *  secret. */
const KQL_RECIPES_VIEW_TAGS: Record<string, string> = {
  domain: "cloud-inventory",
  "vgi.category": "discovery",
  "vgi.title": "Resource Graph KQL Recipes",
  "vgi.keywords": JSON.stringify([
    "kql",
    "recipes",
    "examples",
    "discovery",
    "queries",
    "resource graph",
    "catalog",
  ]),
  "vgi.doc_llm":
    "A static, credential-free menu of curated Azure Resource Graph KQL queries. One row per recipe " +
    "with its name, the KQL query string, and a one-line description of what it returns. Browse this " +
    "view to pick a ready-made KQL query before writing your own or supplying credentials — a recipe's " +
    "`kql` value drops straight into resourcegraph_query's first (positional) argument. Covers common " +
    "inventory needs: all resources, counts by type or resource group, storage accounts, virtual " +
    "machines, public IPs, and untagged resources.",
  "vgi.doc_md":
    "## kql_recipes\n\n" +
    "A credential-free menu of curated Azure Resource Graph KQL queries — a browsable entry point for " +
    "discovery. Each row is one recipe: its `name`, the `kql` query string, and a short `description`. " +
    "Take a `kql` value straight into `resourcegraph_query(<kql>)`, then extract fields from the JSON " +
    "`result` column. No secret is needed to browse this view.",
  "vgi.example_queries": JSON.stringify([
    {
      description: "List every curated KQL recipe with what it returns",
      sql: "SELECT name, description FROM azure.main.kql_recipes ORDER BY name",
    },
  ]),
};

const KQL_RECIPES_VIEW_COLUMN_COMMENTS: Record<string, string> = {
  name: "Short identifier for the recipe (e.g. count_by_type).",
  kql: "The Azure Resource Graph KQL query string — pass it straight into resourcegraph_query's first argument.",
  description: "A one-line summary of what the recipe returns.",
};

// A single-statement VALUES scan — self-contained, no worker call, so it binds and scans
// without an azure_graph secret. Single quotes inside each KQL literal are doubled ('') so
// the whole recipe stays one SQL string. Column names/order are pinned by the trailing AS list.
const KQL_RECIPES_VIEW_DEFINITION =
  "SELECT name, kql, description FROM (VALUES " +
  "('all_resources', 'Resources | project name, type, location', 'Every resource with its name, type, and region.'), " +
  "('count_by_type', 'Resources | summarize count() by type', 'Number of resources of each resource type.'), " +
  "('count_by_resource_group', 'Resources | summarize count() by resourceGroup', 'Number of resources in each resource group.'), " +
  "('storage_accounts', 'Resources | where type =~ ''microsoft.storage/storageaccounts'' | project name, resourceGroup, location', 'Storage accounts with their resource group and region.'), " +
  "('virtual_machines', 'Resources | where type =~ ''microsoft.compute/virtualmachines'' | project name, resourceGroup, location', 'Virtual machines with their resource group and region.'), " +
  "('public_ip_addresses', 'Resources | where type =~ ''microsoft.network/publicipaddresses'' | project name, resourceGroup', 'Public IP address resources with their resource group.'), " +
  "('untagged_resources', 'Resources | where isnull(tags) or array_length(bag_keys(tags)) == 0 | project name, type, resourceGroup', 'Resources that carry no tags — useful for governance sweeps.')" +
  ") AS t(name, kql, description)";

export function makeCatalog(functions: VgiFunction[]): CatalogDescriptor {
  return {
    name: "azure",
    defaultSchema: "main",
    comment:
      "Azure Resource Graph — whole-estate KQL inventory as a DuckDB table (point-in-time snapshot) — vgi-azure-resourcegraph",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    secretTypes: [AZURE_GRAPH_SECRET],
    schemas: [
      {
        name: "main",
        comment: "Azure Resource Graph — one KQL query over the ARM estate as one JSON result row per resource.",
        tags: SCHEMA_TAGS,
        views: [
          {
            name: "kql_recipes",
            definition: KQL_RECIPES_VIEW_DEFINITION,
            comment:
              "Credential-free menu of curated Azure Resource Graph KQL queries (a browsable discovery entry point).",
            columnComments: KQL_RECIPES_VIEW_COLUMN_COMMENTS,
            tags: KQL_RECIPES_VIEW_TAGS,
          },
        ],
        functions,
      },
    ],
  };
}
