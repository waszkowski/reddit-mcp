# reddit-mcp

Read-only MCP server for public Reddit content (TypeScript).

## Backend: Arctic-Shift archive

Reddit blocks unauthenticated access to its `www.reddit.com/...json` endpoints (HTTP 403),
and self-service OAuth app creation is closed under the Responsible Builder Policy. This
server therefore reads from the **[Arctic-Shift](https://github.com/ArthurHeitmann/arctic_shift)
archive API** (`arctic-shift.photon-reddit.com`) — a free, no-credentials archive that
covers essentially all public subreddits, posts and comments.

Trade-offs to be aware of:
- **Latency ~24–48h.** Arctic-Shift ingests continuously, but `score` / `num_comments` are a
  snapshot frozen ~36h after a post is created; posts younger than ~36h report `score=1` /
  `num_comments=0`. Comment **content** is captured close to real time.
- **Sorting is date-based.** Only the sorts that can be honestly reproduced are exposed
  (see below); `hot` / `rising` and the live ranking algorithms are not available.

## Tools
- `reddit_list_subreddit_posts` — `sort`: `new` (exact chronological, paginated via
  `nextCursor`) or `top` (highest score within the `timeframe` window).
- `reddit_get_post` — by `postId` (`t3_…` or bare id), `/comments/<id>/` permalink, or
  `redd.it/<id>` short link.
- `reddit_get_comments` — full thread, reconstructed into a tree. `sort`: `top` / `new` /
  `old`; `depth` limits nesting; `limit` caps total comments returned.
- `reddit_search` — see below.
- `reddit_read_large_result` — chunked reader for oversized tool output.

### Search (hybrid)
- **Scoped** (with `subreddit` or `author`): full-text search via Arctic-Shift — fresh, full
  metadata. `sort`: `new` (date, paginated), `top` (by score in window), `relevance` (mapped
  to `top`, since the archive has no relevance ranking).
- **Global** (query only): Arctic-Shift cannot do cross-subreddit keyword search, so the
  query goes to Reddit's own `search.rss` feed for discovery, and the resulting post ids are
  enriched back into full objects via Arctic-Shift. This path is **rate-limited to ~1
  request/minute** unless you supply a personal RSS feed token (see env vars below). Use the
  returned `id` / `permalink` to follow up with `reddit_get_post` / `reddit_get_comments`.

## Runtime
Primary runtime is Bun. Node fallback is also possible.

## Install
```bash
bun install
```

## Run (Bun)
```bash
bun run dev
```

## Run (Node fallback)
```bash
npm install
npm run start:node
```

## Test / typecheck
```bash
bun test
bun run check
```

## Claude MCP config example (Bun)
```json
{
  "mcpServers": {
    "reddit": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/reddit-mcp/src/index.ts"]
    }
  }
}
```

## Environment variables (all optional)
- `ARCTIC_SHIFT_BASE` — override the Arctic-Shift API base URL.
- `REDDIT_RSS_USER` + `REDDIT_RSS_FEED` — personal RSS feed token (from Reddit's "RSS feeds"
  preferences page) to lift the ~1/min throttle on global search. Needs no OAuth app.
- `REDDIT_USER_AGENT` — override the outgoing User-Agent.
- `MCP_MAX_OUTPUT_CHARS` (default `60000`) — max response size sent to Claude before
  truncation.
- `MCP_TOOL_RESULTS_ROOTS` (comma-separated, default `/sessions`) — file roots readable by
  `reddit_read_large_result`.

## Large results workflow
When Claude reports that tool output is too large and gives a file path, read it in chunks with
`reddit_read_large_result` (`filePath`, `offset`, `limit`): start at `offset=0`, `limit=8000`,
and follow the returned `nextOffset` until `done=true`.

## Notes
- Public data only. No write/create/edit/delete operations. No OAuth.
- `/s/` share links cannot be resolved offline — pass a `postId` or a `/comments/<id>/` URL.
- Pagination cursors are epoch seconds and are only returned for `new` listings/searches.
- Output size protection: `limit` is capped (search/list 25, comments 50), long text fields
  are truncated, and oversized payloads fall back to a compact truncation message.
