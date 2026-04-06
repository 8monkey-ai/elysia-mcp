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
}

function asObjectRecord(value: unknown): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== "object") return undefined;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return value as JsonObject;
}

export function asSchemaLike(value: unknown): SchemaLike {
  return asObjectRecord(value);
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
  const required: string[] = [];
  const origins: PropertyOrigin[] = [];
  const warnings: string[] = [];

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
      const existing = origins.find((origin) => origin.name === name)?.part;
      if (existing !== undefined) {
        warnings.push(
          `[mcp] Tool "${toolName}": property "${name}" exists in both ${existing} and ${requestPart} — ${requestPart} will take precedence`,
        );
      }

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
        required.push(name);
      }

      origins.push({ name, part: requestPart });
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
  args: JsonObject,
  origins: PropertyOrigin[],
): {
  params: JsonObject;
  query: JsonObject;
  body: JsonObject;
} {
  const requestParts: Record<RequestPart, JsonObject> = {
    params: {},
    query: {},
    body: {},
  };

  for (const origin of origins) {
    if (origin.name in args) {
      requestParts[origin.part][origin.name] = args[origin.name];
    }
  }

  return requestParts;
}
