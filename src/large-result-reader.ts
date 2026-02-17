import { open, stat } from "node:fs/promises";
import path from "node:path";
import { UpstreamError } from "./errors.js";

export type ReadChunkInput = {
  filePath: string;
  offset: number;
  limit: number;
};

export type ReadChunkResult = {
  filePath: string;
  offset: number;
  limit: number;
  nextOffset: number;
  totalBytes: number;
  done: boolean;
  chunk: string;
};

export class LargeResultReader {
  private readonly allowedRoots: string[];

  constructor(allowedRoots?: string[]) {
    this.allowedRoots =
      allowedRoots && allowedRoots.length > 0
        ? allowedRoots.map((root) => path.resolve(root))
        : getDefaultAllowedRoots();
  }

  async readChunk(input: ReadChunkInput): Promise<ReadChunkResult> {
    const resolvedPath = path.resolve(input.filePath);

    if (!isPathAllowed(resolvedPath, this.allowedRoots)) {
      throw new UpstreamError(
        `filePath is outside allowed roots: ${this.allowedRoots.join(", ")}`,
        "BAD_INPUT",
        undefined,
        false,
      );
    }

    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      throw new UpstreamError("filePath must point to a regular file", "BAD_INPUT", undefined, false);
    }

    const totalBytes = fileStat.size;
    const offset = Math.min(input.offset, totalBytes);
    const limit = Math.max(1, Math.min(input.limit, 20_000));
    const bytesToRead = Math.max(0, Math.min(limit, totalBytes - offset));

    if (bytesToRead === 0) {
      return {
        filePath: resolvedPath,
        offset,
        limit,
        nextOffset: offset,
        totalBytes,
        done: true,
        chunk: "",
      };
    }

    const handle = await open(resolvedPath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      const nextOffset = offset + bytesRead;

      return {
        filePath: resolvedPath,
        offset,
        limit,
        nextOffset,
        totalBytes,
        done: nextOffset >= totalBytes,
        chunk,
      };
    } finally {
      await handle.close();
    }
  }
}

function isPathAllowed(filePath: string, roots: string[]): boolean {
  for (const root of roots) {
    if (filePath === root || filePath.startsWith(`${root}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

function getDefaultAllowedRoots(): string[] {
  const fromEnv = process.env.MCP_TOOL_RESULTS_ROOTS;
  if (!fromEnv) {
    return ["/sessions"];
  }

  return fromEnv
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}
