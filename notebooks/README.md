# Resource Graph notebooks

[01 · Can a paged inventory support a complete regional review?](01_complete_paged_inventory.ipynb) uses a synthetic estate with the real worker's request construction, pagination and JSON mapping. A left join retains unmatched subscriptions; global and missing locations remain separate. The experiment changes page size 2 → 5 while preserving the complete inventory.

## Run without an Azure account

Requirements: [uv](https://docs.astral.sh/uv/), [Bun](https://bun.sh/), Git and internet for public source/dependency downloads. Keep this directory together; no worker checkout is needed.

```sh
cd notebooks
uv sync --locked
uv run --locked python execute.py
```

Haybarn 2.0.0rc11 and notebook dependencies are locked in `uv.lock`. Optional editor kernel:

```sh
uv run --locked python -m ipykernel install --user --name vgi-azure-resourcegraph-notebooks --display-name "Python (vgi-azure-resourcegraph notebooks)"
```

Use the notebook directory as working directory, then Restart Kernel → Run All. The headless runner creates its own temporary kernel registration and preserves the last successful notebook if execution fails.

## Separate experiment

```sh
uv run --locked python execute.py --parameters '{"PAGE_SIZE": 5}' --output-dir artifacts/page-size-5
```

Overrides require separate output; the experiment includes assets, docs, environment, runner and fixture companions. Restore page size 2 for defaults. Artifacts, logs and virtual environments are ignored.

## Portable launch and fixture boundary

The visible native location `github-auto://Query-farm/vgi-azure-resourcegraph@v0.4.0` reads the actual credential-free recipe catalog. The second literal command is `bun run resourcegraph_fixture.ts Query-farm/vgi-azure-resourcegraph 738e894f9e55a9bf7cf3c10f11303757eceefc17 fixture.json`. Its immutable Git revision matches the release tag. It verifies Git HEAD, installs frozen Bun dependencies and caches by repo/SHA/Bun version in `$XDG_CACHE_HOME/vgi-notebook-workers` or `~/.cache`. Setup diagnostics use stderr to preserve Arrow stdout. Upgrade both pins together and rerun both examples.

The companion imports the original `makeResourceGraphFunction`, catalog and shipped `FakeArg`. It injects the fake through the existing ClientFactory seam. The real function builds requests, follows opaque skip tokens and emits JSON rows through Arrow. The harness uses the requested page size to configure the shipped fake, seeds only the declared query dataset, checks frozen query identity and logs response counts to a temporary file removed at cleanup.

The fixture is synthetic, with no source timestamp or Azure account data. It supports exactly the two KQL strings in `fixture.json`, with subscriptions omitted and objectArray format. It is not a KQL engine or RBAC emulator. Runtime network fetch is disabled; only the declared local Resource Graph query POST is accepted. The visibly dummy secret is ignored by the fake. No auth, live tenant, retry behavior or service timing is tested. Regional comparisons are illustrative, not compliance decisions.

## Live access is separate

A live `resourcegraph_query` needs an `azure_graph` secret and a service principal with at least Reader on the target subscriptions; follow the [worker credential documentation](https://github.com/Query-farm/vgi-azure-resourcegraph#credentials). Provision real secrets outside saved notebook cells/outputs. Each scan refreshes the full snapshot; skip tokens do not support cross-scan resumption. Independent resource and subscription scans are not an atomic joint live snapshot.
