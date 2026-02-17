export type UpstreamErrorCode =
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_BLOCKED"
  | "NETWORK_ERROR"
  | "BAD_INPUT";

export class UpstreamError extends Error {
  code: UpstreamErrorCode;
  status?: number;
  retriable: boolean;

  constructor(message: string, code: UpstreamErrorCode, status?: number, retriable = false) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.status = status;
    this.retriable = retriable;
  }
}
