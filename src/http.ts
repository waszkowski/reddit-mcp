import { UpstreamError } from "./errors.js";

const DEFAULT_USER_AGENT = "reddit-mcp/0.2 (read-only personal MCP; Arctic-Shift backend)";

export type JsonResponse<T> = {
  data: T;
};

export type TextResponse = {
  data: string;
};

export class HttpClient {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;

  constructor() {
    this.userAgent = process.env.REDDIT_USER_AGENT ?? DEFAULT_USER_AGENT;
    this.timeoutMs = 10_000;
    this.retries = 2;
    this.baseDelayMs = 350;
  }

  async getJson<T>(url: string): Promise<JsonResponse<T>> {
    const response = await this.fetchWithRetry(url, "application/json");
    const data = (await response.json()) as T;
    return { data };
  }

  async getText(url: string): Promise<TextResponse> {
    const response = await this.fetchWithRetry(url, "application/atom+xml, application/xml, text/xml");
    const data = await response.text();
    return { data };
  }

  private async fetchWithRetry(url: string, accept: string): Promise<Response> {
    let attempt = 0;

    while (attempt <= this.retries) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": this.userAgent,
            Accept: accept,
          },
          signal: controller.signal,
        });

        if (response.ok) {
          return response;
        }

        if (response.status === 404) {
          throw new UpstreamError("Resource not found", "NOT_FOUND", 404, false);
        }

        if (response.status === 403) {
          throw new UpstreamError("Upstream forbidden", "FORBIDDEN", 403, false);
        }

        if (response.status === 400) {
          const detail = await readErrorDetail(response);
          throw new UpstreamError(`Bad request to upstream${detail}`, "BAD_INPUT", 400, false);
        }

        if (response.status === 429) {
          if (attempt < this.retries) {
            await sleep(this.baseDelayMs * Math.pow(2, attempt));
            attempt += 1;
            continue;
          }
          throw new UpstreamError("Rate limited by Reddit", "RATE_LIMITED", 429, true);
        }

        if (response.status >= 500 && response.status < 600) {
          if (attempt < this.retries) {
            await sleep(this.baseDelayMs * Math.pow(2, attempt));
            attempt += 1;
            continue;
          }
          throw new UpstreamError("Upstream server error", "UPSTREAM_ERROR", response.status, true);
        }

        throw new UpstreamError(
          `Unexpected upstream status: ${response.status}`,
          "UPSTREAM_BLOCKED",
          response.status,
          false,
        );
      } catch (error) {
        if (error instanceof UpstreamError) {
          throw error;
        }

        if (attempt < this.retries) {
          await sleep(this.baseDelayMs * Math.pow(2, attempt));
          attempt += 1;
          continue;
        }

        throw new UpstreamError(
          error instanceof Error ? error.message : "Network failure",
          "NETWORK_ERROR",
          undefined,
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new UpstreamError("Retry budget exhausted", "UPSTREAM_ERROR", undefined, true);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort extraction of an upstream error message. Arctic-Shift returns
 * `{ "data": null, "error": "..." }` with HTTP 400 on invalid parameters.
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return `: ${body.error}`;
    }
  } catch {
    // Non-JSON body; fall through to no detail.
  }
  return "";
}
