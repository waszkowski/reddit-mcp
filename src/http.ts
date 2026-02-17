import { UpstreamError } from "./errors.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

export type HttpClientOptions = {
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
};

export type JsonResponse<T> = {
  data: T;
  headers: Headers;
};

export class HttpClient {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;

  constructor(options: HttpClientOptions = {}) {
    this.userAgent = options.userAgent ?? process.env.REDDIT_USER_AGENT ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 350;
  }

  async getJson<T>(url: string): Promise<JsonResponse<T>> {
    const response = await this.fetchWithRetry(url, "application/json");
    const data = (await response.json()) as T;
    return { data, headers: response.headers };
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
