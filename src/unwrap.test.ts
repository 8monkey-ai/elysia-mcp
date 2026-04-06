import { describe, expect, it } from "bun:test";

import { parseResponseData, toMcpContent } from "./unwrap.js";

describe("parseResponseData", () => {
  it("parses JSON response", async () => {
    const response = new Response(JSON.stringify({ id: 1 }), {
      headers: { "content-type": "application/json" },
    });
    expect(await parseResponseData(response)).toEqual({ id: 1 });
  });

  it("returns text for non-JSON content-type", async () => {
    const response = new Response("hello", {
      headers: { "content-type": "text/plain" },
    });
    expect(await parseResponseData(response)).toBe("hello");
  });

  it("returns empty string for empty JSON body", async () => {
    const response = new Response("", {
      headers: { "content-type": "application/json" },
    });
    expect(await parseResponseData(response)).toBe("");
  });

  it("falls back to text on invalid JSON", async () => {
    const response = new Response("not json", {
      headers: { "content-type": "application/json" },
    });
    expect(await parseResponseData(response)).toBe("not json");
  });
});

describe("toMcpContent", () => {
  it("formats objects as JSON text content", () => {
    const result = toMcpContent({ id: 1 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe('{"id":1}');
  });

  it("formats strings as-is", () => {
    const result = toMcpContent("hello world");
    expect(result.content[0]?.text).toBe("hello world");
  });

  it("formats null as JSON", () => {
    expect(toMcpContent(null).content[0]?.text).toBe("null");
  });
});
