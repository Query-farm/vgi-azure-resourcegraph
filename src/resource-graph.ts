// The Azure Resource Graph (ARG) snapshot driver — pure logic over graph-core's
// postJson, no SDK / no cross-scan cursor. This is the deliberate INVERSE of the
// directory delta driver: ARG is point-in-time, so the $skipToken paginates a
// single in-flight snapshot ONLY and NEVER escapes the scan (SPEC §2). There is no
// deltaLink, no watermark, no marker row — resume means re-run the whole query.

import { AUDIENCE_SCOPE } from "@vgi-azure/graph-core";
import type { GraphClient } from "@vgi-azure/graph-core";

// AUDIENCE is arm: ARG lives on the ARM control plane, so the OAuth2 scope is
// https://management.azure.com/.default (SPEC §3). Referenced here only to make the
// audience binding explicit in the driver that owns the endpoint.
export const ARG_AUDIENCE = "arm" as const;
void AUDIENCE_SCOPE; // documents that arm → management.azure.com/.default

/** The ARM Resource Graph endpoint + the single pinned API version (SPEC §2).
 *  2022-10-01 is the GA version with stable $skipToken / quota-header semantics.
 *  Never inline a version string at a call site. */
export const ARG_API_VERSION = "2022-10-01";
export const ARG_ENDPOINT = `https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API_VERSION}`;

/** ARG's per-page maximum (`options.$top`). */
export const ARG_MAX_TOP = 1000;

/** Hard edge-budget guard (SPEC §6.1). One VGI scan ≈ one Cloudflare Workers
 *  invocation, bounded by 1000 subrequests. ARG has NO mid-scan checkpoint (the
 *  $skipToken is in-scan only), so a snapshot needing more pages than the budget
 *  allows cannot be drained or safely resumed at the edge. Node/Bun has no ceiling,
 *  so the guard is a no-op there. Kept well under 1000 to leave headroom for the
 *  token endpoint + retries. */
export const EDGE_PAGE_BUDGET = 900;

/** The query identity frozen at initialState and replayed VERBATIM on every
 *  continuation page (SPEC §2). ARG ties the $skipToken to this exact shape;
 *  mutating kql/subscriptions/top mid-walk invalidates the token. */
export interface QueryIdentity {
  kql: string;
  /** Subscription GUIDs, or [] to let ARG scope by the principal's RBAC. */
  subscriptions: string[];
  /** options.$top — ARG page size, ≤ ARG_MAX_TOP. */
  top: number;
}

/** One decoded ARG page: the flat objectArray rows + the opaque continuation. */
export interface ArgPage {
  /** The `data` rows of this page (heterogeneous JSON objects). */
  data: Record<string, unknown>[];
  /** body.$skipToken, present iff more pages remain in this snapshot. */
  skipToken: string | null;
}

/** Raised when the runtime is the Cloudflare edge and the snapshot needs more
 *  pages than the subrequest budget allows. Fails LOUD — never truncates (SPEC §6.1).
 *  Carries per-subscription fan-out guidance so the operator can split the call. */
export class EstateTooLargeForEdge extends Error {
  constructor(
    readonly pages: number,
    readonly subscriptions: string[],
  ) {
    const scope = subscriptions.length
      ? `${subscriptions.length} subscription(s)`
      : "all readable subscriptions";
    super(
      `EstateTooLargeForEdge: snapshot exceeded the edge subrequest budget (${EDGE_PAGE_BUDGET} pages) ` +
        `after ${pages} pages over ${scope}. ARG has no mid-scan checkpoint, so this cannot be drained ` +
        `or resumed on the Cloudflare edge without truncating. Fan out per subscription (one scan per ` +
        `subscription GUID via subscriptions:=) or narrow the KQL so each snapshot fits; large estates ` +
        `belong on the Node/Bun runtime where there is no subrequest ceiling.`,
    );
    this.name = "EstateTooLargeForEdge";
  }
}

/** True when issuing the NEXT page would breach the edge subrequest budget.
 *  `pagesSoFar` is the number of pages already fetched this scan. No-op (never true)
 *  off the edge, since Node/Bun has no ceiling. */
export function wouldExceedEdgeBudget(pagesSoFar: number, isEdge: boolean): boolean {
  return isEdge && pagesSoFar >= EDGE_PAGE_BUDGET;
}

/** Build the POST body for a page. On the first page `skipToken` is null and the
 *  option is omitted; on every continuation the SAME query identity is reused
 *  verbatim with only `options.$skipToken` advanced (SPEC §2). */
export function buildQueryBody(q: QueryIdentity, skipToken: string | null): Record<string, unknown> {
  const options: Record<string, unknown> = { $top: q.top, resultFormat: "objectArray" };
  if (skipToken) options.$skipToken = skipToken;
  const body: Record<string, unknown> = { query: q.kql, options };
  // Omit `subscriptions` entirely when empty → ARG scopes by the principal's RBAC.
  if (q.subscriptions.length) body.subscriptions = q.subscriptions;
  return body;
}

/** Decode one raw ARG response into rows + the opaque continuation token. */
export function decodePage(raw: Record<string, unknown>): ArgPage {
  const data = Array.isArray(raw.data) ? (raw.data as Record<string, unknown>[]) : [];
  const skipToken = typeof raw.$skipToken === "string" && raw.$skipToken.length > 0 ? raw.$skipToken : null;
  return { data, skipToken };
}

/** Split a comma-separated subscription list into trimmed GUIDs; ""/NULL → []. */
export function splitSubscriptions(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Clamp a caller page_size into [1, ARG_MAX_TOP], defaulting to the max. */
export function clampTop(pageSize: number | null | undefined): number {
  if (pageSize == null || !Number.isFinite(pageSize) || pageSize <= 0) return ARG_MAX_TOP;
  return Math.min(Math.trunc(pageSize), ARG_MAX_TOP);
}

/**
 * POST one ARG page for the frozen query identity `q`, continuing from `skipToken`
 * (null for the first page). Re-POSTs the SAME body shape every time — this is the
 * snapshot-consistency contract (SPEC §2). 429/Retry-After is handled inside
 * graph-core's postJson (retried in place with the same token, not a resync).
 */
export async function fetchPage(
  client: GraphClient,
  q: QueryIdentity,
  skipToken: string | null,
): Promise<ArgPage> {
  const raw = await client.postJson(ARG_ENDPOINT, buildQueryBody(q, skipToken));
  return decodePage(raw);
}
