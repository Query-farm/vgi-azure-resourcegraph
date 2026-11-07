# vgi-azure-resourcegraph

A [VGI](https://query.farm) worker (**Azure Resource Graph**) for DuckDB. Whole-estate Azure inventory via Azure Resource Graph as one DuckDB table function, `resourcegraph_query(kql)`. It runs one KQL query across every subscription the service principal can read (optionally scoped to specific subscriptions) and returns one JSON `result` row per matching resource; extract fields with `json_extract(result, '$.name')` or the `->` / `->>` operators. Each scan is a point-in-time snapshot with no change feed or cursor. A credential-free `kql_recipes` view lists ready-made queries.

## Quick start

Every [GitHub release](https://github.com/Query-farm/vgi-azure-resourcegraph/releases) ships a prebuilt worker binary. The `vgi` extension downloads the one for your platform, checks its SHA-256 and caches it, so there is nothing to install besides DuckDB:

```sql
INSTALL vgi FROM community;
LOAD vgi;

ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-azure-resourcegraph@v0.2.1');

-- Bind resourcegraph_query and expose its result column (credential-free; drop LIMIT 0
-- and attach an azure_graph secret to run the KQL against your estate)
SELECT result FROM azure.main.resourcegraph_query('Resources | project name, type, location') LIMIT 0;

-- Count resources by type across the estate
SELECT result ->> 'type' AS type, count(*) FROM azure.main.resourcegraph_query('Resources | project type') GROUP BY 1 ORDER BY 2 DESC;
```

The first example is a credential-free `LIMIT 0` bind probe: it checks that `resourcegraph_query` binds and shows its result column without calling Azure. The second returns real rows, so it needs an `azure_graph` secret (see [Credentials](#credentials)).

All the Query Farm Azure workers use the catalog name `azure`. To attach more than one in the same session, give each its own alias (for example `ATTACH 'azure' AS azure_resourcegraph (...)`) and qualify queries with that alias instead of `azure`.

Prebuilt binaries cover macOS (Apple silicon), Linux (x86-64 and arm64). `github-auto://` needs an explicit release tag; change `@v0.2.1` to move to a newer release.

### Other ways to run it

- **Docker** (the image bundles the worker; needs a container runtime):

  ```sql
  ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'docker://ghcr.io/query-farm/vgi-azure-resourcegraph:0.2.1');
  ```

- **Manual download.** Download the archive for your platform from the [releases page](https://github.com/Query-farm/vgi-azure-resourcegraph/releases), verify it against its `.sha256` file (a cosign `.cosign.bundle` is published alongside), unpack it, and set `LOCATION` to the path of the extracted worker executable.

### Build from source

To build and test the worker yourself, see [Development](#development).

## Credentials

Live queries authenticate with an `azure_graph` secret holding app-only Microsoft Entra client credentials for a service principal: `TENANT_ID`, `CLIENT_ID` and `CLIENT_SECRET` (the client secret is redacted when secrets are listed). The worker registers the `azure_graph` secret type when it is attached, so create the secret after the `ATTACH`:

```sql
ATTACH 'azure' AS azure (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-azure-resourcegraph@v0.2.1');
CREATE SECRET azure_sp (TYPE azure_graph, TENANT_ID '<tenant-guid>', CLIENT_ID '<app-guid>', CLIENT_SECRET '<secret>');
```

For this worker the service principal needs at least Reader on the target subscriptions.

## Development

Requires [Bun](https://bun.sh). `bun install` also fetches the shared `@vgi-azure/graph-core` package from GitHub.

```bash
bun install && bun test
bun run typecheck
```

To attach a local checkout, point `LOCATION` at the launch wrapper:

```sql
ATTACH 'azure' AS azure (TYPE vgi, LOCATION '/path/to/vgi-azure-resourcegraph/bin/vgi-azure-resourcegraph-worker');
```

## License

MIT. See [LICENSE](LICENSE).
