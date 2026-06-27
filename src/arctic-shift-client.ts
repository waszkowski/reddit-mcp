import type { HttpClient } from "./http.js";
import { UpstreamError } from "./errors.js";
import { fetchGlobalSearchIds } from "./rss-search.js";
import {
  CommentSort,
  CommentsResult,
  GetCommentsInput,
  GetPostInput,
  ListPostsInput,
  PostListResult,
  PostResult,
  RedditComment,
  RedditDataClient,
  RedditPost,
  SearchInput,
  SearchResult,
  Timeframe,
} from "./types.js";

const DEFAULT_BASE = "https://arctic-shift.photon-reddit.com/api";

/** Candidate window pulled before a client-side score re-sort (== API per-request max). */
const RESORT_FETCH = 100;
/** Window used for score-based ("top"/"relevance") sorts when no timeframe is given. */
const DEFAULT_WINDOW: Timeframe = "week";

type Http = Pick<HttpClient, "getJson" | "getText">;

type ArcticEnvelope<T> = {
  data: T | null;
  error?: string;
};

type RawRecord = Record<string, unknown>;

type PostsSearchParams = {
  subreddit?: string;
  author?: string;
  query?: string;
  sort: "asc" | "desc";
  limit: number;
  afterSec?: number;
  beforeSec?: number;
};

export class ArcticShiftClient implements RedditDataClient {
  private readonly http: Http;
  private readonly base: string;

  constructor(http: Http, base = process.env.ARCTIC_SHIFT_BASE ?? DEFAULT_BASE) {
    this.http = http;
    this.base = base.replace(/\/$/, "");
  }

  async listSubredditPosts(input: ListPostsInput): Promise<PostListResult> {
    const subreddit = sanitizeSubreddit(input.subreddit);

    if (input.sort === "top") {
      const posts = await this.fetchTopWindow({ subreddit }, input.timeframe, input.limit);
      return { posts, nextCursor: null, source: "arctic-shift" };
    }

    // "new": straight chronological, paginated by the oldest item's timestamp.
    const rows = await this.fetchPosts({
      subreddit,
      sort: "desc",
      limit: input.limit,
      beforeSec: parseCursor(input.after),
    });
    const posts = rows.map(mapPost);
    return { posts, nextCursor: lastCreatedCursor(rows), source: "arctic-shift" };
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const subreddit = input.subreddit ? sanitizeSubreddit(input.subreddit) : undefined;
    const author = input.author ? sanitizeAuthor(input.author) : undefined;

    if (subreddit || author) {
      return this.scopedSearch(input, subreddit, author);
    }

    return this.globalSearch(input);
  }

  async getPost(input: GetPostInput): Promise<PostResult> {
    const postId = extractPostId(input);
    const rows = await this.fetchPostsByIds([postId]);
    const raw = rows[0];
    if (!raw) {
      throw new UpstreamError("Post not found", "NOT_FOUND", 404, false);
    }
    return { post: mapPost(raw), source: "arctic-shift" };
  }

  async getComments(input: GetCommentsInput): Promise<CommentsResult> {
    const postId = extractPostId(input);
    const raw = await this.fetchCommentTree(postId);
    const comments = buildCommentTree(raw, postId, input.sort, input.depth).slice(0, input.limit);
    return { postId, comments, source: "arctic-shift" };
  }

  // --- search modes -------------------------------------------------------

  private async scopedSearch(input: SearchInput, subreddit?: string, author?: string): Promise<SearchResult> {
    if (input.sort === "new") {
      const rows = await this.fetchPosts({
        subreddit,
        author,
        query: input.query,
        sort: "desc",
        limit: input.limit,
        beforeSec: parseCursor(input.after),
      });
      return { posts: rows.map(mapPost), nextCursor: lastCreatedCursor(rows), source: "arctic-shift" };
    }

    // "top" and "relevance" (Arctic-Shift has no relevance ranking) → best by
    // score within the timeframe window.
    const posts = await this.fetchTopWindow({ subreddit, author, query: input.query }, input.timeframe, input.limit);
    return { posts, nextCursor: null, source: "arctic-shift" };
  }

  private async globalSearch(input: SearchInput): Promise<SearchResult> {
    if (!input.query) {
      // Reached only when neither subreddit nor author was given; the schema's
      // refine guarantees a query in that case, but narrow it here for safety.
      throw new UpstreamError("A query is required for a global (cross-subreddit) search", "BAD_INPUT", undefined, false);
    }

    const ids = await fetchGlobalSearchIds(this.http, {
      query: input.query,
      sort: input.sort,
      timeframe: input.timeframe,
      limit: input.limit,
    });

    if (ids.length === 0) {
      return { posts: [], nextCursor: null, source: "arctic-shift" };
    }

    const rows = await this.fetchPostsByIds(ids);
    let posts = rows.map(mapPost);

    if (input.sort === "top") {
      // Enrichment gave us real scores, so we can rank by them.
      posts = posts.sort((a, b) => b.score - a.score);
    } else {
      // "new"/"relevance": keep the order RSS discovered them in. /posts/ids
      // does not guarantee the response preserves the requested id order, so
      // re-impose it explicitly instead of trusting the enrichment order.
      const rank = new Map(ids.map((id, i) => [id, i]));
      posts = posts.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }

    return { posts: posts.slice(0, input.limit), nextCursor: null, source: "arctic-shift" };
  }

  // --- low-level fetch helpers -------------------------------------------

  private async fetchTopWindow(
    scope: { subreddit?: string; author?: string; query?: string },
    timeframe: Timeframe | undefined,
    limit: number,
  ): Promise<RedditPost[]> {
    const window = buildWindow(timeframe ?? DEFAULT_WINDOW);
    const rows = await this.fetchPosts({
      ...scope,
      sort: "desc",
      limit: RESORT_FETCH,
      afterSec: window.afterSec,
      beforeSec: window.beforeSec,
    });
    return rows
      .map(mapPost)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async fetchPosts(params: PostsSearchParams): Promise<RawRecord[]> {
    const url = new URL(`${this.base}/posts/search`);
    if (params.subreddit) url.searchParams.set("subreddit", params.subreddit);
    if (params.author) url.searchParams.set("author", params.author);
    if (params.query) url.searchParams.set("query", params.query);
    url.searchParams.set("sort", params.sort);
    url.searchParams.set("limit", String(params.limit));
    if (params.afterSec !== undefined) url.searchParams.set("after", String(params.afterSec));
    if (params.beforeSec !== undefined) url.searchParams.set("before", String(params.beforeSec));

    const { data } = await this.http.getJson<ArcticEnvelope<RawRecord[]>>(url.toString());
    return data.data ?? [];
  }

  private async fetchPostsByIds(ids: string[]): Promise<RawRecord[]> {
    const url = new URL(`${this.base}/posts/ids`);
    url.searchParams.set("ids", ids.map(sanitizePostId).join(","));
    const { data } = await this.http.getJson<ArcticEnvelope<RawRecord[]>>(url.toString());
    return data.data ?? [];
  }

  private async fetchCommentTree(postId: string): Promise<RawRecord[]> {
    const url = new URL(`${this.base}/comments/tree`);
    url.searchParams.set("link_id", `t3_${postId}`);
    // The dedicated tree endpoint returns the whole thread in one request.
    // 9999 is the value Arctic-Shift's own docs use for "all comments" (the
    // hard ceiling is 25000) — far better than paging the flat search endpoint.
    url.searchParams.set("limit", "9999");

    const { data } = await this.http.getJson<ArcticEnvelope<RawRecord[]>>(url.toString());
    const collected: RawRecord[] = [];
    flattenCommentNodes(data.data ?? [], collected);
    return collected;
  }
}

// --- post-id resolution (pure, no network) --------------------------------

export function extractPostId(input: GetPostInput): string {
  if (input.postId) {
    return sanitizePostId(input.postId);
  }

  if (!input.postUrl) {
    throw new UpstreamError("Either postId or postUrl is required", "BAD_INPUT", undefined, false);
  }

  const url = parseRedditUrl(input.postUrl);

  // redd.it/<id> short links: id is the first path segment.
  if (url.hostname === "redd.it") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    if (id) return sanitizePostId(id);
  }

  // Canonical /comments/<id>/ permalinks.
  if (url.pathname.includes("/comments/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[parts.indexOf("comments") + 1];
    if (id) return sanitizePostId(id);
  }

  throw new UpstreamError(
    "Could not extract a post id from postUrl; pass postId or a /comments/<id>/ or redd.it/<id> URL",
    "BAD_INPUT",
    undefined,
    false,
  );
}

function parseRedditUrl(raw: string): URL {
  const url = new URL(raw);
  if (!url.hostname.endsWith("reddit.com") && url.hostname !== "redd.it") {
    throw new UpstreamError("postUrl must point to reddit.com or redd.it", "BAD_INPUT", undefined, false);
  }
  return url;
}

// --- comment tree reconstruction ------------------------------------------

/**
 * Flattens the nested `/api/comments/tree` response into a flat list of raw
 * comment records, which {@link buildCommentTree} then re-assembles. Each node
 * is Reddit-style `{ kind, data: { …, replies: { data: { children: [...] } } } }`;
 * only `t1` (comment) nodes are kept — `more` (collapsed-chain) nodes are skipped.
 */
function flattenCommentNodes(nodes: unknown, out: RawRecord[]): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!isRecord(node) || node.kind !== "t1" || !isRecord(node.data)) continue;
    const data = node.data;
    out.push(data);
    const replies = data.replies;
    if (isRecord(replies) && isRecord(replies.data)) {
      flattenCommentNodes(replies.data.children, out);
    }
  }
}

function buildCommentTree(rows: RawRecord[], postId: string, sort: CommentSort, maxDepth: number): RedditComment[] {
  const byParent = new Map<string, RawRecord[]>();
  for (const row of rows) {
    const parent = stringOrEmpty(row.parent_id);
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(row);
    else byParent.set(parent, [row]);
  }

  const comparator = pickCommentComparator(sort);
  const out: RedditComment[] = [];

  const walk = (parentKey: string, depth: number) => {
    if (depth >= maxDepth) return;
    const children = (byParent.get(parentKey) ?? []).slice().sort(comparator);
    for (const child of children) {
      const id = stringOrEmpty(child.id);
      out.push(mapComment(child, postId, depth));
      if (id) {
        walk(`t1_${id}`, depth + 1);
      }
    }
  };

  walk(`t3_${postId}`, 0);
  return out;
}

function pickCommentComparator(sort: CommentSort): (a: RawRecord, b: RawRecord) => number {
  switch (sort) {
    case "new":
      return (a, b) => numberOrZero(b.created_utc) - numberOrZero(a.created_utc);
    case "old":
      return (a, b) => numberOrZero(a.created_utc) - numberOrZero(b.created_utc);
    case "top":
    default:
      return (a, b) => numberOrZero(b.score) - numberOrZero(a.score);
  }
}

// --- mapping --------------------------------------------------------------

export function mapPost(raw: RawRecord | undefined): RedditPost {
  const permalink = stringOrEmpty(raw?.permalink);

  return {
    id: stringOrEmpty(raw?.id),
    title: stringOrEmpty(raw?.title),
    selfText: stringOrEmpty(raw?.selftext),
    author: stringOrEmpty(raw?.author),
    subreddit: stringOrEmpty(raw?.subreddit),
    url: normalizeExternalUrl(stringOrEmpty(raw?.url), permalink),
    permalink,
    score: numberOrZero(raw?.score),
    numComments: numberOrZero(raw?.num_comments),
    createdUtc: numberOrZero(raw?.created_utc),
    nsfw: booleanOrFalse(raw?.over_18),
    spoiler: booleanOrFalse(raw?.spoiler),
    flair: optionalString(raw?.link_flair_text),
    source: "arctic-shift",
  };
}

export function mapComment(raw: RawRecord, postId: string, depth: number): RedditComment {
  const parentRaw = stringOrEmpty(raw.parent_id);
  const parentId = parentRaw.startsWith("t1_") ? parentRaw.slice(3) : null;

  return {
    id: stringOrEmpty(raw.id),
    parentId,
    postId,
    subreddit: stringOrEmpty(raw.subreddit),
    author: stringOrEmpty(raw.author),
    body: stringOrEmpty(raw.body),
    score: numberOrZero(raw.score),
    createdUtc: numberOrZero(raw.created_utc),
    permalink: stringOrEmpty(raw.permalink),
    depth,
  };
}

// --- small utilities ------------------------------------------------------

function buildWindow(timeframe: Timeframe): { afterSec?: number; beforeSec?: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  if (timeframe === "all") {
    return { beforeSec: nowSec };
  }
  return { afterSec: nowSec - timeframeToSeconds(timeframe), beforeSec: nowSec };
}

function timeframeToSeconds(timeframe: Timeframe): number {
  switch (timeframe) {
    case "hour":
      return 3600;
    case "day":
      return 86_400;
    case "week":
      return 604_800;
    case "month":
      return 2_592_000;
    case "year":
      return 31_536_000;
    case "all":
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function parseCursor(after?: string): number | undefined {
  if (!after) return undefined;
  const value = Number(after);
  return Number.isFinite(value) ? value : undefined;
}

function lastCreatedCursor(rows: RawRecord[]): string | null {
  const last = rows[rows.length - 1];
  if (!last) return null;
  const created = numberOrZero(last.created_utc);
  return created > 0 ? String(created) : null;
}

function sanitizeSubreddit(input: string): string {
  return input.trim().replace(/^\/?r\//i, "").replace(/[^A-Za-z0-9_]/g, "");
}

function sanitizeAuthor(input: string): string {
  return input.trim().replace(/^\/?u\//i, "").replace(/[^A-Za-z0-9_\-]/g, "");
}

function sanitizePostId(input: string): string {
  return input.trim().replace(/^t3_/, "");
}

function normalizeExternalUrl(url: string, permalink: string): string {
  if (url) return url;
  if (permalink) return `https://www.reddit.com${permalink}`;
  return "";
}

function stringOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numberOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function booleanOrFalse(v: unknown): boolean {
  return typeof v === "boolean" ? v : false;
}

function isRecord(v: unknown): v is RawRecord {
  return typeof v === "object" && v !== null;
}
