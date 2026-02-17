# reddit-mcp

Read-only MCP server for public Reddit content using TypeScript.

## Implemented in v1
- `reddit.list_subreddit_posts`
- `reddit.get_post`
- `reddit.get_comments`
- `reddit.search`
- `reddit.read_large_result`

## Not in v1
- No write/create/edit/delete operations.
- No OAuth flow.
- No RSS fallback yet (see `docs/rss-fallback-plan.md`).

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

## Claude MCP config example (Bun)
```json
{
  "mcpServers": {
    "reddit": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/reddit-mcp/src/index.ts"],
      "env": {
        "REDDIT_USER_AGENT": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
      }
    }
  }
}
```

## Claude MCP config example (Node)
```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/reddit-mcp/src/index.ts"],
      "env": {
        "REDDIT_USER_AGENT": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
      }
    }
  }
}
```

## Large results workflow
When Claude says tool output is too large and gives a file path, read it in chunks with:
- `reddit.read_large_result` with `filePath`, `offset`, `limit`
- Start with `offset=0`, `limit=8000`
- Use returned `nextOffset` until `done=true`

## Notes
- Public data only.
- `REDDIT_USER_AGENT` can be customized in Claude MCP config.
- Handle 429/403 upstream responses in the client workflow.
- Tool payload size protection is enabled in MCP responses:
  - `limit` is capped (`search/list` max 25, `comments` max 50).
  - Long text fields are truncated server-side.
  - If output is still too large, MCP returns a compact truncation message.
- Optional env:
  - `MCP_MAX_OUTPUT_CHARS` (default `60000`) to tune max response size sent to Claude.
  - `MCP_TOOL_RESULTS_ROOTS` (comma-separated, default `/sessions`) to control which file roots are readable by `reddit.read_large_result`.
