import { describe, expect, it } from "bun:test";

import { Type } from "@sinclair/typebox";

import { cleanResponseSchema, flattenSchemas, unflattenArgs } from "./schema.js";

describe("flattenSchemas", () => {
  it("merges params, query, and body into a flat schema", () => {
    const result = flattenSchemas("test_tool", {
      params: Type.Object({ id: Type.String({ description: "User ID" }) }),
      query: Type.Object({
        fields: Type.Optional(Type.String({ description: "Fields to include" })),
      }),
      body: Type.Object({ name: Type.String({ description: "User name" }) }),
    });

    expect(result.schema.properties).toHaveProperty("id");
    expect(result.schema.properties).toHaveProperty("fields");
    expect(result.schema.properties).toHaveProperty("name");
    expect(result.schema.required).toContain("id"); // params always required
    expect(result.schema.required).toContain("name"); // body required field
    expect(result.schema.required).not.toContain("fields"); // optional query param
    expect(result.hasBodyObjectSchema).toBe(true);
  });

  it("preserves property descriptions", () => {
    const result = flattenSchemas("test_tool", {
      params: Type.Object({ id: Type.String({ description: "The user ID" }) }),
    });

    expect(result.schema.properties["id"]?.description).toBe("The user ID");
  });

  it("warns on name collisions", () => {
    const result = flattenSchemas("test_tool", {
      params: Type.Object({ id: Type.String({ description: "Param ID" }) }),
      body: Type.Object({ id: Type.String({ description: "Body ID" }) }),
    });

    expect(
      result.warnings.some((w) => w.includes("collision") || w.includes("exists in both")),
    ).toBe(true);
  });

  it("warns on missing descriptions", () => {
    const result = flattenSchemas("test_tool", {
      params: Type.Object({ id: Type.String() }),
    });

    expect(result.warnings.some((w) => w.includes("missing a description"))).toBe(true);
  });

  it("handles empty schemas", () => {
    const result = flattenSchemas("test_tool", {});

    expect(result.schema.properties).toEqual({});
    expect(result.schema.required).toEqual([]);
    expect(result.hasBodyObjectSchema).toBe(false);
  });

  it("handles null/undefined schemas", () => {
    const result = flattenSchemas("test_tool", {
      params: undefined,
      query: undefined,
      body: undefined,
    });

    expect(result.schema.properties).toEqual({});
    expect(result.hasBodyObjectSchema).toBe(false);
  });

  it("tracks empty object body schemas even without flattened fields", () => {
    const result = flattenSchemas("test_tool", {
      body: Type.Object({}),
    });

    expect(result.schema.properties).toEqual({});
    expect(result.hasBodyObjectSchema).toBe(true);
  });
});

describe("unflattenArgs", () => {
  it("splits flat args back into params, query, and body", () => {
    const flatten = flattenSchemas("test_tool", {
      params: Type.Object({ id: Type.String({ description: "ID" }) }),
      query: Type.Object({ fields: Type.Optional(Type.String({ description: "Fields" })) }),
      body: Type.Object({ name: Type.String({ description: "Name" }) }),
    });

    const result = unflattenArgs({ id: "123", fields: "name,email", name: "Alice" }, flatten);

    expect(result.params).toEqual({ id: "123" });
    expect(result.query).toEqual({ fields: "name,email" });
    expect(result.body).toEqual({ name: "Alice" });
  });

  it("handles missing optional args", () => {
    const flatten = flattenSchemas("test_tool", {
      params: Type.Object({ id: Type.String({ description: "ID" }) }),
      query: Type.Object({ fields: Type.Optional(Type.String({ description: "Fields" })) }),
    });

    const result = unflattenArgs({ id: "123" }, flatten);

    expect(result.params).toEqual({ id: "123" });
    expect(result.query).toEqual({});
    expect(result.body).toBeUndefined();
  });

  it("returns an empty body object when an object body schema exists", () => {
    const flatten = flattenSchemas("test_tool", {
      body: Type.Object({
        note: Type.Optional(Type.String({ description: "Note" })),
      }),
    });

    const result = unflattenArgs({}, flatten);

    expect(result.body).toEqual({});
  });
});

describe("cleanResponseSchema", () => {
  it("returns a type:object schema directly", () => {
    const schema = Type.Object({
      id: Type.String({ description: "The ID" }),
      name: Type.String({ description: "The name" }),
    });

    const result = cleanResponseSchema(schema);
    expect(result).toBeDefined();
    expect(result?.type).toBe("object");
    expect(result?.properties).toHaveProperty("id");
    expect(result?.properties).toHaveProperty("name");
    expect(result?.properties["id"]?.description).toBe("The ID");
    expect(result?.required).toContain("id");
    expect(result?.required).toContain("name");
  });

  it("extracts the 200 schema from a status-code map", () => {
    const schema = {
      200: Type.Object({ ok: Type.Boolean() }),
      500: Type.Object({ error: Type.String() }),
    };

    const result = cleanResponseSchema(schema);
    expect(result).toBeDefined();
    expect(result?.type).toBe("object");
    expect(result?.properties).toHaveProperty("ok");
    expect(result?.properties).not.toHaveProperty("error");
  });

  it("falls back to an object-valued 2xx schema when 200 is absent", () => {
    const schema = {
      201: Type.Object({ id: Type.String() }),
      202: Type.Object({ accepted: Type.Boolean() }),
      400: Type.Object({ error: Type.String() }),
    };

    const result = cleanResponseSchema(schema);
    expect(result).toBeDefined();
    expect(result?.type).toBe("object");
    expect(result?.properties).toHaveProperty("id");
    expect(result?.properties).not.toHaveProperty("accepted");
    expect(result?.properties).not.toHaveProperty("error");
  });

  it("returns undefined for array schemas", () => {
    const schema = Type.Array(Type.Object({ id: Type.Number() }));
    expect(cleanResponseSchema(schema)).toBeUndefined();
  });

  it("returns undefined for null/undefined", () => {
    expect(cleanResponseSchema(null)).toBeUndefined();
    // eslint-disable-next-line unicorn/no-useless-undefined
    expect(cleanResponseSchema(undefined)).toBeUndefined();
  });

  it("strips TypeBox-internal keys from properties", () => {
    const schema = Type.Object({ id: Type.String() });
    const result = cleanResponseSchema(schema);

    // TypeBox adds Symbol keys and [Kind]/[Hint] string keys.
    // Verify no keys start with "[" in the cleaned properties.
    for (const prop of Object.values(result?.properties ?? {})) {
      for (const key of Object.keys(prop)) {
        expect(key.startsWith("[")).toBe(false);
      }
    }
  });
});
