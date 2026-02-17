# RSS fallback plan (future)

This project is intentionally JSON-only in v1. The fallback below is not implemented yet.

## Why add RSS fallback later
- Improve resilience when selected JSON endpoints return 403/429/temporary blocking.
- Keep read-only behavior while degrading gracefully instead of hard failing.
- Preserve continuity for subreddit listing/search-like use cases.

## Scope to add
- New internal adapter: `RedditRssClient`.
- New parser layer (RSS/Atom -> `RedditPost` normalized model).
- Controlled fallback policy in service layer:
  - Try JSON first.
  - Fallback to RSS only for known upstream states (`FORBIDDEN`, `RATE_LIMITED`, selected `5xx`).
  - Keep `reddit.get_post` and `reddit.get_comments` JSON-only at first (RSS is weak for full comments).

## Proposed design
1. Add `src/rss-client.ts` with:
- `getFeed(path: string)` -> normalized post list.
- Strict URL building limited to reddit.com domains.

2. Extend result metadata:
- Include `source: "json" | "rss"` on list/search results.
- Include warning field when fallback was used.

3. Add service policy:
- Retry JSON per current policy.
- If still blocked, call RSS adapter.
- Emit structured log event `fallback_used=true`.

4. Add MCP behavior:
- Keep existing tool names unchanged.
- Return same schema to avoid client changes.

## Risks and constraints
- RSS payloads have less metadata (score, comments count can be missing/inaccurate).
- Not all query forms map 1:1 to RSS feeds.
- Must keep User-Agent and request volume conservative to reduce blocking.

## Test plan for future fallback
- Unit tests for RSS parser mapping.
- Service tests: JSON success path vs fallback path.
- Contract tests: output schema unchanged between JSON and RSS source.
- Failure tests: both JSON and RSS fail -> clear error object.
