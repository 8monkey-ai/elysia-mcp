import { describe, expect, it } from "bun:test";

import { toMcpContent } from "./unwrap.js";

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
