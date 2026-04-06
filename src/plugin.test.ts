import { beforeAll, describe, expect, it } from "bun:test";

import { Elysia, t } from "elysia";

import { mcp } from "./plugin.js";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Send a JSON-RPC request to the MCP endpoint */
async function mcpRequest(
	app: Elysia,
	body: unknown,
	headers?: Record<string, string>,
	path = "/mcp",
): Promise<unknown> {
	const response = await app.handle(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...headers,
			},
			body: JSON.stringify(body),
		}),
	);
	return response.json();
}

/** MCP initialize request — must be sent before other requests */
function initRequest() {
	return {
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "test-client", version: "1.0.0" },
		},
	};
}

/** MCP tools/list request */
function listToolsRequest(id = 1) {
	return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

/** MCP tools/call request */
function callToolRequest(name: string, args: Record<string, unknown> = {}, id = 2) {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name, arguments: args },
	};
}

// ─── Test app setup ──────────────────────────────────────────────────

function createTestApp() {
	// Track lifecycle execution for assertions
	const lifecycleLog: string[] = [];

	const app = new Elysia()
		// Global derive — adds ctx.requestId
		.derive(() => {
			lifecycleLog.push("derive");
			return { requestId: "req-123" };
		})
		// Global beforeHandle hook
		.onBeforeHandle(() => {
			lifecycleLog.push("beforeHandle");
		})
		// Global afterHandle hook
		.onAfterHandle(() => {
			lifecycleLog.push("afterHandle");
		})
		// Simple GET endpoint
		.get(
			"/users",
			() => {
				lifecycleLog.push("handler");
				return [
					{ id: 1, name: "Alice" },
					{ id: 2, name: "Bob" },
				];
			},
			{
				query: t.Object({
					active: t.Optional(
						t.Boolean({ description: "Filter by active status" }),
					),
				}),
				detail: { summary: "List all users", mcp: true },
			},
		)
		// GET with path parameter
		.get(
			"/users/:id",
			({ params }) => {
				lifecycleLog.push("handler");
				return { id: params.id, name: "Alice" };
			},
			{
				params: t.Object({
					id: t.String({ description: "The user ID" }),
				}),
				detail: {
					summary: "Get user by ID",
					mcp: { name: "get_user", description: "Retrieve a single user" },
				},
			},
		)
		// POST endpoint
		.post(
			"/users",
			({ body }) => {
				lifecycleLog.push("handler");
				return { id: 3, ...body };
			},
			{
				body: t.Object({
					name: t.String({ description: "User name" }),
					email: t.String({ description: "User email" }),
				}),
				detail: { summary: "Create a user", mcp: true },
			},
		)
		// PATCH endpoint with params + body
		.patch(
			"/users/:id",
			({ params, body }) => {
				lifecycleLog.push("handler");
				return { id: params.id, ...body };
			},
			{
				params: t.Object({
					id: t.String({ description: "The user ID" }),
				}),
				body: t.Object({
					name: t.Optional(t.String({ description: "Updated name" })),
				}),
				detail: { summary: "Update a user", mcp: true },
			},
		)
		// Endpoint that uses derived context
		.get(
			"/whoami",
			(ctx) => {
				lifecycleLog.push("handler");
				return { requestId: (ctx as unknown as Record<string, unknown>).requestId };
			},
			{
				detail: { summary: "Get request info (tests derive)", mcp: true },
			},
		)
		// Non-MCP route (should not appear as a tool)
		.get("/health", () => ({ status: "ok" }), {
			detail: { mcp: false },
		})
		// Mount MCP plugin
		.use(mcp({ name: "test-api", version: "0.1.0" }));

	return { app, lifecycleLog };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("MCP Plugin Integration", () => {
	let app: Elysia;
	let lifecycleLog: string[];

	beforeAll(async () => {
		const setup = createTestApp();
		app = setup.app;
		lifecycleLog = setup.lifecycleLog;

		// Trigger route compilation (calls onStart handlers)
		// Use app.handle with a dummy request to trigger initialization
		await app.handle(new Request("http://localhost/health"));
	});

	it("responds to the /mcp endpoint", async () => {
		const result = await mcpRequest(app, initRequest());
		expect(result).toHaveProperty("result");
	});

	it("lists discovered tools", async () => {
		// Initialize first
		await mcpRequest(app, initRequest());

		const result = (await mcpRequest(app, listToolsRequest())) as {
			result: { tools: Array<{ name: string; description: string }> };
		};

		const toolNames = result.result.tools.map((t) => t.name);
		expect(toolNames).toContain("list_users");
		expect(toolNames).toContain("get_user");
		expect(toolNames).toContain("create_user");
		expect(toolNames).toContain("update_user");
		expect(toolNames).toContain("list_whoami");
		// Non-MCP route should NOT be listed
		expect(toolNames).not.toContain("list_health");
	});

	it("does not expose non-MCP routes as tools", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(app, listToolsRequest())) as {
			result: { tools: Array<{ name: string }> };
		};
		const toolNames = result.result.tools.map((t) => t.name);
		expect(toolNames).not.toContain("list_health");
	});

	it("calls a GET tool and returns data", async () => {
		lifecycleLog.length = 0;
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(
			app,
			callToolRequest("list_users"),
		)) as {
			result: { content: Array<{ type: string; text: string }> };
		};

		expect(result.result.content[0]?.type).toBe("text");
		const data = JSON.parse(result.result.content[0]!.text);
		expect(data).toHaveLength(2);
		expect(data[0].name).toBe("Alice");
	});

	it("calls a GET tool with path parameters", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(
			app,
			callToolRequest("get_user", { id: "42" }),
		)) as {
			result: { content: Array<{ type: string; text: string }> };
		};

		const data = JSON.parse(result.result.content[0]!.text);
		expect(data.id).toBe("42");
		expect(data.name).toBe("Alice");
	});

	it("calls a POST tool with body", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(
			app,
			callToolRequest("create_user", {
				name: "Charlie",
				email: "charlie@example.com",
			}),
		)) as {
			result: { content: Array<{ type: string; text: string }> };
		};

		const data = JSON.parse(result.result.content[0]!.text);
		expect(data.name).toBe("Charlie");
		expect(data.email).toBe("charlie@example.com");
	});

	it("calls a PATCH tool with params and body", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(
			app,
			callToolRequest("update_user", { id: "42", name: "Updated" }),
		)) as {
			result: { content: Array<{ type: string; text: string }> };
		};

		const data = JSON.parse(result.result.content[0]!.text);
		expect(data.id).toBe("42");
		expect(data.name).toBe("Updated");
	});

	it("executes the full Elysia lifecycle (derive, beforeHandle, afterHandle)", async () => {
		lifecycleLog.length = 0;
		await mcpRequest(app, initRequest());

		lifecycleLog.length = 0;
		await mcpRequest(app, callToolRequest("list_whoami"));

		// The lifecycle should have been executed for the synthetic request
		// derive → beforeHandle → handler → afterHandle
		expect(lifecycleLog).toContain("derive");
		expect(lifecycleLog).toContain("beforeHandle");
		expect(lifecycleLog).toContain("handler");
		expect(lifecycleLog).toContain("afterHandle");
	});

	it("provides derived context to handlers via app.handle()", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(
			app,
			callToolRequest("list_whoami"),
		)) as {
			result: { content: Array<{ type: string; text: string }> };
		};

		const data = JSON.parse(result.result.content[0]!.text);
		expect(data.requestId).toBe("req-123");
	});

	it("returns an error for unknown tools", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(
			app,
			callToolRequest("nonexistent_tool"),
		)) as {
			result: { isError: boolean; content: Array<{ text: string }> };
		};

		expect(result.result.isError).toBe(true);
		expect(result.result.content[0]?.text).toContain("Unknown tool");
	});

	it("does not interfere with regular REST endpoints", async () => {
		const response = await app.handle(
			new Request("http://localhost/health"),
		);
		const data = await response.json();
		expect(data).toEqual({ status: "ok" });
	});

	it("preserves tool descriptions from detail.summary", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(app, listToolsRequest())) as {
			result: { tools: Array<{ name: string; description: string }> };
		};

		const listUsers = result.result.tools.find((t) => t.name === "list_users");
		expect(listUsers?.description).toBe("List all users");
	});

	it("uses explicit mcp description when provided", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(app, listToolsRequest())) as {
			result: { tools: Array<{ name: string; description: string }> };
		};

		const getUser = result.result.tools.find((t) => t.name === "get_user");
		expect(getUser?.description).toBe("Retrieve a single user");
	});

	it("includes input schema with property descriptions", async () => {
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(app, listToolsRequest())) as {
			result: {
				tools: Array<{
					name: string;
					inputSchema: {
						type: string;
						properties: Record<string, { description?: string }>;
						required: string[];
					};
				}>;
			};
		};

		const getUser = result.result.tools.find((t) => t.name === "get_user");
		expect(getUser?.inputSchema.type).toBe("object");
		expect(getUser?.inputSchema.properties["id"]?.description).toBe("The user ID");
		expect(getUser?.inputSchema.required).toContain("id");
	});
});

describe("MCP Plugin allRoutes option", () => {
	it("exposes all routes by default (allRoutes: true)", async () => {
		const app = new Elysia()
			.get("/users", () => [{ id: 1 }])
			.get("/items", () => [{ id: 2 }])
			.get("/health", () => "ok", { detail: { mcp: false } })
			.use(mcp({ name: "test" }));

		await app.handle(new Request("http://localhost/health"));
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(app, listToolsRequest())) as {
			result: { tools: Array<{ name: string }> };
		};
		const toolNames = result.result.tools.map((t) => t.name);
		expect(toolNames).toContain("list_users");
		expect(toolNames).toContain("list_items");
		expect(toolNames).not.toContain("list_health");
	});

	it("requires explicit opt-in when allRoutes is false", async () => {
		const app = new Elysia()
			.get("/users", () => [{ id: 1 }], { detail: { mcp: true } })
			.get("/items", () => [{ id: 2 }])
			.use(mcp({ name: "test", allRoutes: false }));

		await app.handle(new Request("http://localhost/items"));
		await mcpRequest(app, initRequest());
		const result = (await mcpRequest(app, listToolsRequest())) as {
			result: { tools: Array<{ name: string }> };
		};
		const toolNames = result.result.tools.map((t) => t.name);
		expect(toolNames).toContain("list_users");
		expect(toolNames).not.toContain("list_items");
	});
});

describe("MCP Plugin Configuration", () => {
	it("supports custom path", async () => {
		const app = new Elysia()
			.get("/test", () => "ok", {
				detail: { mcp: true },
			})
			.use(mcp({ path: "/custom-mcp" }));

		// Should work on custom path
		const result = await mcpRequest(app, initRequest(), {}, "/custom-mcp");
		expect(result).toHaveProperty("result");
	});

	it("only registers POST on the MCP endpoint", async () => {
		const app = new Elysia()
			.get("/test", () => "ok", {
				detail: { mcp: true },
			})
			.use(mcp());

		// GET on /mcp should 404
		const getResponse = await app.handle(
			new Request("http://localhost/mcp", { method: "GET" }),
		);
		expect(getResponse.status).toBe(404);

		// DELETE on /mcp should 404
		const deleteResponse = await app.handle(
			new Request("http://localhost/mcp", { method: "DELETE" }),
		);
		expect(deleteResponse.status).toBe(404);
	});
});

describe("MCP Plugin Lifecycle Verification", () => {
	it("runs beforeHandle hooks on tool calls (e.g. auth)", async () => {
		const log: string[] = [];

		const app = new Elysia()
			.onBeforeHandle(({ request }) => {
				log.push(`beforeHandle:${new URL(request.url).pathname}`);
			})
			.get("/items", () => [{ id: 1 }], {
				detail: { mcp: true },
			})
			.use(mcp());

		// Trigger init
		await app.handle(new Request("http://localhost/health"));

		log.length = 0;
		await mcpRequest(app, initRequest());

		log.length = 0;
		await mcpRequest(app, callToolRequest("list_items"));

		// Should see beforeHandle for /mcp (the MCP endpoint itself)
		// AND for /items (the original route via app.handle())
		expect(log).toContain("beforeHandle:/mcp");
		expect(log).toContain("beforeHandle:/items");
	});

	it("runs derive hooks on tool calls, providing derived context", async () => {
		const app = new Elysia()
			.derive(() => ({ magic: 42 }))
			.get(
				"/magic",
				(ctx) => ({ value: (ctx as unknown as Record<string, unknown>).magic }),
				{
					detail: { mcp: true },
				},
			)
			.use(mcp());

		await app.handle(new Request("http://localhost/health"));

		await mcpRequest(app, initRequest());

		const result = (await mcpRequest(app, callToolRequest("list_magic"))) as {
			result: { content: Array<{ text: string }> };
		};

		const data = JSON.parse(result.result.content[0]!.text);
		expect(data.value).toBe(42);
	});

	it("forwards headers from MCP request to tool handler (auth propagation)", async () => {
		let capturedAuth: string | null = null;

		const app = new Elysia()
			.get(
				"/protected",
				({ request }) => {
					capturedAuth = request.headers.get("authorization");
					return { auth: capturedAuth };
				},
				{
					detail: { mcp: true },
				},
			)
			.use(mcp());

		await app.handle(new Request("http://localhost/health"));

		// Initialize
		await mcpRequest(app, initRequest(), { authorization: "Bearer test-token" });

		// Call tool with auth header
		const result = (await mcpRequest(
			app,
			callToolRequest("list_protected"),
			{ authorization: "Bearer test-token" },
		)) as {
			result: { content: Array<{ text: string }> };
		};

		const data = JSON.parse(result.result.content[0]!.text);
		expect(data.auth).toBe("Bearer test-token");
	});
});
