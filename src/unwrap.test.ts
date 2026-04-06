import { describe, expect, it } from "bun:test";

import { toMcpContent, unwrapStatus } from "./unwrap.js";

describe("unwrapStatus", () => {
	it("returns plain objects unchanged", () => {
		const obj = { id: 1, name: "Alice" };
		expect(unwrapStatus(obj)).toEqual(obj);
	});

	it("returns primitives unchanged", () => {
		expect(unwrapStatus("hello")).toBe("hello");
		expect(unwrapStatus(42)).toBe(42);
		expect(unwrapStatus(null)).toBe(null);
		expect(unwrapStatus(undefined)).toBe(undefined);
	});

	it("unwraps Elysia status() responses", () => {
		const wrapped = {
			[Symbol.for("ElysiaCustomStatusResponse")]: 200,
			response: { id: 1, name: "Alice" },
		};
		expect(unwrapStatus(wrapped)).toEqual({ id: 1, name: "Alice" });
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

	it("unwraps status() before formatting", () => {
		const wrapped = {
			[Symbol.for("ElysiaCustomStatusResponse")]: 200,
			response: { ok: true },
		};
		const result = toMcpContent(wrapped);
		expect(result.content[0]?.text).toBe('{"ok":true}');
	});
});
