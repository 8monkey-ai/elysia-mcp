import { describe, expect, it } from "bun:test";
import { flattenSchemas, unflattenArgs, findMissingDescriptions } from "./schema";

describe("flattenSchemas", () => {
	it("merges params, query, and body into a flat schema", () => {
		const params = {
			type: "object",
			properties: { id: { type: "string", description: "User ID" } },
			required: ["id"],
		};
		const query = {
			type: "object",
			properties: { fields: { type: "string", description: "Fields to include" } },
		};
		const body = {
			type: "object",
			properties: {
				name: { type: "string", description: "User name" },
				email: { type: "string", description: "User email" },
			},
			required: ["name", "email"],
		};

		const result = flattenSchemas(params, query, body);

		expect(result.schema.type).toBe("object");
		expect(Object.keys(result.schema.properties!)).toEqual(["id", "fields", "name", "email"]);
		expect(result.schema.required).toEqual(["id", "name", "email"]);
		expect(result.sourceMap).toEqual({
			id: "params",
			fields: "query",
			name: "body",
			email: "body",
		});
		expect(result.collisions).toEqual([]);
	});

	it("detects property name collisions", () => {
		const params = {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		};
		const body = {
			type: "object",
			properties: { id: { type: "number" } },
		};

		const result = flattenSchemas(params, null, body);

		expect(result.collisions).toEqual(["id"]);
		// First source (params) wins
		expect(result.sourceMap["id"]).toBe("params");
		expect(result.schema.properties!["id"]).toEqual({ type: "string" });
	});

	it("handles null/undefined schemas", () => {
		const result = flattenSchemas(null, undefined, null);

		expect(result.schema.type).toBe("object");
		expect(result.schema.properties).toBeUndefined();
		expect(result.schema.required).toBeUndefined();
		expect(result.collisions).toEqual([]);
	});

	it("preserves descriptions in flattened schema", () => {
		const params = {
			type: "object",
			properties: {
				id: { type: "string", description: "The user's unique ID" },
			},
		};

		const result = flattenSchemas(params, null, null);
		expect(result.schema.properties!["id"]!["description"]).toBe("The user's unique ID");
	});
});

describe("unflattenArgs", () => {
	it("splits flat args back to params, query, body", () => {
		const sourceMap = { id: "params" as const, fields: "query" as const, name: "body" as const };
		const args = { id: "123", fields: "name,email", name: "Alice" };

		const result = unflattenArgs(args, sourceMap);

		expect(result.params).toEqual({ id: "123" });
		expect(result.query).toEqual({ fields: "name,email" });
		expect(result.body).toEqual({ name: "Alice" });
	});

	it("puts unknown properties in body", () => {
		const result = unflattenArgs({ unknown: "value" }, {});
		expect(result.body).toEqual({ unknown: "value" });
	});
});

describe("findMissingDescriptions", () => {
	it("returns properties without description", () => {
		const schema = {
			type: "object" as const,
			properties: {
				id: { type: "string", description: "User ID" },
				name: { type: "string" },
				email: { type: "string" },
			},
		};

		expect(findMissingDescriptions(schema)).toEqual(["name", "email"]);
	});

	it("returns empty array when all have descriptions", () => {
		const schema = {
			type: "object" as const,
			properties: {
				id: { type: "string", description: "User ID" },
			},
		};

		expect(findMissingDescriptions(schema)).toEqual([]);
	});
});
