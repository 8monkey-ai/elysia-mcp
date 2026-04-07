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

/** The request part a property came from */
export type RequestPart = "params" | "query" | "body";

export interface PropertyOrigin {
  name: string;
  part: RequestPart;
}

type JsonObject = Record<string, unknown>;
export type SchemaLike =
  | (JsonObject & {
      type?: unknown;
      properties?: unknown;
      required?: unknown;
    })
  | null
  | undefined;

/** Result of schema flattening */
export interface FlattenResult {
  schema: FlatJsonSchema;
  origins: PropertyOrigin[];
  warnings: string[];
  hasBodyObjectSchema: boolean;
}

function asObjectRecord(value: unknown): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== "object") return undefined;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return value as JsonObject;
}

/**
 * Convert a schema value to a JSON Schema object.
 *
 * Handles two families:
 * - **JSON Schema / TypeBox** — already a plain JSON Schema object with
 *   `type`, `properties`, `required` etc. Returned as-is.
 * - **Standard Schema** (Zod ≥ 4, Valibot, ArkType, etc.) — detected via
 *   the `~standard.jsonSchema` convention and converted by calling the
 *   vendor's `input()` converter, which returns a proper JSON Schema object.
 */
export function asSchemaLike(value: unknown): SchemaLike {
  const record = asObjectRecord(value);
  if (record === undefined) return undefined;

  // Standard Schema detection: libraries like Zod 4 expose a
  // `~standard` property with a `jsonSchema` object containing an
  // `input()` function that returns the JSON Schema representation.
  const standard = asObjectRecord(record["~standard"]);
  if (standard !== undefined) {
    const jsonSchemaAccessor = asObjectRecord(standard["jsonSchema"]);
    if (jsonSchemaAccessor !== undefined && typeof jsonSchemaAccessor["input"] === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const toJsonSchema = jsonSchemaAccessor["input"] as () => unknown;
      const converted = asObjectRecord(toJsonSchema());
      if (converted !== undefined) return converted;
    }
  }

  return record;
}

function asObjectSchema(schema: SchemaLike): JsonObject | undefined {
  const record = asObjectRecord(schema);
  if (record === undefined) return undefined;
  return record;
}

/**
 * Extract JSON Schema properties from a TypeBox schema or plain JSON Schema object.
 *
 * TypeBox schemas *are* JSON Schema objects at runtime, so `schema.properties`
 * is the standard way to access them.
 */
function extractProperties(schema: SchemaLike): JsonObject | undefined {
  const objectSchema = asObjectSchema(schema);
  if (objectSchema?.["type"] === "object") {
    return asObjectRecord(objectSchema["properties"]);
  }

  return undefined;
}

/** Returns required field names from a JSON Schema object */
function extractRequired(schema: SchemaLike): Set<string> {
  const req = asObjectSchema(schema)?.["required"];
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
    params?: SchemaLike;
    query?: SchemaLike;
    body?: SchemaLike;
  },
): FlattenResult {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required = new Set<string>();
  const origins: PropertyOrigin[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, RequestPart>();
  const hasBodyObjectSchema = schemas.body?.["type"] === "object";

  const requestParts: RequestPart[] = ["params", "query", "body"];

  for (const requestPart of requestParts) {
    const raw = schemas[requestPart];
    if (raw === null || raw === undefined) continue;

    const props = extractProperties(raw);
    if (props === null || props === undefined) continue;

    const requiredSet = extractRequired(raw);

    for (const [name, rawProp] of Object.entries(props)) {
      const prop = asObjectRecord(rawProp) ?? {};

      // Collision detection
      const existing = seen.get(name);
      if (existing !== undefined) {
        warnings.push(
          `[mcp] Tool "${toolName}": property "${name}" exists in both ${existing} and ${requestPart} — ${requestPart} will take precedence`,
        );
      }
      seen.set(name, requestPart);

      // Missing description warning
      const description = typeof prop["description"] === "string" ? prop["description"] : undefined;
      if (description === undefined || description === "") {
        warnings.push(
          `[mcp] Tool "${toolName}": property "${name}" (${requestPart}) is missing a description`,
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
      if (requestPart === "params" || requiredSet.has(name)) {
        required.add(name);
      }

      origins.push({ name, part: requestPart });
    }
  }

  return {
    schema: { type: "object", properties, required: Array.from(required) },
    origins,
    warnings,
    hasBodyObjectSchema,
  };
}

/**
 * Extract and clean a response schema for use as an MCP `outputSchema`.
 *
 * MCP requires `outputSchema` to have `type: "object"` at the root.
 * This function handles three shapes from Elysia:
 * - A single schema with `type: "object"` → used directly
 * - A status-code map like `{ 200: schema, 201: schema, 400: schema }` → extracts
 *   the first object-valued schema among 200, 201, 202
 * - Anything else (arrays, primitives, missing) → returns undefined
 *
 * TypeBox-internal keys (starting with `[`) are stripped from properties.
 */
export function cleanResponseSchema(raw: unknown): FlatJsonSchema | undefined {
  const record = asObjectRecord(raw);
  if (record === undefined) return undefined;

  // Case 1: direct schema with type: "object"
  if (record["type"] === "object") {
    return stripInternalKeys(record);
  }

  // Case 2: status-code map — prefer 200, then 201, then 202
  const successStatuses = ["200", "201", "202"] as const;

  for (const status of successStatuses) {
    const candidate = asObjectRecord(asSchemaLike(record[status]));
    if (candidate !== undefined && candidate["type"] === "object") {
      return stripInternalKeys(candidate);
    }
  }

  return undefined;
}

/** Strip TypeBox-internal keys from a JSON Schema object and its properties */
function stripInternalKeys(schema: Record<string, unknown>): FlatJsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const rawProps = asObjectRecord(schema["properties"]);

  if (rawProps !== undefined) {
    for (const [name, rawProp] of Object.entries(rawProps)) {
      const prop = asObjectRecord(rawProp) ?? {};
      const clean: JsonSchemaProperty = {};
      for (const [k, v] of Object.entries(prop)) {
        if (typeof k !== "string" || k.startsWith("[")) continue;
        clean[k] = v;
      }
      properties[name] = clean;
    }
  }

  const req = schema["required"];
  const required = Array.isArray(req) ? req.filter((s): s is string => typeof s === "string") : [];

  return { type: "object", properties, required };
}

/**
 * Unflatten a flat args object back into { params, query, body } based on
 * the property origins from flattenSchemas.
 */
export function unflattenArgs(
  args: JsonObject,
  flatten: FlattenResult,
): {
  params: JsonObject;
  query: JsonObject;
  body: JsonObject | undefined;
} {
  const requestParts: Record<RequestPart, JsonObject> = {
    params: {},
    query: {},
    body: {},
  };

  for (const origin of flatten.origins) {
    if (Object.hasOwn(args, origin.name)) {
      requestParts[origin.part][origin.name] = args[origin.name];
    }
  }

  return {
    params: requestParts.params,
    query: requestParts.query,
    body: flatten.hasBodyObjectSchema ? requestParts.body : undefined,
  };
}
