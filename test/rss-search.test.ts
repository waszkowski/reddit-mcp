import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildSearchRssUrl, parseSearchFeedIds } from "../src/rss-search.js";

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>/search?q=rust</id>
  <entry>
    <id>t5_3kc31</id>
    <title>r/rust (a subreddit result, must be ignored)</title>
    <link href="https://www.reddit.com/r/rust/" />
  </entry>
  <entry>
    <id>t3_aaa111</id>
    <title>First post</title>
    <link href="https://www.reddit.com/r/rust/comments/aaa111/first_post/" />
  </entry>
  <entry>
    <title>Second post without id tag</title>
    <link href="https://www.reddit.com/r/programming/comments/bbb222/second/" />
  </entry>
  <entry>
    <id>t3_aaa111</id>
    <title>Duplicate of first</title>
    <link href="https://www.reddit.com/r/rust/comments/aaa111/first_post/" />
  </entry>
</feed>`;

describe("parseSearchFeedIds", () => {
  test("extracts only t3_ post ids, dedupes, preserves order", () => {
    const ids = parseSearchFeedIds(SAMPLE_FEED);
    expect(ids).toEqual(["aaa111", "bbb222"]);
  });

  test("falls back to /comments/<id>/ link when <id> tag is missing", () => {
    const feed = `<feed><entry><link href="https://www.reddit.com/r/x/comments/zzz999/t/" /></entry></feed>`;
    expect(parseSearchFeedIds(feed)).toEqual(["zzz999"]);
  });

  test("returns empty array for a feed with no post entries", () => {
    expect(parseSearchFeedIds("<feed></feed>")).toEqual([]);
  });
});

describe("buildSearchRssUrl", () => {
  const saved = { user: process.env.REDDIT_RSS_USER, feed: process.env.REDDIT_RSS_FEED };

  beforeEach(() => {
    delete process.env.REDDIT_RSS_USER;
    delete process.env.REDDIT_RSS_FEED;
  });

  afterEach(() => {
    if (saved.user === undefined) delete process.env.REDDIT_RSS_USER;
    else process.env.REDDIT_RSS_USER = saved.user;
    if (saved.feed === undefined) delete process.env.REDDIT_RSS_FEED;
    else process.env.REDDIT_RSS_FEED = saved.feed;
  });

  test("sets q, sort, limit and timeframe for non-new sorts", () => {
    const url = new URL(buildSearchRssUrl({ query: "rust async", sort: "top", timeframe: "month", limit: 5 }));
    expect(url.pathname).toBe("/search.rss");
    expect(url.searchParams.get("q")).toBe("rust async");
    expect(url.searchParams.get("sort")).toBe("top");
    expect(url.searchParams.get("t")).toBe("month");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  test("omits timeframe for sort=new", () => {
    const url = new URL(buildSearchRssUrl({ query: "rust", sort: "new", timeframe: "week", limit: 10 }));
    expect(url.searchParams.get("sort")).toBe("new");
    expect(url.searchParams.has("t")).toBe(false);
  });

  test("adds user/feed tokens when both env vars are present", () => {
    process.env.REDDIT_RSS_USER = "abc";
    process.env.REDDIT_RSS_FEED = "secrettoken";
    const url = new URL(buildSearchRssUrl({ query: "rust", sort: "new", timeframe: "week", limit: 10 }));
    expect(url.searchParams.get("user")).toBe("abc");
    expect(url.searchParams.get("feed")).toBe("secrettoken");
  });
});
