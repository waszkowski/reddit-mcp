import { HttpClient } from "./http.js";
import {
  CommentsResult,
  GetCommentsInput,
  GetPostInput,
  ListPostsInput,
  PostListResult,
  PostResult,
  RedditComment,
  RedditPost,
  SearchInput,
  SearchResult,
} from "./types.js";
import { UpstreamError } from "./errors.js";

type RedditListingResponse = {
  data?: {
    after?: string | null;
    children?: Array<{
      kind?: string;
      data?: Record<string, unknown>;
    }>;
  };
};

type RedditCommentsResponse = [RedditListingResponse, RedditListingResponse];

export class RedditJsonClient {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async listSubredditPosts(input: ListPostsInput): Promise<PostListResult> {
    const subreddit = sanitizeSubreddit(input.subreddit);
    const url = new URL(`https://www.reddit.com/r/${subreddit}/${input.sort}.json`);
    url.searchParams.set("raw_json", "1");
    url.searchParams.set("limit", String(input.limit));
    if (input.after) {
      url.searchParams.set("after", input.after);
    }
    if (input.timeframe && input.sort === "top") {
      url.searchParams.set("t", input.timeframe);
    }

    const { data } = await this.http.getJson<RedditListingResponse>(url.toString());
    const listing = data.data;

    if (!listing?.children) {
      throw new UpstreamError("Invalid listing response", "UPSTREAM_ERROR");
    }

    return {
      posts: listing.children.map((child) => mapPost(child.data)),
      nextCursor: listing.after ?? null,
      source: "json",
    };
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const url = input.subreddit
      ? new URL(`https://www.reddit.com/r/${sanitizeSubreddit(input.subreddit)}/search.json`)
      : new URL("https://www.reddit.com/search.json");

    url.searchParams.set("raw_json", "1");
    url.searchParams.set("q", input.query);
    url.searchParams.set("sort", input.sort);
    url.searchParams.set("t", input.timeframe);
    url.searchParams.set("limit", String(input.limit));
    url.searchParams.set("type", "link");

    if (input.subreddit) {
      url.searchParams.set("restrict_sr", "1");
    }

    if (input.after) {
      url.searchParams.set("after", input.after);
    }

    const { data } = await this.http.getJson<RedditListingResponse>(url.toString());
    const listing = data.data;

    if (!listing?.children) {
      throw new UpstreamError("Invalid search response", "UPSTREAM_ERROR");
    }

    return {
      posts: listing.children.map((child) => mapPost(child.data)),
      nextCursor: listing.after ?? null,
      source: "json",
    };
  }

  async getPost(input: GetPostInput): Promise<PostResult> {
    const postId = await resolvePostId(this.http, input);
    const url = new URL(`https://www.reddit.com/comments/${postId}.json`);
    url.searchParams.set("raw_json", "1");
    url.searchParams.set("limit", "1");

    const { data } = await this.http.getJson<RedditCommentsResponse>(url.toString());
    const postData = data?.[0]?.data?.children?.[0]?.data;

    if (!postData) {
      throw new UpstreamError("Post not found", "NOT_FOUND", 404);
    }

    return {
      post: mapPost(postData),
      source: "json",
    };
  }

  async getComments(input: GetCommentsInput): Promise<CommentsResult> {
    const postId = await resolvePostId(this.http, input);
    const url = new URL(`https://www.reddit.com/comments/${postId}.json`);
    url.searchParams.set("raw_json", "1");
    url.searchParams.set("sort", input.sort);
    url.searchParams.set("limit", String(input.limit));
    url.searchParams.set("depth", String(input.depth));

    const { data } = await this.http.getJson<RedditCommentsResponse>(url.toString());

    const commentsRoot = data?.[1]?.data?.children ?? [];
    const comments = flattenComments(commentsRoot, postId);

    return {
      postId,
      comments,
      source: "json",
    };
  }
}

export async function resolvePostId(http: HttpClient, input: GetPostInput): Promise<string> {
  if (input.postId) {
    return sanitizePostId(input.postId);
  }

  if (!input.postUrl) {
    throw new UpstreamError("Either postId or postUrl is required", "BAD_INPUT", undefined, false);
  }

  const url = normalizePostUrl(input.postUrl);
  if (url.pathname.includes("/comments/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const commentsIndex = parts.indexOf("comments");
    const id = parts[commentsIndex + 1];
    if (id) {
      return sanitizePostId(id);
    }
  }

  const jsonUrl = new URL(url.toString());
  if (!jsonUrl.pathname.endsWith(".json")) {
    jsonUrl.pathname = `${jsonUrl.pathname.replace(/\/$/, "")}.json`;
  }
  jsonUrl.searchParams.set("raw_json", "1");

  const { data } = await http.getJson<RedditCommentsResponse | RedditListingResponse>(jsonUrl.toString());

  if (Array.isArray(data)) {
    const postData = data?.[0]?.data?.children?.[0]?.data as Record<string, unknown> | undefined;
    const id = postData?.id;
    if (typeof id === "string") {
      return sanitizePostId(id);
    }
  }

  const listing = (data as RedditListingResponse)?.data?.children?.[0]?.data;
  const listingId = listing?.id;
  if (typeof listingId === "string") {
    return sanitizePostId(listingId);
  }

  throw new UpstreamError("Unable to resolve post ID", "NOT_FOUND", 404, false);
}

function sanitizeSubreddit(input: string): string {
  return input.trim().replace(/^r\//i, "").replace(/[^A-Za-z0-9_]/g, "");
}

function sanitizePostId(input: string): string {
  return input.trim().replace(/^t3_/, "");
}

function normalizePostUrl(raw: string): URL {
  const url = new URL(raw);
  if (!url.hostname.includes("reddit.com")) {
    throw new UpstreamError("postUrl must point to reddit.com", "BAD_INPUT", undefined, false);
  }
  return url;
}

function mapPost(raw: Record<string, unknown> | undefined): RedditPost {
  const id = stringOrEmpty(raw?.id);
  const permalink = stringOrEmpty(raw?.permalink);

  return {
    id,
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
    source: "json",
  };
}

function flattenComments(children: Array<{ kind?: string; data?: Record<string, unknown> }>, postId: string): RedditComment[] {
  const out: RedditComment[] = [];

  const walk = (
    nodes: Array<{ kind?: string; data?: Record<string, unknown> }>,
    parentId: string | null,
    depth: number,
  ) => {
    for (const node of nodes) {
      if (node.kind !== "t1" || !node.data) {
        continue;
      }

      const id = stringOrEmpty(node.data.id);
      const subreddit = stringOrEmpty(node.data.subreddit);

      out.push({
        id,
        parentId,
        postId,
        subreddit,
        author: stringOrEmpty(node.data.author),
        body: stringOrEmpty(node.data.body),
        score: numberOrZero(node.data.score),
        createdUtc: numberOrZero(node.data.created_utc),
        permalink: stringOrEmpty(node.data.permalink),
        depth,
      });

      const replies = node.data.replies;
      if (typeof replies === "object" && replies !== null) {
        const replyChildren = ((replies as RedditListingResponse).data?.children ?? []) as Array<{
          kind?: string;
          data?: Record<string, unknown>;
        }>;
        walk(replyChildren, id || null, depth + 1);
      }
    }
  };

  walk(children, null, 0);
  return out;
}

function normalizeExternalUrl(url: string, permalink: string): string {
  if (url) {
    return url;
  }
  if (permalink) {
    return `https://www.reddit.com${permalink}`;
  }
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
