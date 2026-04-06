# @8monkey/elysia-mcp

Turn your existing Elysia routes into MCP tools — no manual registration, no schema duplication, no handler rewrites.

## Why?

The [Model Context Protocol](https://modelcontextprotocol.io/) lets AI agents discover and call tools over a standard JSON-RPC interface. If you already have an Elysia API with typed schemas and handlers, you shouldn't have to rewrite all of that as MCP tool definitions.

`@8monkey/elysia-mcp` bridges the gap: opt in a route with `detail: { mcp: true }`, call `.use(mcp())`, and every opted-in endpoint becomes a callable MCP tool — with its name, description, and input schema derived from what you already wrote.

## How it differs from existing solutions

| | **@8monkey/elysia-mcp** | [kerlos/elysia-mcp](https://github.com/kerlos/elysia-mcp) | [keithagroves/Elysia-mcp](https://github.com/keithagroves/Elysia-mcp) |
|---|---|---|---|
| **Approach** | Auto-discovers existing routes | Manual tool/resource/prompt registration via setup callback | Manual McpServer + SSE transport wiring |
| **Schema source** | Reuses your route's params/query/body schemas | Separate Zod schemas per tool | Separate Zod schemas per tool |
| **Handler reuse** | Routes run through the full Elysia lifecycle (`app.handle()`) | Standalone handler functions | Standalone handler functions |
| **Tool naming** | Auto-generated from HTTP method + path (with override) | Manually specified | Manually specified |
| **Transport** | Streamable HTTP (stateless, one POST endpoint) | Streamable HTTP (stateful, session management) | SSE (Server-Sent Events) |
| **Opt-in model** | Per-route via `detail.mcp` | All-or-nothing in setup callback | All-or-nothing in setup callback |
| **MCP scope** | Tools only (v1) | Tools, Resources, Prompts, Logging | Tools, Resources, Prompts |

The core philosophy: **your REST API _is_ the source of truth**. Other plugins ask you to define tools separately from your routes. This one treats your routes as the tool definitions.

## Key highlights

- **Zero duplication** — tool names, descriptions, and input schemas are derived from your existing route definitions
- **Full lifecycle** — MCP tool calls go through `app.handle()`, so derive, resolve, beforeHandle, afterHandle, error hooks, and all plugins run exactly as they do for normal HTTP requests
- **Header forwarding** — auth tokens, cookies, and other headers from the MCP request are forwarded to tool invocations, so your existing auth middleware works without changes
- **Schema flattening** — params, query, and body schemas are merged into a single flat MCP input schema with property origins tracked for correct unflattening
- **Startup diagnostics** — warns on name collisions across params/query/body, missing property descriptions, and duplicate tool names
- **Response unwrapping** — automatically unwraps Elysia `status()` responses so MCP clients receive clean data
- **Smart naming** — `GET /users` becomes `list_users`, `GET /users/:id` becomes `get_user`, `POST /users` becomes `create_user`, and nested paths like `GET /users/:uid/posts` become `list_user_posts`

## Install

```bash
bun add @8monkey/elysia-mcp
```

Peer dependency: `elysia >= 1.0.0`

## Quick start

```typescript
import { Elysia, t } from "elysia";
import { mcp } from "@8monkey/elysia-mcp";

const app = new Elysia()
  .get("/users", () => [{ id: 1, name: "Alice" }], {
    detail: { summary: "List all users", mcp: true },
  })
  .get("/users/:id", ({ params: { id } }) => ({ id, name: "Alice" }), {
    params: t.Object({
      id: t.String({ description: "The user's unique ID" }),
    }),
    detail: { summary: "Get user by ID", mcp: true },
  })
  .post("/users", ({ body }) => ({ id: 2, ...body }), {
    body: t.Object({
      name: t.String({ description: "Display name" }),
      email: t.String({ description: "Email address" }),
    }),
    detail: { summary: "Create a user", mcp: true },
  })
  // .use(mcp()) must come after all MCP-eligible routes
  .use(mcp({ name: "my-api", version: "1.0.0" }))
  .listen(3000);
```

This exposes a `POST /mcp` endpoint that speaks the MCP JSON-RPC protocol. An MCP client calling `tools/list` will see:

| Tool | Description |
|---|---|
| `list_users` | List all users |
| `get_user` | Get user by ID |
| `create_user` | Create a user |

## Configuration

```typescript
mcp({
  name: "my-api",     // MCP server name (default: "elysia-mcp")
  version: "1.0.0",   // MCP server version (default: "1.0.0")
  path: "/mcp",       // Endpoint path (default: "/mcp")
})
```

## Route opt-in

Add `mcp: true` to a route's `detail` to expose it as a tool:

```typescript
.get("/items", handler, {
  detail: { mcp: true },
})
```

Override the auto-generated name or description:

```typescript
.get("/items", handler, {
  detail: {
    mcp: { name: "search_items", description: "Full-text search across all items" },
  },
})
```

Routes without `detail.mcp` are left untouched — they continue working as normal REST endpoints.

## Tool naming conventions

| Method + Path | Generated Name |
|---|---|
| `GET /users` | `list_users` |
| `GET /users/:id` | `get_user` |
| `POST /users` | `create_user` |
| `PATCH /users/:id` | `update_user` |
| `PUT /users/:id` | `update_user` |
| `DELETE /users/:id` | `delete_user` |
| `GET /users/:uid/posts` | `list_user_posts` |
| `GET /users/:uid/posts/:id` | `get_user_post` |

## Schema flattening

MCP tools accept a single flat input object. The plugin merges `params`, `query`, and `body` into one schema:

```
Route: PATCH /users/:id  (params: { id }, query: { fields }, body: { name, email })
  ↓
MCP Tool Input: { id: string, fields?: string, name: string, email: string }
```

Property descriptions from TypeBox (or any Standard Schema-compatible library) are preserved. The plugin warns at startup if properties collide across buckets or lack descriptions.

## How tool calls work

When an MCP client calls a tool:

1. The flat args are unflattened back into `params`, `query`, and `body`
2. A synthetic HTTP request is built with the correct method, path, query string, body, and headers from the original MCP request
3. `app.handle(request)` runs the full Elysia lifecycle — derive, resolve, beforeHandle, the handler, afterHandle, and error hooks
4. The response is unwrapped (handles `status()` wrappers) and returned as MCP content

This means your auth middleware, rate limiting, validation, and every other plugin work exactly the same for MCP calls as they do for REST calls.

## Connecting an MCP client

Point any MCP-compatible client at your `/mcp` endpoint. For example, with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector --transport http http://localhost:3000/mcp
```

Or configure it in Claude Desktop, Cursor, or any other MCP-enabled tool as an HTTP MCP server at `http://localhost:3000/mcp`.

## Important notes

- **Plugin order matters**: `.use(mcp())` must come after all MCP-eligible routes, since route discovery happens at mount time. This is the same pattern as other Elysia plugins (e.g., `derive` must precede routes that use it).
- **Tools only (v1)**: This plugin exposes MCP tools. Resources and prompts are not supported yet.
- **Stateless transport**: Each request gets its own transport instance — no session tracking or SSE connections to manage.

## License

MIT
