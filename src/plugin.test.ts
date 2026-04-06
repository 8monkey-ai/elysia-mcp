import { beforeAll, describe, expect, it } from "bun:test";

import type { ListToolsResult, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Elysia, t } from "elysia";
import { z } from "zod";

import { mcp } from "./plugin.js";

// ─── MCP response types for test assertions ────────────────────────

/** JSON-RPC envelope wrapping the MCP SDK result types */
interface McpToolsListResponse {
  result: ListToolsResult;
}

interface McpToolCallResponse {
  result: CallToolResult;
}

interface McpErrorResponse {
  error: {
    code: number;
    message: string;
  };
}

/** Extract the text from the first MCP content item (narrowing the union). */
function firstText(result: McpToolCallResponse): string {
  const item = result.result.content[0];
  if (item?.type !== "text") throw new Error("Expected text content");
  return item.text;
}

/** Parse the first MCP content item as JSON and return a Record. */
function parseContent(result: McpToolCallResponse): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return JSON.parse(firstText(result)) as Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Minimal interface for the Elysia app used in tests */
interface ElysiaApp {
  handle(request: Request): Response | Promise<Response>;
}

/** Send a JSON-RPC request to the MCP endpoint and parse the JSON response */
async function mcpRequest<T = unknown>(
  app: ElysiaApp,
  body: unknown,
  headers?: Record<string, string>,
  path = "/mcp",
): Promise<T> {
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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return response.json() as T;
}

function initializeMcp(app: ElysiaApp, headers?: Record<string, string>, path = "/mcp") {
  return mcpRequest(app, initRequest(), headers, path);
}

function listTools(app: ElysiaApp, path = "/mcp") {
  return mcpRequest<McpToolsListResponse>(app, listToolsRequest(), undefined, path);
}

function callTool(
  app: ElysiaApp,
  name: string,
  args: Record<string, unknown> = {},
  headers?: Record<string, string>,
  path = "/mcp",
) {
  return mcpRequest<McpToolCallResponse>(app, callToolRequest(name, args), headers, path);
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
          active: t.Optional(t.Boolean({ description: "Filter by active status" })),
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
          operationId: "get_user",
          summary: "Get user by ID",
          mcp: true,
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return { requestId: (ctx as unknown as Record<string, unknown>)["requestId"] };
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
  let app: ElysiaApp;
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
    const result = await initializeMcp(app);
    expect(result).toHaveProperty("result");
  });

  it("lists discovered tools", async () => {
    await initializeMcp(app);
    const result = await listTools(app);

    const toolNames = result.result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("list_users");
    expect(toolNames).toContain("get_user");
    expect(toolNames).toContain("create_user");
    expect(toolNames).toContain("update_user");
    expect(toolNames).toContain("list_whoami");
    // Non-MCP route should NOT be listed
    expect(toolNames).not.toContain("list_health");
  });

  it("does not expose non-MCP routes as tools", async () => {
    await initializeMcp(app);
    const result = await listTools(app);
    const toolNames = result.result.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("list_health");
  });

  it("calls a GET tool and returns data", async () => {
    lifecycleLog.length = 0;
    await initializeMcp(app);
    const result = await callTool(app, "list_users");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = JSON.parse(firstText(result)) as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    expect(data[0]?.["name"]).toBe("Alice");
  });

  it("calls a GET tool with path parameters", async () => {
    await initializeMcp(app);
    const result = await callTool(app, "get_user", { id: "42" });

    const data = parseContent(result);
    expect(data["id"]).toBe("42");
    expect(data["name"]).toBe("Alice");
  });

  it("calls a POST tool with body", async () => {
    await initializeMcp(app);
    const result = await callTool(app, "create_user", {
      name: "Charlie",
      email: "charlie@example.com",
    });

    const data = parseContent(result);
    expect(data["name"]).toBe("Charlie");
    expect(data["email"]).toBe("charlie@example.com");
  });

  it("calls a PATCH tool with params and body", async () => {
    await initializeMcp(app);
    const result = await callTool(app, "update_user", { id: "42", name: "Updated" });

    const data = parseContent(result);
    expect(data["id"]).toBe("42");
    expect(data["name"]).toBe("Updated");
  });

  it("sends an empty JSON object for empty object body schemas", async () => {
    const testApp = new Elysia()
      .post(
        "/empty-body",
        ({ body }) => ({
          receivedBody: body,
          isObject: typeof body === "object" && body !== null,
        }),
        {
          body: t.Object({}),
          detail: { operationId: "create_empty_body", mcp: true },
        },
      )
      .use(mcp({ name: "test" }));

    await testApp.handle(new Request("http://localhost/health"));
    await initializeMcp(testApp);
    const result = await callTool(testApp, "create_empty_body");

    const data = parseContent(result);
    expect(data["receivedBody"]).toEqual({});
    expect(data["isObject"]).toBe(true);
  });

  it("sends an empty JSON object when all body fields are optional", async () => {
    const testApp = new Elysia()
      .patch(
        "/optional-body",
        ({ body }) => ({
          receivedBody: body,
          isObject: typeof body === "object" && body !== null,
        }),
        {
          body: t.Object({
            note: t.Optional(t.String({ description: "Optional note" })),
          }),
          detail: { operationId: "update_optional_body", mcp: true },
        },
      )
      .use(mcp({ name: "test" }));

    await testApp.handle(new Request("http://localhost/health"));
    await initializeMcp(testApp);
    const result = await callTool(testApp, "update_optional_body");

    const data = parseContent(result);
    expect(data["receivedBody"]).toEqual({});
    expect(data["isObject"]).toBe(true);
  });

  it("executes the full Elysia lifecycle (derive, beforeHandle, afterHandle)", async () => {
    lifecycleLog.length = 0;
    await initializeMcp(app);

    lifecycleLog.length = 0;
    await callTool(app, "list_whoami");

    // The lifecycle should have been executed for the synthetic request
    // derive → beforeHandle → handler → afterHandle
    expect(lifecycleLog).toContain("derive");
    expect(lifecycleLog).toContain("beforeHandle");
    expect(lifecycleLog).toContain("handler");
    expect(lifecycleLog).toContain("afterHandle");
  });

  it("provides derived context to handlers via app.handle()", async () => {
    await initializeMcp(app);
    const result = await callTool(app, "list_whoami");

    const data = parseContent(result);
    expect(data["requestId"]).toBe("req-123");
  });

  it("returns an error for unknown tools", async () => {
    await initializeMcp(app);
    const result = await mcpRequest<McpErrorResponse>(app, callToolRequest("nonexistent_tool"));

    expect(result.error.code).toBe(-32602);
    expect(result.error.message).toContain("Tool nonexistent_tool not found");
  });

  it("returns an error when required path params are missing", async () => {
    await initializeMcp(app);
    const result = await mcpRequest<McpErrorResponse>(app, callToolRequest("get_user"));

    expect(result.error.code).toBe(-32602);
    expect(result.error.message).toContain('Missing required path parameter "id"');
  });

  it("does not interfere with regular REST endpoints", async () => {
    const response = await app.handle(new Request("http://localhost/health"));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toEqual({ status: "ok" });
  });

  it("preserves tool descriptions from detail.summary", async () => {
    await initializeMcp(app);
    const result = await listTools(app);

    const listUsers = result.result.tools.find((tool) => tool.name === "list_users");
    expect(listUsers?.description).toBe("List all users");
  });

  it("uses detail.summary for tool descriptions", async () => {
    await initializeMcp(app);
    const result = await listTools(app);

    const getUser = result.result.tools.find((tool) => tool.name === "get_user");
    expect(getUser?.description).toBe("Get user by ID");
  });

  it("includes input schema with property descriptions", async () => {
    await initializeMcp(app);
    const result = await listTools(app);

    const getUser = result.result.tools.find((tool) => tool.name === "get_user");
    expect(getUser?.inputSchema.type).toBe("object");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const props = getUser?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    expect(props?.["id"]?.description).toBe("The user ID");
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
    await initializeMcp(app);
    const result = await listTools(app);
    const toolNames = result.result.tools.map((tool) => tool.name);
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
    await initializeMcp(app);
    const result = await listTools(app);
    const toolNames = result.result.tools.map((tool) => tool.name);
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
    const result = await initializeMcp(app, undefined, "/custom-mcp");
    expect(result).toHaveProperty("result");
  });

  it("only registers POST on the MCP endpoint", async () => {
    const app = new Elysia()
      .get("/test", () => "ok", {
        detail: { mcp: true },
      })
      .use(mcp());

    // GET on /mcp should 404
    const getResponse = await app.handle(new Request("http://localhost/mcp", { method: "GET" }));
    expect(getResponse.status).toBe(404);

    // DELETE on /mcp should 404
    const deleteResponse = await app.handle(
      new Request("http://localhost/mcp", { method: "DELETE" }),
    );
    expect(deleteResponse.status).toBe(404);
  });
});

describe("MCP Plugin outputSchema", () => {
  it("includes outputSchema for routes with type:object response schema", async () => {
    const app = new Elysia()
      .get("/user/:id", ({ params }) => ({ id: params["id"], name: "Alice" }), {
        params: t.Object({ id: t.String({ description: "User ID" }) }),
        response: t.Object({
          id: t.String({ description: "User ID" }),
          name: t.String({ description: "User name" }),
        }),
        detail: { mcp: true },
      })
      .use(mcp({ name: "test" }));

    await app.handle(new Request("http://localhost/health"));
    await initializeMcp(app);
    const result = await listTools(app);

    const found = result.result.tools.find((entry) => entry.name === "get_user");
    expect(found).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const outputSchema = (found as Record<string, unknown>)["outputSchema"] as
      | Record<string, unknown>
      | undefined;
    expect(outputSchema).toBeDefined();
    expect(outputSchema?.["type"]).toBe("object");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const props = outputSchema?.["properties"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(props?.["id"]?.["description"]).toBe("User ID");
    expect(props?.["name"]?.["description"]).toBe("User name");
  });

  it("does not include outputSchema for routes with array response schema", async () => {
    const app = new Elysia()
      .get("/users", () => [{ id: 1 }], {
        response: t.Array(t.Object({ id: t.Number() })),
        detail: { mcp: true },
      })
      .use(mcp({ name: "test" }));

    await app.handle(new Request("http://localhost/health"));
    await initializeMcp(app);
    const result = await listTools(app);

    const found = result.result.tools.find((entry) => entry.name === "list_users");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const outputSchema = (found as Record<string, unknown>)["outputSchema"];
    expect(outputSchema).toBeUndefined();
  });

  it("warns when response schema is not type:object", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      new Elysia()
        .get("/users", () => [{ id: 1 }], {
          response: t.Array(t.Object({ id: t.Number() })),
          detail: { mcp: true },
        })
        .use(mcp({ name: "test" }));

      expect(warnings.some((w) => w.includes("outputSchema omitted"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not warn when no response schema is defined", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      new Elysia()
        .get("/items", () => [{ id: 1 }], {
          detail: { mcp: true },
        })
        .use(mcp({ name: "test" }));

      expect(warnings.some((w) => w.includes("outputSchema omitted"))).toBe(false);
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not include outputSchema for routes without response schema", async () => {
    const app = new Elysia()
      .get("/items", () => [{ id: 1 }], {
        detail: { mcp: true },
      })
      .use(mcp({ name: "test" }));

    await app.handle(new Request("http://localhost/health"));
    await initializeMcp(app);
    const result = await listTools(app);

    const found = result.result.tools.find((entry) => entry.name === "list_items");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const outputSchema = (found as Record<string, unknown>)["outputSchema"];
    expect(outputSchema).toBeUndefined();
  });

  it("extracts 200 schema from status-code map", async () => {
    const app = new Elysia()
      .get("/status", () => ({ ok: true }), {
        response: {
          200: t.Object({ ok: t.Boolean({ description: "Status flag" }) }),
          500: t.Object({ error: t.String() }),
        },
        detail: { mcp: true },
      })
      .use(mcp({ name: "test" }));

    await app.handle(new Request("http://localhost/health"));
    await initializeMcp(app);
    const result = await listTools(app);

    const found = result.result.tools.find((entry) => entry.name === "list_status");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const outputSchema = (found as Record<string, unknown>)["outputSchema"] as
      | Record<string, unknown>
      | undefined;
    expect(outputSchema).toBeDefined();
    expect(outputSchema?.["type"]).toBe("object");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const props = outputSchema?.["properties"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(props?.["ok"]).toBeDefined();
    expect(props?.["error"]).toBeUndefined();
  });

  it("returns structuredContent when tool has outputSchema", async () => {
    const app = new Elysia()
      .get("/user/:id", ({ params }) => ({ id: params["id"], name: "Alice" }), {
        params: t.Object({ id: t.String({ description: "User ID" }) }),
        response: t.Object({
          id: t.String(),
          name: t.String(),
        }),
        detail: { mcp: true },
      })
      .use(mcp({ name: "test" }));

    await app.handle(new Request("http://localhost/health"));
    await initializeMcp(app);
    const result = await callTool(app, "get_user", { id: "42" });

    // Should have both content and structuredContent
    expect(result.result.content[0]?.type).toBe("text");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const structured = (result.result as Record<string, unknown>)["structuredContent"] as
      | Record<string, unknown>
      | undefined;
    expect(structured).toBeDefined();
    expect(structured?.["id"]).toBe("42");
    expect(structured?.["name"]).toBe("Alice");
  });

  it("does not return structuredContent when tool has no outputSchema", async () => {
    const app = new Elysia()
      .get("/items", () => ({ id: 1 }), {
        detail: { mcp: true },
      })
      .use(mcp({ name: "test" }));

    await app.handle(new Request("http://localhost/health"));
    await initializeMcp(app);
    const result = await callTool(app, "list_items");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const structured = (result.result as Record<string, unknown>)["structuredContent"];
    expect(structured).toBeUndefined();
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
    await initializeMcp(app);

    log.length = 0;
    await callTool(app, "list_items");

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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        (ctx) => ({ value: (ctx as unknown as Record<string, unknown>)["magic"] }),
        {
          detail: { mcp: true },
        },
      )
      .use(mcp());

    await app.handle(new Request("http://localhost/health"));

    await initializeMcp(app);

    const result = await callTool(app, "list_magic");

    const data = parseContent(result);
    expect(data["value"]).toBe(42);
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
    await initializeMcp(app, { authorization: "Bearer test-token" });

    // Call tool with auth header
    const result = await callTool(
      app,
      "list_protected",
      {},
      { authorization: "Bearer test-token" },
    );

    const data = parseContent(result);
    expect(data["auth"]).toBe("Bearer test-token");
  });
});

// ─── Zod / Standard Schema integration tests ───────────────────────

describe("MCP Plugin with Zod schemas", () => {
  let app: ElysiaApp;

  beforeAll(async () => {
    app = new Elysia()
      .get(
        "/products",
        () => [
          { id: 1, name: "Widget" },
          { id: 2, name: "Gadget" },
        ],
        {
          query: z.object({
            category: z.string().optional().describe("Filter by category"),
          }),
          detail: { summary: "List products", mcp: true },
        },
      )
      .get(
        "/products/:id",
        ({ params }) => ({ id: params["id"], name: "Widget", price: 9.99 }),
        {
          params: z.object({ id: z.string().describe("Product ID") }),
          response: z.object({
            id: z.string().describe("Product ID"),
            name: z.string().describe("Product name"),
            price: z.number().describe("Price in USD"),
          }),
          detail: { operationId: "get_product", summary: "Get product by ID", mcp: true },
        },
      )
      .post(
        "/products",
        ({ body }) => ({ id: 3, ...body }),
        {
          body: z.object({
            name: z.string().describe("Product name"),
            price: z.number().describe("Price in USD"),
          }),
          detail: { summary: "Create a product", mcp: true },
        },
      )
      .patch(
        "/products/:id",
        ({ params, body }) => ({ id: params["id"], ...body }),
        {
          params: z.object({ id: z.string().describe("Product ID") }),
          body: z.object({
            name: z.string().optional().describe("Updated name"),
            price: z.number().optional().describe("Updated price"),
          }),
          detail: { summary: "Update a product", mcp: true },
        },
      )
      .use(mcp({ name: "zod-test-api", version: "0.1.0" }));

    await app.handle(new Request("http://localhost/health"));
  });

  it("discovers Zod-based routes as tools", async () => {
    await initializeMcp(app);
    const result = await listTools(app);

    const toolNames = result.result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("list_products");
    expect(toolNames).toContain("get_product");
    expect(toolNames).toContain("create_product");
    expect(toolNames).toContain("update_product");
  });

  it("includes Zod-derived input schema with descriptions", async () => {
    await initializeMcp(app);
    const result = await listTools(app);

    const getProduct = result.result.tools.find((tool) => tool.name === "get_product");
    expect(getProduct).toBeDefined();
    expect(getProduct?.inputSchema.type).toBe("object");
    expect(getProduct?.inputSchema.required).toContain("id");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const props = getProduct?.inputSchema.properties as
      | Record<string, { description?: string; type?: string }>
      | undefined;
    expect(props?.["id"]?.type).toBe("string");
    expect(props?.["id"]?.description).toBe("Product ID");
  });

  it("merges Zod params + body into a flat input schema", async () => {
    await initializeMcp(app);
    const result = await listTools(app);

    const updateProduct = result.result.tools.find((tool) => tool.name === "update_product");
    expect(updateProduct).toBeDefined();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const props = updateProduct?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    expect(props).toHaveProperty("id"); // from params
    expect(props).toHaveProperty("name"); // from body
    expect(props).toHaveProperty("price"); // from body
    expect(props?.["id"]?.description).toBe("Product ID");
    expect(props?.["name"]?.description).toBe("Updated name");

    // id (params) should be required, name/price (optional body) should not
    expect(updateProduct?.inputSchema.required).toContain("id");
    expect(updateProduct?.inputSchema.required).not.toContain("name");
    expect(updateProduct?.inputSchema.required).not.toContain("price");
  });

  it("calls a Zod GET tool with path parameters", async () => {
    await initializeMcp(app);
    const result = await callTool(app, "get_product", { id: "42" });

    const data = parseContent(result);
    expect(data["id"]).toBe("42");
    expect(data["name"]).toBe("Widget");
    expect(data["price"]).toBe(9.99);
  });

  it("calls a Zod POST tool with body", async () => {
    await initializeMcp(app);
    const result = await callTool(app, "create_product", {
      name: "Sprocket",
      price: 4.99,
    });

    const data = parseContent(result);
    expect(data["name"]).toBe("Sprocket");
    expect(data["price"]).toBe(4.99);
  });

  it("calls a Zod PATCH tool with params and body", async () => {
    await initializeMcp(app);
    const result = await callTool(app, "update_product", {
      id: "42",
      name: "Updated Widget",
    });

    const data = parseContent(result);
    expect(data["id"]).toBe("42");
    expect(data["name"]).toBe("Updated Widget");
  });

  it("includes outputSchema from Zod response schema", async () => {
    await initializeMcp(app);
    const result = await listTools(app);

    const getProduct = result.result.tools.find((tool) => tool.name === "get_product");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const outputSchema = (getProduct as Record<string, unknown>)["outputSchema"] as
      | Record<string, unknown>
      | undefined;
    expect(outputSchema).toBeDefined();
    expect(outputSchema?.["type"]).toBe("object");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const props = outputSchema?.["properties"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(props?.["id"]?.["description"]).toBe("Product ID");
    expect(props?.["name"]?.["description"]).toBe("Product name");
    expect(props?.["price"]?.["description"]).toBe("Price in USD");
  });

  it("returns structuredContent for Zod tools with outputSchema", async () => {
    await initializeMcp(app);
    const result = await callTool(app, "get_product", { id: "7" });

    // Should have both content and structuredContent
    expect(result.result.content[0]?.type).toBe("text");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const structured = (result.result as Record<string, unknown>)["structuredContent"] as
      | Record<string, unknown>
      | undefined;
    expect(structured).toBeDefined();
    expect(structured?.["id"]).toBe("7");
    expect(structured?.["name"]).toBe("Widget");
    expect(structured?.["price"]).toBe(9.99);
  });
});

describe("MCP Plugin with mixed TypeBox and Zod schemas", () => {
  it("discovers tools from both TypeBox and Zod routes", async () => {
    const app = new Elysia()
      .get("/tb-route", () => ({ source: "typebox" }), {
        query: t.Object({ q: t.Optional(t.String({ description: "Query" })) }),
        detail: { summary: "TypeBox route", mcp: true },
      })
      .get("/zod-route", () => ({ source: "zod" }), {
        query: z.object({ q: z.string().optional().describe("Query") }),
        detail: { summary: "Zod route", mcp: true },
      })
      .use(mcp({ name: "mixed-test" }));

    await app.handle(new Request("http://localhost/health"));
    await initializeMcp(app);
    const result = await listTools(app);

    const toolNames = result.result.tools.map((tool) => tool.name);
    expect(toolNames).toContain("list_tb-route");
    expect(toolNames).toContain("list_zod-route");

    // Both should have the query parameter in their input schemas
    for (const name of ["list_tb-route", "list_zod-route"]) {
      const found = result.result.tools.find((tool) => tool.name === name);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const props = found?.inputSchema.properties as
        | Record<string, { description?: string }>
        | undefined;
      expect(props?.["q"]?.description).toBe("Query");
    }
  });

  it("calls both TypeBox and Zod tools in the same app", async () => {
    const app = new Elysia()
      .post("/tb-create", ({ body }) => ({ ...body, source: "typebox" }), {
        body: t.Object({ name: t.String({ description: "Name" }) }),
        detail: { operationId: "tb_create", mcp: true },
      })
      .post("/zod-create", ({ body }) => ({ ...body, source: "zod" }), {
        body: z.object({ name: z.string().describe("Name") }),
        detail: { operationId: "zod_create", mcp: true },
      })
      .use(mcp({ name: "mixed-test" }));

    await app.handle(new Request("http://localhost/health"));
    await initializeMcp(app);

    const tbResult = await callTool(app, "tb_create", { name: "TypeBox" });
    const tbData = parseContent(tbResult);
    expect(tbData["name"]).toBe("TypeBox");
    expect(tbData["source"]).toBe("typebox");

    const zodResult = await callTool(app, "zod_create", { name: "Zod" });
    const zodData = parseContent(zodResult);
    expect(zodData["name"]).toBe("Zod");
    expect(zodData["source"]).toBe("zod");
  });
});
