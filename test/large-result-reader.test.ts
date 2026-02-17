import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LargeResultReader } from "../src/large-result-reader.js";

describe("LargeResultReader", () => {
  test("reads file sequentially in chunks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "reddit-mcp-"));
    const filePath = path.join(dir, "tool-result.txt");
    const payload = "abcdefghijklmnopqrstuvwxyz";
    await writeFile(filePath, payload, "utf8");

    const reader = new LargeResultReader([dir]);

    const first = await reader.readChunk({ filePath, offset: 0, limit: 10 });
    expect(first.chunk).toBe("abcdefghij");
    expect(first.nextOffset).toBe(10);
    expect(first.done).toBe(false);

    const second = await reader.readChunk({ filePath, offset: first.nextOffset, limit: 10 });
    expect(second.chunk).toBe("klmnopqrst");
    expect(second.nextOffset).toBe(20);
    expect(second.done).toBe(false);

    const third = await reader.readChunk({ filePath, offset: second.nextOffset, limit: 10 });
    expect(third.chunk).toBe("uvwxyz");
    expect(third.done).toBe(true);
  });
});
