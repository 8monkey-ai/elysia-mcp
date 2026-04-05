import { describe, expect, it } from "bun:test";
import { generateToolName } from "./naming";

describe("generateToolName", () => {
	it("GET /users → list_users", () => {
		expect(generateToolName("GET", "/users")).toBe("list_users");
	});

	it("GET /users/:id → get_user", () => {
		expect(generateToolName("GET", "/users/:id")).toBe("get_user");
	});

	it("POST /users → create_users", () => {
		expect(generateToolName("POST", "/users")).toBe("create_users");
	});

	it("PATCH /users/:id → update_user", () => {
		expect(generateToolName("PATCH", "/users/:id")).toBe("update_user");
	});

	it("PUT /users/:id → replace_user", () => {
		expect(generateToolName("PUT", "/users/:id")).toBe("replace_user");
	});

	it("DELETE /users/:id → delete_user", () => {
		expect(generateToolName("DELETE", "/users/:id")).toBe("delete_user");
	});

	it("handles nested paths: GET /users/:userId/posts → list_user_posts", () => {
		expect(generateToolName("GET", "/users/:userId/posts")).toBe("list_user_posts");
	});

	it("handles nested paths with param: GET /users/:userId/posts/:postId → get_user_post", () => {
		expect(generateToolName("GET", "/users/:userId/posts/:postId")).toBe("get_user_post");
	});

	it("handles root path", () => {
		expect(generateToolName("GET", "/")).toBe("list_root");
	});

	it("handles deeply nested paths", () => {
		expect(generateToolName("POST", "/organizations/:orgId/teams/:teamId/members")).toBe("create_organization_team_members");
	});

	it("singularizes words ending in -ies", () => {
		expect(generateToolName("GET", "/categories/:id")).toBe("get_category");
	});

	it("singularizes words ending in -ses", () => {
		expect(generateToolName("GET", "/statuses/:id")).toBe("get_status");
	});
});
