import { describe, expect, it } from "bun:test";

import { responseToMcpContent } from "./unwrap.js";

describe("responseToMcpContent", () => {
  it("parses JSON response into text content", async () => {
    const response = new Response(JSON.stringify({ id: 1 }), {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe('{"id":1}');
  });

  it("returns plain text for non-JSON content-type", async () => {
    const response = new Response("hello", {
      headers: { "content-type": "text/plain" },
    });
    const result = await responseToMcpContent(response);
    expect(result.content[0]?.text).toBe("hello");
  });

  it("returns empty string for empty JSON body", async () => {
    const response = new Response("", {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response);
    expect(result.content[0]?.text).toBe("");
  });

  it("falls back to raw text on invalid JSON", async () => {
    const response = new Response("not json", {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response);
    expect(result.content[0]?.text).toBe("not json");
  });

  it("formats null JSON as 'null'", async () => {
    const response = new Response("null", {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response);
    expect(result.content[0]?.text).toBe("null");
  });

  it("passes through JSON string values as-is", async () => {
    const response = new Response(JSON.stringify("hello world"), {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response);
    expect(result.content[0]?.text).toBe("hello world");
  });
});
