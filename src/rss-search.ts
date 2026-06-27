import type { HttpClient } from "./http.js";
import type { SearchSort, Timeframe } from "./types.js";

const REDDIT_SEARCH_RSS = "https://www.reddit.com/search.rss";

export type GlobalSearchInput = {
  query: string;
  sort: SearchSort;
  timeframe: Timeframe;
  limit: number;
};

/**
 * Reddit's own `/search.rss` feed is the only no-OAuth path for fresh,
 * cross-subreddit keyword discovery (Arctic-Shift requires a subreddit/author
 * for full-text search). It is heavily throttled (~1 request/minute) unless a
 * personal feed token is supplied via REDDIT_RSS_USER / REDDIT_RSS_FEED — those
 * come from the Reddit "RSS feeds" preferences page and need no app approval.
 *
 * Returns the post ids (without the `t3_` prefix) found in the feed, ready to be
 * enriched into full post objects via Arctic-Shift `/api/posts/ids`.
 */
export async function fetchGlobalSearchIds(http: Pick<HttpClient, "getText">, input: GlobalSearchInput): Promise<string[]> {
  const url = buildSearchRssUrl(input);
  const { data } = await http.getText(url);
  return parseSearchFeedIds(data).slice(0, input.limit);
}

export function buildSearchRssUrl(input: GlobalSearchInput): string {
  const url = new URL(REDDIT_SEARCH_RSS);
  url.searchParams.set("q", input.query);
  // Reddit search accepts relevance | new | top (among others); our SearchSort
  // is already a subset of valid values.
  url.searchParams.set("sort", input.sort);
  if (input.sort !== "new") {
    url.searchParams.set("t", input.timeframe);
  }
  url.searchParams.set("limit", String(input.limit));

  const user = process.env.REDDIT_RSS_USER;
  const feed = process.env.REDDIT_RSS_FEED;
  if (user && feed) {
    url.searchParams.set("user", user);
    url.searchParams.set("feed", feed);
  }

  return url.toString();
}

/**
 * Extracts post ids from a Reddit Atom search feed. Only `t3_` (link) entries
 * are kept — search feeds can also contain `t5_` (subreddit) results, which must
 * be ignored. Ids are de-duplicated while preserving feed order.
 */
export function parseSearchFeedIds(xml: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(xml)) !== null) {
    const id = extractEntryPostId(match[1] ?? "");
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

function extractEntryPostId(entry: string): string | null {
  // Preferred: <id>t3_xxxxx</id>
  const tagMatch = /<id>\s*t3_([a-z0-9]+)\s*<\/id>/i.exec(entry);
  if (tagMatch?.[1]) {
    return tagMatch[1];
  }

  // Fallback: a /comments/<id>/ permalink in the entry's link.
  const linkMatch = /\/comments\/([a-z0-9]+)\//i.exec(entry);
  if (linkMatch?.[1]) {
    return linkMatch[1];
  }

  return null;
}
