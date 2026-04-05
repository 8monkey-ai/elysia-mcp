/**
 * Schema flattening utilities.
 *
 * MCP tools have a single flat input object. This module merges `params`,
 * `query`, and `body` JSON schemas into one flat object schema while
 * preserving property descriptions.
 */

export interface JsonSchemaObject {
	type: "object";
	properties?: Record<string, Record<string, unknown>>;
	required?: string[];
}

interface FlattenResult {
	schema: JsonSchemaObject;
	/** Maps property name → which source it came from (params | query | body) */
	sourceMap: Record<string, "params" | "query" | "body">;
	/** Property names that collide across sources */
	collisions: string[];
}

/**
 * Extracts a JSON Schema representation from a TypeBox / Standard Schema
 * compatible schema value.
 *
 * TypeBox schemas *are* JSON Schema objects at runtime, so we can read
 * `.properties`, `.required`, `.type` directly. For Standard Schema
 * implementations that expose `~standard.types`, we fall back to checking
 * for a `toJsonSchema()` helper or treating the value itself as JSON Schema.
 */
export function toJsonSchemaObject(schema: unknown): JsonSchemaObject | null {
	if (schema == null || typeof schema !== "object") return null;

	const s = schema as Record<string, unknown>;

	// TypeBox schemas are plain JSON Schema objects
	if (s["type"] === "object" && typeof s["properties"] === "object") {
		return s as unknown as JsonSchemaObject;
	}

	return null;
}

/**
 * Flattens params, query, and body schemas into a single flat JSON Schema
 * object for use as an MCP tool's inputSchema.
 */
export function flattenSchemas(
	params: unknown,
	query: unknown,
	body: unknown,
): FlattenResult {
	const properties: Record<string, Record<string, unknown>> = {};
	const required: string[] = [];
	const sourceMap: Record<string, "params" | "query" | "body"> = {};
	const collisions: string[] = [];

	const sources = [
		{ key: "params" as const, schema: toJsonSchemaObject(params) },
		{ key: "query" as const, schema: toJsonSchemaObject(query) },
		{ key: "body" as const, schema: toJsonSchemaObject(body) },
	];

	for (const { key, schema } of sources) {
		if (!schema?.properties) continue;

		for (const [prop, def] of Object.entries(schema.properties)) {
			if (prop in properties) {
				collisions.push(prop);
				continue; // First source wins
			}
			properties[prop] = def;
			sourceMap[prop] = key;
		}

		if (schema.required) {
			for (const r of schema.required) {
				if (!(r in properties)) continue; // skip collided
				if (!required.includes(r)) required.push(r);
			}
		}
	}

	return {
		schema: {
			type: "object" as const,
			...(Object.keys(properties).length > 0 ? { properties } : {}),
			...(required.length > 0 ? { required } : {}),
		},
		sourceMap,
		collisions,
	};
}

/**
 * Un-flattens MCP tool arguments back into params, query, and body shapes
 * using the source map built during schema flattening.
 */
export function unflattenArgs(
	args: Record<string, unknown>,
	sourceMap: Record<string, "params" | "query" | "body">,
): {
	params: Record<string, unknown>;
	query: Record<string, unknown>;
	body: Record<string, unknown>;
} {
	const params: Record<string, unknown> = {};
	const query: Record<string, unknown> = {};
	const body: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(args)) {
		const source = sourceMap[key];
		switch (source) {
			case "params":
				params[key] = value;
				break;
			case "query":
				query[key] = value;
				break;
			case "body":
				body[key] = value;
				break;
			default:
				// Unknown property - put in body as fallback
				body[key] = value;
		}
	}

	return { params, query, body };
}

/**
 * Returns property names that lack a `description` field in the JSON Schema.
 */
export function findMissingDescriptions(schema: JsonSchemaObject): string[] {
	if (!schema.properties) return [];
	const missing: string[] = [];
	for (const [name, def] of Object.entries(schema.properties)) {
		if (!def["description"]) {
			missing.push(name);
		}
	}
	return missing;
}
