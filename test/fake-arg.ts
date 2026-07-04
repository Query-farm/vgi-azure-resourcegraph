// A stateful in-file fake of the Azure Resource Graph endpoint — enough to prove the
// SNAPSHOT archetype: a single query paginated by an opaque $skipToken echoed in the
// response body and replayed in the next request's options.$skipToken, terminating
// when a response omits it. No network. Versioned snapshots let the crash/resume
// proof show that a re-run observes a FRESH snapshot (there is no partial-resume).
//
// It exposes a GraphClient-shaped `client` (fetchJson + postJson) so it can be
// injected straight into makeResourceGraphFunction's ClientFactory. Every POST body
// is recorded verbatim in `.posts` so tests can assert the re-POST contract.

import type { GraphClient } from "@vgi-azure/graph-core";

export const ARG_ENDPOINT = `https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`;

export interface ArgResource {
  id: string;
  [k: string]: unknown;
}

/** A recorded POST: the endpoint URL and the parsed request body. */
export interface RecordedPost {
  url: string;
  body: {
    query: string;
    subscriptions?: string[];
    options: { $top: number; resultFormat: string; $skipToken?: string };
  };
}

export class FakeArg {
  /** Current live resources, keyed by id. */
  private objs = new Map<string, ArgResource>();
  /** Monotonic snapshot clock — bumped on every mutation so a re-run sees fresh truth. */
  private version = 0;
  /** Every POST body received, in order — the assertion surface for the re-POST contract. */
  readonly posts: RecordedPost[] = [];

  constructor(private readonly pageSize: number = 2) {}

  upsert(o: ArgResource): void {
    this.objs.set(o.id, { ...o });
    this.version++;
  }
  remove(id: string): void {
    if (this.objs.delete(id)) this.version++;
  }

  /** Encode/decode the opaque continuation token: {v: snapshotVersion, offset}. The
   *  worker treats this as fully opaque — only FakeArg reads its structure. */
  private encode(offset: number): string {
    return Buffer.from(JSON.stringify({ v: this.version, offset }), "utf8").toString("base64url");
  }
  private decode(tok: string): { v: number; offset: number } {
    return JSON.parse(Buffer.from(tok, "base64url").toString("utf8")) as { v: number; offset: number };
  }

  /** The GraphClient the function under test consumes. postJson serves ARG pages;
   *  fetchJson is unused by the ARG snapshot path but present to satisfy the type. */
  readonly client: GraphClient = {
    fetchJson: async () => {
      throw new Error("resourcegraph_query must use postJson, not fetchJson");
    },
    postJson: async (url: string, body: unknown) => {
      const b = body as RecordedPost["body"];
      this.posts.push({ url, body: JSON.parse(JSON.stringify(b)) });

      // The snapshot to page: pinned by the $skipToken's embedded version on
      // continuations, else the current version for a first page.
      const sk = b.options.$skipToken;
      const offset = sk ? this.decode(sk).offset : 0;

      const all = [...this.objs.values()];
      const slice = all.slice(offset, offset + this.pageSize);
      const nextOffset = offset + this.pageSize;

      const data = slice.map((o) => ({ ...o }));
      if (nextOffset < all.length) {
        return { data, $skipToken: this.encode(nextOffset) };
      }
      // Terminal page — omit $skipToken → snapshot exhausted.
      return { data };
    },
  };
}
