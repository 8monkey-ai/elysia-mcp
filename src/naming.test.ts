import { describe, expect, it } from "bun:test";

import { deriveToolName, singularize } from "./naming.js";

describe("singularize", () => {
	it("removes trailing -s", () => {
		expect(singularize("users")).toBe("user");
	});

	it("handles -ies → -y", () => {
		expect(singularize("categories")).toBe("category");
	});

	it("handles -ses", () => {
		expect(singularize("statuses")).toBe("status");
	});

	it("handles -ches", () => {
		expect(singularize("batches")).toBe("batch");
	});

	it("leaves singular words unchanged", () => {
		expect(singularize("user")).toBe("user");
	});
});

describe("deriveToolName", () => {
	it("GET /collection → list_collection", () => {
		expect(deriveToolName("GET", "/users")).toBe("list_users");
	});

	it("GET /collection/:id → get_singular", () => {
		expect(deriveToolName("GET", "/users/:id")).toBe("get_user");
	});

	it("POST /collection → create_singular", () => {
		expect(deriveToolName("POST", "/users")).toBe("create_user");
	});

	it("PATCH /collection/:id → update_singular", () => {
		expect(deriveToolName("PATCH", "/users/:id")).toBe("update_user");
	});

	it("PUT /collection/:id → update_singular", () => {
		expect(deriveToolName("PUT", "/users/:id")).toBe("update_user");
	});

	it("DELETE /collection/:id → delete_singular", () => {
		expect(deriveToolName("DELETE", "/users/:id")).toBe("delete_user");
	});

	it("handles nested paths", () => {
		expect(deriveToolName("GET", "/users/:userId/posts")).toBe("list_user_posts");
	});

	it("handles deeply nested single-resource paths", () => {
		expect(deriveToolName("GET", "/users/:userId/posts/:postId")).toBe("get_user_post");
	});

	it("handles deeply nested multi-resource paths", () => {
		expect(deriveToolName("GET", "/v1/agents/:as/branches/:bs")).toBe("get_v1_agent_branch");
	});

	it("handles triple-nested paths", () => {
		expect(deriveToolName("GET", "/v1/agents/:as/branches/:bs/traces/:ts")).toBe("get_v1_agent_branch_trace");
	});

	it("handles nested list paths", () => {
		expect(deriveToolName("GET", "/v1/agents/:as/branches")).toBe("list_v1_agent_branches");
	});

	it("handles case-insensitive methods", () => {
		expect(deriveToolName("get", "/users")).toBe("list_users");
	});
});
