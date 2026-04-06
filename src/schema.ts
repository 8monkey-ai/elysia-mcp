/**
 * Schema flattening for MCP tool input schemas.
 *
 * Merges params, query, and body TypeBox/JSON-Schema objects into a single
 * flat JSON Schema object suitable for MCP tool registration.
 */

/** A simple JSON Schema property descriptor */
export interface JsonSchemaProperty {
	type?: string;
	description?: string;
	default?: unknown;
	enum?: unknown[];
	[key: string]: unknown;
}

/** A flat JSON Schema object (type: "object") */
export interface FlatJsonSchema {
	type: "object";
	properties: Record<string, JsonSchemaProperty>;
	required: string[];
}

/** The source bucket a property came from */
type Bucket = "params" | "query" | "body";

/** Information about a flattened property (for unflattening later) */
export interface PropertyOrigin {
	name: string;
	bucket: Bucket;
}

/** Result of schema flattening */
export interface FlattenResult {
	schema: FlatJsonSchema;
	origins: PropertyOrigin[];
	warnings: string[];
}

/**
 * Extract JSON Schema properties from a TypeBox schema or plain JSON Schema object.
 *
 * TypeBox schemas *are* JSON Schema objects at runtime, so `schema.properties`
 * is the standard way to access them.
 */
function extractProperties(
	schema: unknown,
): Record<string, unknown> | undefined {
	if (schema === null || schema === undefined || typeof schema !== "object") return undefined;

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const s = schema as Record<string, unknown>;
	if (s["type"] === "object" && typeof s["properties"] === "object" && s["properties"] !== null) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return s["properties"] as Record<string, unknown>;
	}

	return undefined;
}

/** Returns required field names from a JSON Schema object */
function extractRequired(schema: unknown): Set<string> {
	if (schema === null || schema === undefined || typeof schema !== "object") return new Set();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const req = (schema as Record<string, unknown>)["required"];
	if (Array.isArray(req)) {
		const strings = req.filter((s): s is string => typeof s === "string");
		return new Set(strings);
	}
	return new Set();
}

/**
 * Flatten params, query, and body schemas into a single JSON Schema object.
 *
 * - Preserves property descriptions from the schema metadata
 * - Warns on name collisions across buckets
 * - Warns on properties missing descriptions
 */
export function flattenSchemas(
	toolName: string,
	schemas: {
		params?: unknown;
		query?: unknown;
		body?: unknown;
	},
): FlattenResult {
	const properties: Record<string, JsonSchemaProperty> = {};
	const required: string[] = [];
	const origins: PropertyOrigin[] = [];
	const warnings: string[] = [];
	const seen = new Map<string, Bucket>();

	const buckets: Bucket[] = ["params", "query", "body"];

	for (const bucket of buckets) {
		const raw = schemas[bucket];
		if (raw === null || raw === undefined) continue;

		const props = extractProperties(raw);
		if (props === null || props === undefined) continue;

		const requiredSet = extractRequired(raw);

		for (const [name, rawProp] of Object.entries(props)) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const prop = (typeof rawProp === "object" && rawProp !== null ? rawProp : {}) as Record<string, unknown>;

			// Collision detection
			const existing = seen.get(name);
			if (existing !== undefined) {
				warnings.push(
					`[mcp] Tool "${toolName}": property "${name}" exists in both ${existing} and ${bucket} — ${bucket} will take precedence`,
				);
			}
			seen.set(name, bucket);

			// Missing description warning
			const description = typeof prop["description"] === "string" ? prop["description"] : undefined;
			if (description === undefined || description === "") {
				warnings.push(
					`[mcp] Tool "${toolName}": property "${name}" (${bucket}) is missing a description`,
				);
			}

			// Copy property, stripping TypeBox-internal symbols
			const clean: JsonSchemaProperty = {};
			for (const [k, v] of Object.entries(prop)) {
				if (typeof k !== "string" || k.startsWith("[")) continue;
				clean[k] = v;
			}
			properties[name] = clean;

			// All params are required; query/body follow the schema's required array
			if (bucket === "params" || requiredSet.has(name)) {
				required.push(name);
			}

			origins.push({ name, bucket });
		}
	}

	return {
		schema: { type: "object", properties, required },
		origins,
		warnings,
	};
}

/**
 * Unflatten a flat args object back into { params, query, body } based on
 * the property origins from flattenSchemas.
 */
export function unflattenArgs(
	args: Record<string, unknown>,
	origins: PropertyOrigin[],
): { params: Record<string, unknown>; query: Record<string, unknown>; body: Record<string, unknown> } {
	const params: Record<string, unknown> = {};
	const query: Record<string, unknown> = {};
	const body: Record<string, unknown> = {};

	const bucketMap: Record<Bucket, Record<string, unknown>> = { params, query, body };

	for (const origin of origins) {
		if (origin.name in args) {
			bucketMap[origin.bucket][origin.name] = args[origin.name];
		}
	}

	return { params, query, body };
}
