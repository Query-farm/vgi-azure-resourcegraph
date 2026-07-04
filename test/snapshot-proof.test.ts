// THE archetype-proof for vgi-azure-resourcegraph: prove the ARG $skipToken is an
// IN-SCAN-ONLY snapshot cursor — the deliberate INVERSE of directory's delta cursor.
//
// SDK-free by construction: this test imports ONLY @vgi-azure/graph-core, our own
// pure driver (src/resource-graph.ts, which itself imports nothing from @query-farm/*),
// and the in-file FakeArg. It drives the exact page-walk that functions.ts `process`
// runs, so it exercises the archetype end to end without booting the VGI SDK.

import { test, expect } from "bun:test";
import { ROW_KIND, DELTA_NEXT, WATERMARK_NEXT } from "@vgi-azure/graph-core";
import {
  fetchPage,
  splitSubscriptions,
  clampTop,
  wouldExceedEdgeBudget,
  EstateTooLargeForEdge,
  EDGE_PAGE_BUDGET,
  type ArgPage,
  type QueryIdentity,
} from "../src/resource-graph.js";
import { FakeArg } from "./fake-arg.js";

const KQL = "Resources | project name, location, subscriptionId";

function seed(g: FakeArg): void {
  g.upsert({ id: "/r/1", name: "vm-a", location: "eastus", subscriptionId: "sub-1" });
  g.upsert({ id: "/r/2", name: "vm-b", location: "westus", subscriptionId: "sub-1" });
  g.upsert({ id: "/r/3", name: "st-c", location: "eastus", subscriptionId: "sub-2", sku: "Standard_LRS" });
}

/** Drive the snapshot page-walk exactly as functions.ts `process` does: re-POST the
 *  frozen query identity, advancing only the in-scan $skipToken, until a page omits it.
 *  Returns the collected pages plus each ARG row serialized to its JSON `result` string
 *  (the single-Utf8-JSON default schema — done inline to stay SDK-free). */
async function walk(g: FakeArg, q: QueryIdentity): Promise<{ pages: ArgPage[]; results: string[] }> {
  const pages: ArgPage[] = [];
  const results: string[] = [];
  let skipToken: string | null = null;
  for (;;) {
    const page = await fetchPage(g.client, q, skipToken);
    pages.push(page);
    for (const row of page.data) results.push(JSON.stringify(row));
    if (!page.skipToken) break; // snapshot exhausted → done (no cross-scan cursor persisted)
    skipToken = page.skipToken; // in-scan ONLY
  }
  return { pages, results };
}

test("SNAPSHOT: $skipToken pages one scan across 2 pages, collecting every resource as JSON", async () => {
  const g = new FakeArg(/*pageSize*/ 2); // 3 resources → 2 pages
  seed(g);
  const q: QueryIdentity = { kql: KQL, subscriptions: splitSubscriptions("sub-1,sub-2"), top: clampTop(1000) };

  const { pages, results } = await walk(g, q);

  // All resources collected, in order, exactly once — as one JSON `result` string each.
  expect(pages.length).toBe(2);
  expect(results.length).toBe(3);
  expect(results.map((r) => (JSON.parse(r) as { id: string }).id)).toEqual(["/r/1", "/r/2", "/r/3"]);
  expect(JSON.parse(results[0]!)).toMatchObject({ name: "vm-a", location: "eastus" });
});

test("SNAPSHOT: the SAME query body is re-POSTed with the page's $skipToken", async () => {
  const g = new FakeArg(2);
  seed(g);
  const q: QueryIdentity = { kql: KQL, subscriptions: splitSubscriptions("sub-1,sub-2"), top: clampTop(1000) };

  const { pages } = await walk(g, q);

  // Two POSTs to the pinned 2022-10-01 ARG endpoint.
  expect(g.posts.length).toBe(2);
  expect(g.posts.every((p) => p.url.includes("api-version=2022-10-01"))).toBe(true);

  const [first, second] = g.posts;

  // Page 1: identity body, NO $skipToken.
  expect(first!.body.query).toBe(KQL);
  expect(first!.body.subscriptions).toEqual(["sub-1", "sub-2"]);
  expect(first!.body.options).toMatchObject({ $top: 1000, resultFormat: "objectArray" });
  expect(first!.body.options.$skipToken).toBeUndefined();

  // Page 2: the SAME query + subscriptions + $top, only options.$skipToken advanced —
  // and it is EXACTLY the token page 1 handed back (snapshot-consistency contract).
  expect(second!.body.query).toBe(first!.body.query);
  expect(second!.body.subscriptions).toEqual(first!.body.subscriptions);
  expect(second!.body.options.$top).toBe(first!.body.options.$top);
  expect(second!.body.options.resultFormat).toBe("objectArray");
  expect(second!.body.options.$skipToken).toBe(pages[0]!.skipToken!);
});

test("SNAPSHOT: terminal page omits $skipToken → no cross-scan cursor, no marker, no watermark", async () => {
  const g = new FakeArg(2);
  seed(g);
  const q: QueryIdentity = { kql: KQL, subscriptions: [], top: clampTop(1000) };

  const { pages, results } = await walk(g, q);

  // The last page carries no continuation — the scan ends, nothing is persisted.
  expect(pages.at(-1)!.skipToken).toBeNull();

  // The decoded page shape is snapshot-only: {data, skipToken}. There is NO deltaLink,
  // NO watermark, NO nextLink field to persist across scans.
  for (const page of pages) {
    expect(Object.keys(page).sort()).toEqual(["data", "skipToken"]);
    expect("deltaLink" in page).toBe(false);
    expect("watermark" in page).toBe(false);
  }

  // Business rows carry NO marker/cursor control columns — the snapshot archetype emits
  // pure resource JSON, never a _row_kind='marker' / _delta_next / _watermark_next row.
  for (const r of results) {
    const row = JSON.parse(r) as Record<string, unknown>;
    expect(row[ROW_KIND]).toBeUndefined();
    expect(row[DELTA_NEXT]).toBeUndefined();
    expect(row[WATERMARK_NEXT]).toBeUndefined();
  }

  // With subscriptions omitted (RBAC-scoped), the body omits `subscriptions` entirely.
  expect("subscriptions" in g.posts[0]!.body).toBe(false);
});

test("EDGE guard: the walk fails loud with EstateTooLargeForEdge, never truncating", () => {
  // On the edge profile the budget guard trips before a page that would breach the
  // subrequest ceiling; on Node/Bun (isEdge=false) it is a no-op at any page count.
  expect(wouldExceedEdgeBudget(EDGE_PAGE_BUDGET, /*isEdge*/ true)).toBe(true);
  expect(wouldExceedEdgeBudget(EDGE_PAGE_BUDGET, /*isEdge*/ false)).toBe(false);
  expect(wouldExceedEdgeBudget(EDGE_PAGE_BUDGET - 1, /*isEdge*/ true)).toBe(false);

  const err = new EstateTooLargeForEdge(EDGE_PAGE_BUDGET, ["sub-1"]);
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("EstateTooLargeForEdge");
  expect(err.message).toContain("per subscription");
});
