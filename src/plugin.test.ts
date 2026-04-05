import { describe, expect, it, afterEach } from "bun:test";
import { Elysia, t } from "elysia";
import { mcp } from "./plugin";

const MCP_HEADERS = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
};

// Helper: send a JSON-RPC request to the MCP endpoint
async function mcpRequest(baseUrl: string, method: string, params?: unknown, id: number = 1) {
	const body = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {}, id });
	return fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: MCP_HEADERS,
		body,
	});
}

async function jsonResponse(response: Response) {
	const text = await response.text();
	return JSON.parse(text);
}

describe("mcp plugin", () => {
	let app: Elysia;
	let baseUrl: string;

	afterEach(() => {
		app?.stop();
	});

	function startApp(a: Elysia) {
		app = a;
		app.listen(0);
		const port = app.server?.port;
		baseUrl = `http://localhost:${port}`;
		return baseUrl;
	}

	it("registers tools from mcp: true routes", async () => {
		const users = [
			{ id: "1", name: "Alice", active: true },
			{ id: "2", name: "Bob", active: false },
		];

		startApp(
			new Elysia()
				.get("/users", ({ query }) => {
					if (query.active !== undefined) {
						return users.filter((u) => u.active === (query.active === "true"));
					}
					return users;
				}, {
					query: t.Object({
						active: t.Optional(t.String({ description: "Filter by active status" })),
					}),
					detail: { summary: "List all users", mcp: true },
				})
				.get("/users/:id", ({ params }) => {
					return users.find((u) => u.id === params.id) ?? null;
				}, {
					params: t.Object({
						id: t.String({ description: "The user's unique ID" }),
					}),
					detail: { summary: "Get user by ID", mcp: { name: "get_user", description: "Retrieve a single user" } },
				})
				.get("/health", () => "ok", {
					detail: { summary: "Health check" },
				})
				.use(mcp({ name: "test-api", version: "0.1.0" })),
		);

		// Initialize MCP session
		const initResp = await mcpRequest(baseUrl, "initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "test-client", version: "1.0.0" },
		});

		expect(initResp.status).toBe(200);
		const initJson = await jsonResponse(initResp);
		expect(initJson.result.serverInfo.name).toBe("test-api");

		// List tools
		const listResp = await mcpRequest(baseUrl, "tools/list", {}, 2);
		expect(listResp.status).toBe(200);

		const listJson = await jsonResponse(listResp);
		const toolNames = listJson.result.tools.map((tool: { name: string }) => tool.name);

		expect(toolNames).toContain("list_users");
		expect(toolNames).toContain("get_user");
		expect(toolNames).not.toContain("list_health");
		expect(listJson.result.tools).toHaveLength(2);

		// Verify tool schemas
		const listUsersTool = listJson.result.tools.find((tool: { name: string }) => tool.name === "list_users");
		expect(listUsersTool.description).toBe("List all users");
		expect(listUsersTool.inputSchema.properties.active).toBeDefined();
		expect(listUsersTool.inputSchema.properties.active.description).toBe("Filter by active status");

		const getUserTool = listJson.result.tools.find((tool: { name: string }) => tool.name === "get_user");
		expect(getUserTool.description).toBe("Retrieve a single user");
		expect(getUserTool.inputSchema.properties.id.description).toBe("The user's unique ID");
	});

	it("calls tools and returns results", async () => {
		const users = [
			{ id: "1", name: "Alice" },
			{ id: "2", name: "Bob" },
		];

		startApp(
			new Elysia()
				.get("/users", () => users, {
					detail: { summary: "List users", mcp: true },
				})
				.get("/users/:id", ({ params }) => {
					return users.find((u) => u.id === params.id) ?? { error: "not found" };
				}, {
					params: t.Object({
						id: t.String({ description: "User ID" }),
					}),
					detail: { mcp: { name: "get_user" } },
				})
				.use(mcp({ name: "test-api", version: "0.1.0" })),
		);

		// Initialize
		await mcpRequest(baseUrl, "initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "test", version: "1.0.0" },
		});

		// Call list_users
		const listResp = await mcpRequest(baseUrl, "tools/call", {
			name: "list_users",
			arguments: {},
		}, 3);
		const listJson = await jsonResponse(listResp);
		const listData = JSON.parse(listJson.result.content[0].text);
		expect(listData).toEqual(users);

		// Call get_user
		const getResp = await mcpRequest(baseUrl, "tools/call", {
			name: "get_user",
			arguments: { id: "1" },
		}, 4);
		const getJson = await jsonResponse(getResp);
		const getData = JSON.parse(getJson.result.content[0].text);
		expect(getData).toEqual({ id: "1", name: "Alice" });
	});

	it("handles unknown tool calls gracefully", async () => {
		startApp(
			new Elysia()
				.get("/test", () => "ok", { detail: { mcp: true } })
				.use(mcp()),
		);

		await mcpRequest(baseUrl, "initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "test", version: "1.0.0" },
		});

		const resp = await mcpRequest(baseUrl, "tools/call", {
			name: "nonexistent_tool",
			arguments: {},
		}, 2);
		const json = await jsonResponse(resp);
		expect(json.result.isError).toBe(true);
		expect(json.result.content[0].text).toContain("Unknown tool");
	});

	it("does not interfere with normal route behavior", async () => {
		startApp(
			new Elysia()
				.get("/api/data", () => ({ value: 42 }), {
					detail: { mcp: true },
				})
				.use(mcp()),
		);

		const resp = await fetch(`${baseUrl}/api/data`);
		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json).toEqual({ value: 42 });
	});

	it("supports POST routes with body schemas", async () => {
		startApp(
			new Elysia()
				.post("/users", ({ body }) => {
					return { id: "new", ...body as Record<string, unknown> };
				}, {
					body: t.Object({
						name: t.String({ description: "User name" }),
						email: t.String({ description: "User email" }),
					}),
					detail: { summary: "Create a user", mcp: true },
				})
				.use(mcp({ name: "test-api", version: "0.1.0" })),
		);

		await mcpRequest(baseUrl, "initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "test", version: "1.0.0" },
		});

		// Check schema
		const listResp = await mcpRequest(baseUrl, "tools/list", {}, 2);
		const listJson = await jsonResponse(listResp);
		const createTool = listJson.result.tools.find((tool: { name: string }) => tool.name === "create_users");
		expect(createTool).toBeDefined();
		expect(createTool.inputSchema.properties.name).toBeDefined();
		expect(createTool.inputSchema.properties.email).toBeDefined();
		expect(createTool.inputSchema.required).toContain("name");
		expect(createTool.inputSchema.required).toContain("email");

		// Call the tool
		const callResp = await mcpRequest(baseUrl, "tools/call", {
			name: "create_users",
			arguments: { name: "Charlie", email: "charlie@test.com" },
		}, 3);
		const callJson = await jsonResponse(callResp);
		const result = JSON.parse(callJson.result.content[0].text);
		expect(result.name).toBe("Charlie");
		expect(result.email).toBe("charlie@test.com");
	});

	it("works with custom endpoint path", async () => {
		startApp(
			new Elysia()
				.get("/data", () => "ok", { detail: { mcp: true } })
				.use(mcp({ path: "/custom-mcp" })),
		);

		// /mcp should not exist
		const defaultResp = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: MCP_HEADERS,
			body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }, id: 1 }),
		});
		expect(defaultResp.status).toBe(404);

		// /custom-mcp should work
		const customResp = await fetch(`${baseUrl}/custom-mcp`, {
			method: "POST",
			headers: MCP_HEADERS,
			body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }, id: 1 }),
		});
		expect(customResp.status).toBe(200);
	});
});
