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
/** Safety cap on comment pages (~100 each) so pathological threads can't loop forever. */
const MAX_COMMENT_PAGES = 10;
/** Courtesy delay between paginated comment requests (Arctic-Shift asks for a couple req/sec). */
const REQUEST_DELAY_MS = 300;
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
    const raw = await this.fetchAllComments(postId);
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

    // RSS already returns relevance/new ordering; only "top" needs a re-sort,
    // which we can do now that enrichment gave us real scores.
    if (input.sort === "top") {
      posts = posts.sort((a, b) => b.score - a.score);
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

  private async fetchAllComments(postId: string): Promise<RawRecord[]> {
    const linkId = `t3_${postId}`;
    const collected: RawRecord[] = [];
    const seen = new Set<string>();
    let afterSec: number | undefined;

    for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
      const url = new URL(`${this.base}/comments/search`);
      url.searchParams.set("link_id", linkId);
      url.searchParams.set("limit", "100");
      url.searchParams.set("sort", "asc");
      if (afterSec !== undefined) url.searchParams.set("after", String(afterSec));

      const { data } = await this.http.getJson<ArcticEnvelope<RawRecord[]>>(url.toString());
      const rows = data.data ?? [];
      for (const row of rows) {
        const id = stringOrEmpty(row.id);
        if (id && !seen.has(id)) {
          seen.add(id);
          collected.push(row);
        }
      }

      const lastRow = rows[rows.length - 1];
      if (rows.length < 100 || !lastRow) break;
      afterSec = numberOrZero(lastRow.created_utc);
      await sleep(REQUEST_DELAY_MS);
    }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
