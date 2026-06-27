import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { UpstreamError } from "./errors.js";
import { HttpClient } from "./http.js";
import { LargeResultReader } from "./large-result-reader.js";
import { ArcticShiftClient } from "./arctic-shift-client.js";
import { RedditService } from "./reddit-service.js";
import {
  getCommentsSchema,
  getPostSchema,
  listSubredditPostsSchema,
  readLargeResultSchema,
  searchSchema,
} from "./schemas.js";

const server = new Server(
  {
    name: "reddit-mcp",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const http = new HttpClient();
const redditClient = new ArcticShiftClient(http);
const redditService = new RedditService(redditClient);
const largeResultReader = new LargeResultReader();
const MAX_OUTPUT_CHARS = Number(process.env.MCP_MAX_OUTPUT_CHARS ?? 60_000);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "reddit_list_subreddit_posts",
        description:
          "List public posts from a subreddit (via the Arctic-Shift archive; data lags ~24-48h). sort: 'new' is exact chronological order; 'top' returns the highest-scoring posts within the timeframe window. Paginate 'new' with the returned nextCursor.",
        inputSchema: {
          type: "object",
          properties: {
            subreddit: { type: "string" },
            sort: { type: "string", enum: ["new", "top"] },
            limit: { type: "number", minimum: 1, maximum: 25 },
            after: { type: "string" },
            timeframe: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"] },
          },
          required: ["subreddit"],
        },
      },
      {
        name: "reddit_get_post",
        description:
          "Get details of a single public Reddit post by ID or URL. Accepts a postId (t3_… or bare id), a /comments/<id>/ permalink, or a redd.it/<id> short link.",
        inputSchema: {
          type: "object",
          properties: {
            postId: { type: "string" },
            postUrl: { type: "string" },
          },
        },
      },
      {
        name: "reddit_get_comments",
        description:
          "Get comments for a public Reddit post (full thread via the Arctic-Shift archive, reconstructed into a tree). sort: 'top' by score, 'new'/'old' by time. depth limits nesting; limit caps the total returned.",
        inputSchema: {
          type: "object",
          properties: {
            postId: { type: "string" },
            postUrl: { type: "string" },
            sort: { type: "string", enum: ["top", "new", "old"] },
            limit: { type: "number", minimum: 1, maximum: 50 },
            depth: { type: "number", minimum: 1, maximum: 6 },
          },
        },
      },
      {
        name: "reddit_search",
        description:
          "Search public Reddit posts. With a subreddit or author, runs a full-text archive search (fresh, full metadata); query is optional there, so you can also list the newest/top posts of a subreddit or author without a keyword. With only a query (no subreddit/author), runs a global keyword search via Reddit's RSS feed (cross-subreddit discovery, but rate-limited to ~1 request/minute). At least one of query/subreddit/author is required. Returns post ids/permalinks to feed into reddit_get_post / reddit_get_comments.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            subreddit: { type: "string" },
            author: { type: "string" },
            sort: { type: "string", enum: ["relevance", "new", "top"] },
            timeframe: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"] },
            limit: { type: "number", minimum: 1, maximum: 25 },
            after: { type: "string" },
          },
        },
      },
      {
        name: "reddit_read_large_result",
        description:
          "Read a large tool-result file in chunks. Use this when Claude reports output too large and gives a file path.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            offset: { type: "number", minimum: 0 },
            limit: { type: "number", minimum: 256, maximum: 20000 },
          },
          required: ["filePath"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  try {
    switch (name) {
      case "reddit_list_subreddit_posts": {
        const input = parse(listSubredditPostsSchema, args);
        const result = await redditService.listSubredditPosts(input);
        return ok(result, { maxStringChars: 700, maxArrayItems: 25 });
      }
      case "reddit_get_post": {
        const input = parse(getPostSchema, args);
        const result = await redditService.getPost(input);
        return ok(result, { maxStringChars: 8_000, maxArrayItems: 50 });
      }
      case "reddit_get_comments": {
        const input = parse(getCommentsSchema, args);
        const result = await redditService.getComments(input);
        return ok(result, { maxStringChars: 900, maxArrayItems: 50 });
      }
      case "reddit_search": {
        const input = parse(searchSchema, args);
        const result = await redditService.search(input);
        return ok(result, { maxStringChars: 600, maxArrayItems: 25 });
      }
      case "reddit_read_large_result": {
        const input = parse(readLargeResultSchema, args);
        const result = await largeResultReader.readChunk(input);
        return ok(result, { maxStringChars: 8_000, maxArrayItems: 50 });
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof UpstreamError) {
      return fail(
        JSON.stringify(
          {
            code: error.code,
            status: error.status,
            retriable: error.retriable,
            message: error.message,
          },
          null,
          2,
        ),
      );
    }

    if (error instanceof Error) {
      return fail(error.message);
    }

    return fail("Unknown error");
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

function parse<S extends z.ZodTypeAny>(schema: S, args: unknown): z.infer<S> {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new UpstreamError(result.error.issues.map((item) => item.message).join("; "), "BAD_INPUT", undefined, false);
  }
  return result.data;
}

type OkOptions = {
  maxStringChars: number;
  maxArrayItems: number;
};

function ok(data: unknown, options: OkOptions) {
  const compact = compactForMcp(data, options.maxStringChars, options.maxArrayItems);
  let text = JSON.stringify(compact, null, 2);

  if (text.length > MAX_OUTPUT_CHARS) {
    const moreCompact = compactForMcp(compact, Math.floor(options.maxStringChars / 2), Math.max(5, Math.floor(options.maxArrayItems / 2)));
    text = JSON.stringify(moreCompact, null, 2);
  }

  if (text.length > MAX_OUTPUT_CHARS) {
    text = JSON.stringify(
      {
        truncated: true,
        message:
          "Tool output exceeded MCP size limits. Narrow the query with smaller limit/after or call get_post/get_comments for a specific thread.",
        maxOutputChars: MAX_OUTPUT_CHARS,
      },
      null,
      2,
    );
  }

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function fail(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

function compactForMcp(value: unknown, maxStringChars: number, maxArrayItems: number): unknown {
  if (typeof value === "string") {
    if (value.length <= maxStringChars) {
      return value;
    }
    return `${value.slice(0, maxStringChars)}… [truncated ${value.length - maxStringChars} chars]`;
  }

  if (Array.isArray(value)) {
    const sliced = value.slice(0, maxArrayItems).map((item) => compactForMcp(item, maxStringChars, maxArrayItems));
    if (value.length > maxArrayItems) {
      sliced.push({
        _meta: `truncated array: ${value.length - maxArrayItems} items omitted`,
      });
    }
    return sliced;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(obj)) {
      out[key] = compactForMcp(inner, maxStringChars, maxArrayItems);
    }
    return out;
  }

  return value;
}
