// The composed (two-scan join) examples are defined once in src/examples.ts and must
// surface on both example lists: the schema-level vgi.example_queries and
// resourcegraph_query's own list, within its first five (the only ones the vgi-lint
// agent simulator shows). Also guards the README, whose composed example must stay
// the same query as the shipped one.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { COMPOSED_EXAMPLES, RESOURCES_PER_SUBSCRIPTION_EXAMPLE } from "../src/examples.js";
import { makeCatalog } from "../src/catalog.js";
import { makeResourceGraphFunction } from "../src/functions.js";
import type { GraphClient } from "@vgi-azure/graph-core";

const noClient = (): GraphClient => {
  throw new Error("not used");
};
const fn = makeResourceGraphFunction(noClient);
const catalog = makeCatalog([fn]);
const schema = catalog.schemas[0]!;

type Ex = { description: string; sql: string };
const parse = (tags: Record<string, string> | undefined): Ex[] =>
  JSON.parse(tags?.["vgi.example_queries"] ?? "[]") as Ex[];

test("composed examples appear in the schema-level example list", () => {
  const shown = parse(schema.tags);
  for (const ex of COMPOSED_EXAMPLES) expect(shown).toContainEqual(ex);
});

test("composed examples are within resourcegraph_query's first five examples", () => {
  const first5 = parse(fn.meta.tags).slice(0, 5);
  for (const ex of COMPOSED_EXAMPLES) expect(first5).toContainEqual(ex);
});

test("composed examples are catalog-qualified, ordered, and join two scans", () => {
  for (const { sql } of COMPOSED_EXAMPLES) {
    expect(sql.match(/azure\.main\.resourcegraph_query\(/g)?.length).toBe(2);
    expect(sql).toContain("ResourceContainers");
    expect(sql).toContain(" JOIN ");
    expect(sql).toContain("ORDER BY");
    expect(sql).not.toMatch(/SELECT \*/);
  }
});

test("README composed example matches the shipped one", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const squash = (s: string) => s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
  expect(squash(readme)).toContain(squash(RESOURCES_PER_SUBSCRIPTION_EXAMPLE.sql));
});
