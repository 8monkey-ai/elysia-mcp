import { describe, expect, it } from "bun:test";
import { unwrapResponse, toMcpContent } from "./unwrap";

describe("unwrapResponse", () => {
	it("returns plain objects as-is", () => {
		const data = { id: 1, name: "Alice" };
		expect(unwrapResponse(data)).toBe(data);
	});

	it("unwraps ElysiaCustomStatusResponse-like objects", () => {
		const wrapped = { code: 200, response: { id: 1, name: "Alice" } };
		expect(unwrapResponse(wrapped)).toEqual({ id: 1, name: "Alice" });
	});

	it("returns null/undefined as-is", () => {
		expect(unwrapResponse(null)).toBeNull();
		expect(unwrapResponse(undefined)).toBeUndefined();
	});

	it("returns strings as-is", () => {
		expect(unwrapResponse("hello")).toBe("hello");
	});

	it("returns arrays as-is", () => {
		const arr = [1, 2, 3];
		expect(unwrapResponse(arr)).toBe(arr);
	});
});

describe("toMcpContent", () => {
	it("wraps objects as JSON text content", () => {
		const result = toMcpContent({ id: 1 });
		expect(result).toEqual({
			content: [{ type: "text", text: '{"id":1}' }],
		});
	});

	it("wraps strings as text content directly", () => {
		const result = toMcpContent("hello world");
		expect(result).toEqual({
			content: [{ type: "text", text: "hello world" }],
		});
	});

	it("handles null", () => {
		const result = toMcpContent(null);
		expect(result).toEqual({
			content: [{ type: "text", text: "null" }],
		});
	});
});
