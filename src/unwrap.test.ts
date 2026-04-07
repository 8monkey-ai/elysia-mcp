import { describe, expect, it } from "bun:test";

import { responseToMcpContent } from "./unwrap.js";

describe("responseToMcpContent", () => {
  it("returns raw text content without parsing by default", async () => {
    const response = new Response(JSON.stringify({ id: 1 }), {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBe('{"id":1}');
    expect(result.parsed).toBeUndefined();
  });

  it("parses JSON and returns parsed data when needsParsed is true", async () => {
    const response = new Response(JSON.stringify({ id: 1 }), {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response, true);
    expect(result.content[0]?.text).toBe('{"id":1}');
    expect(result.parsed).toEqual({ id: 1 });
  });

  it("returns plain text for non-JSON content-type", async () => {
    const response = new Response("hello", {
      headers: { "content-type": "text/plain" },
    });
    const result = await responseToMcpContent(response);
    expect(result.content[0]?.text).toBe("hello");
    expect(result.parsed).toBeUndefined();
  });

  it("returns empty string for empty body", async () => {
    const response = new Response("", {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response, true);
    expect(result.content[0]?.text).toBe("");
    expect(result.parsed).toBeUndefined();
  });

  it("falls back to raw text on invalid JSON when needsParsed is true", async () => {
    const response = new Response("not json", {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response, true);
    expect(result.content[0]?.text).toBe("not json");
    expect(result.parsed).toBeUndefined();
  });

  it("passes through JSON null as raw text", async () => {
    const response = new Response("null", {
      headers: { "content-type": "application/json" },
    });
    const result = await responseToMcpContent(response, true);
    expect(result.content[0]?.text).toBe("null");
    expect(result.parsed).toBeNull();
  });
});
