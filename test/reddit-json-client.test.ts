import { describe, expect, test } from "bun:test";
import { HttpClient } from "../src/http.js";
import { resolvePostId } from "../src/reddit-json-client.js";

describe("resolvePostId", () => {
  test("uses explicit postId when provided", async () => {
    const http = new HttpClient();
    const id = await resolvePostId(http, { postId: "t3_abc123" });
    expect(id).toBe("abc123");
  });

  test("extracts id from canonical reddit comments URL", async () => {
    const http = new HttpClient();
    const id = await resolvePostId(http, {
      postUrl: "https://www.reddit.com/r/typescript/comments/xyz987/some_title/",
    });
    expect(id).toBe("xyz987");
  });
});
