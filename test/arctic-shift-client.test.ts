import { describe, expect, test } from "bun:test";
import type { HttpClient } from "../src/http.js";
import { UpstreamError } from "../src/errors.js";
import { ArcticShiftClient, extractPostId, mapPost } from "../src/arctic-shift-client.js";

type Http = Pick<HttpClient, "getJson" | "getText">;

type FakeOptions = {
  json?: (url: URL) => unknown;
  text?: (url: URL) => string;
};

function makeHttp(opts: FakeOptions): { http: Http; calls: URL[] } {
  const calls: URL[] = [];
  const http: Http = {
    async getJson<T>(raw: string) {
      const url = new URL(raw);
      calls.push(url);
      const envelope = opts.json ? opts.json(url) : { data: [] };
      return { data: envelope as T, headers: new Headers() };
    },
    async getText(raw: string) {
      const url = new URL(raw);
      calls.push(url);
      return { data: opts.text ? opts.text(url) : "", headers: new Headers() };
    },
  };
  return { http, calls };
}

describe("mapPost", () => {
  test("maps native Arctic-Shift fields to the domain model", () => {
    const post = mapPost({
      id: "abc",
      title: "Title",
      selftext: "body text",
      author: "alice",
      subreddit: "rust",
      url: "",
      permalink: "/r/rust/comments/abc/title/",
      score: 42,
      num_comments: 7,
      created_utc: 1_700_000_000,
      over_18: true,
      spoiler: false,
      link_flair_text: "News",
    });

    expect(post.numComments).toBe(7);
    expect(post.nsfw).toBe(true);
    expect(post.flair).toBe("News");
    expect(post.url).toBe("https://www.reddit.com/r/rust/comments/abc/title/");
    expect(post.source).toBe("arctic-shift");
  });
});

describe("listSubredditPosts", () => {
  test("sort=new requests chronological order and returns an epoch cursor", async () => {
    const rows = [
      { id: "a", created_utc: 200, score: 1 },
      { id: "b", created_utc: 100, score: 5 },
    ];
    const { http, calls } = makeHttp({ json: () => ({ data: rows }) });
    const client = new ArcticShiftClient(http);

    const res = await client.listSubredditPosts({ subreddit: "rust", sort: "new", limit: 10 });

    expect(res.nextCursor).toBe("100");
    expect(res.source).toBe("arctic-shift");
    const url = calls[0]!;
    expect(url.pathname.endsWith("/posts/search")).toBe(true);
    expect(url.searchParams.get("subreddit")).toBe("rust");
    expect(url.searchParams.get("sort")).toBe("desc");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  test("sort=new passes the after cursor as an exclusive `before` bound", async () => {
    const { http, calls } = makeHttp({ json: () => ({ data: [] }) });
    const client = new ArcticShiftClient(http);
    await client.listSubredditPosts({ subreddit: "rust", sort: "new", limit: 10, after: "12345" });
    expect(calls[0]!.searchParams.get("before")).toBe("12345");
  });

  test("sort=top re-sorts a fetched window by score and returns no cursor", async () => {
    const rows = [
      { id: "a", created_utc: 200, score: 3 },
      { id: "b", created_utc: 100, score: 50 },
      { id: "c", created_utc: 150, score: 20 },
    ];
    const { http, calls } = makeHttp({ json: () => ({ data: rows }) });
    const client = new ArcticShiftClient(http);

    const res = await client.listSubredditPosts({ subreddit: "rust", sort: "top", limit: 2, timeframe: "week" });

    expect(res.posts.map((p) => p.id)).toEqual(["b", "c"]);
    expect(res.nextCursor).toBeNull();
    const url = calls[0]!;
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("after")).not.toBeNull();
    expect(url.searchParams.get("before")).not.toBeNull();
  });
});

describe("search", () => {
  test("scoped search (subreddit) issues a full-text posts/search", async () => {
    const { http, calls } = makeHttp({ json: () => ({ data: [{ id: "x", created_utc: 5, score: 1 }] }) });
    const client = new ArcticShiftClient(http);

    await client.search({ query: "async", subreddit: "rust", sort: "new", timeframe: "week", limit: 10 });

    const url = calls[0]!;
    expect(url.pathname.endsWith("/posts/search")).toBe(true);
    expect(url.searchParams.get("query")).toBe("async");
    expect(url.searchParams.get("subreddit")).toBe("rust");
    expect(url.searchParams.get("sort")).toBe("desc");
  });

  test("global search uses the RSS feed then enriches ids via posts/ids", async () => {
    const feed = `<feed>
      <entry><id>t3_aaa</id><link href="https://www.reddit.com/r/x/comments/aaa/t/" /></entry>
      <entry><id>t3_bbb</id><link href="https://www.reddit.com/r/y/comments/bbb/t/" /></entry>
    </feed>`;
    const enriched = {
      data: [
        { id: "aaa", title: "A", score: 5, created_utc: 10 },
        { id: "bbb", title: "B", score: 99, created_utc: 20 },
      ],
    };
    const { http, calls } = makeHttp({ text: () => feed, json: () => enriched });
    const client = new ArcticShiftClient(http);

    const res = await client.search({ query: "rust", sort: "new", timeframe: "week", limit: 10 });

    expect(res.posts.map((p) => p.id).sort()).toEqual(["aaa", "bbb"]);
    expect(res.source).toBe("arctic-shift");
    const rssCall = calls.find((u) => u.pathname.endsWith("/search.rss"));
    const idsCall = calls.find((u) => u.pathname.endsWith("/posts/ids"));
    expect(rssCall).toBeDefined();
    expect(idsCall!.searchParams.get("ids")).toBe("aaa,bbb");
  });

  test("global search with sort=top re-sorts enriched posts by score", async () => {
    const feed = `<feed>
      <entry><id>t3_low</id></entry>
      <entry><id>t3_high</id></entry>
    </feed>`;
    const enriched = {
      data: [
        { id: "low", score: 2, created_utc: 10 },
        { id: "high", score: 500, created_utc: 20 },
      ],
    };
    const { http } = makeHttp({ text: () => feed, json: () => enriched });
    const client = new ArcticShiftClient(http);

    const res = await client.search({ query: "rust", sort: "top", timeframe: "week", limit: 10 });
    expect(res.posts.map((p) => p.id)).toEqual(["high", "low"]);
  });
});

describe("getComments", () => {
  test("paginates with an exclusive after cursor and dedupes", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i + 1}`,
      parent_id: "t3_post",
      created_utc: i + 1,
      score: 1,
    }));
    const page2 = [{ id: "c101", parent_id: "t3_post", created_utc: 101, score: 1 }];

    const { http, calls } = makeHttp({
      json: (url) => {
        if (url.pathname.endsWith("/comments/search")) {
          return { data: url.searchParams.get("after") ? page2 : page1 };
        }
        return { data: [] };
      },
    });
    const client = new ArcticShiftClient(http);

    const res = await client.getComments({ postId: "post", sort: "old", limit: 1000, depth: 6 });

    expect(res.comments).toHaveLength(101);
    const secondCall = calls[1]!;
    expect(secondCall.searchParams.get("after")).toBe("100");
  });

  test("reconstructs depth from parent_id, applies sort per level and depth filter", async () => {
    const rows = [
      { id: "r1", parent_id: "t3_post", created_utc: 1, score: 10 },
      { id: "r2", parent_id: "t3_post", created_utc: 2, score: 5 },
      { id: "c1", parent_id: "t1_r1", created_utc: 3, score: 1 },
      { id: "c1a", parent_id: "t1_c1", created_utc: 4, score: 1 },
    ];
    const { http } = makeHttp({ json: () => ({ data: rows }) });
    const client = new ArcticShiftClient(http);

    const res = await client.getComments({ postId: "post", sort: "top", limit: 50, depth: 2 });

    // Roots by score desc: r1 (10) then r2 (5); r1's reply c1 sits at depth 1;
    // c1a is depth 2 and excluded by depth=2 (keeps levels 0..1).
    expect(res.comments.map((c) => c.id)).toEqual(["r1", "c1", "r2"]);
    expect(res.comments.map((c) => c.depth)).toEqual([0, 1, 0]);
    const c1 = res.comments.find((c) => c.id === "c1")!;
    expect(c1.parentId).toBe("r1");
    const r1 = res.comments.find((c) => c.id === "r1")!;
    expect(r1.parentId).toBeNull();
  });

  test("respects the total limit after tree construction", async () => {
    const rows = [
      { id: "r1", parent_id: "t3_post", created_utc: 1, score: 10 },
      { id: "r2", parent_id: "t3_post", created_utc: 2, score: 9 },
      { id: "r3", parent_id: "t3_post", created_utc: 3, score: 8 },
    ];
    const { http } = makeHttp({ json: () => ({ data: rows }) });
    const client = new ArcticShiftClient(http);
    const res = await client.getComments({ postId: "post", sort: "top", limit: 2, depth: 6 });
    expect(res.comments.map((c) => c.id)).toEqual(["r1", "r2"]);
  });
});

describe("getPost", () => {
  test("returns the post from posts/ids", async () => {
    const { http, calls } = makeHttp({ json: () => ({ data: [{ id: "abc", title: "T", score: 1, created_utc: 1 }] }) });
    const client = new ArcticShiftClient(http);
    const res = await client.getPost({ postId: "t3_abc" });
    expect(res.post.id).toBe("abc");
    expect(calls[0]!.searchParams.get("ids")).toBe("abc");
  });

  test("throws NOT_FOUND when posts/ids is empty", async () => {
    const { http } = makeHttp({ json: () => ({ data: [] }) });
    const client = new ArcticShiftClient(http);
    await expect(client.getPost({ postId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("extractPostId", () => {
  test("strips the t3_ prefix from a raw id", () => {
    expect(extractPostId({ postId: "t3_abc123" })).toBe("abc123");
  });

  test("extracts the id from a canonical comments URL", () => {
    expect(extractPostId({ postUrl: "https://www.reddit.com/r/typescript/comments/xyz987/title/" })).toBe("xyz987");
  });

  test("extracts the id from a redd.it short link", () => {
    expect(extractPostId({ postUrl: "https://redd.it/qq11" })).toBe("qq11");
  });

  test("throws BAD_INPUT for an unresolvable /s/ share link", () => {
    expect(() => extractPostId({ postUrl: "https://www.reddit.com/r/x/s/abcdef" })).toThrow(UpstreamError);
  });

  test("throws BAD_INPUT when neither postId nor postUrl is provided", () => {
    expect(() => extractPostId({})).toThrow(UpstreamError);
  });
});
