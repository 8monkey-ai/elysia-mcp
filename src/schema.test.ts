import { describe, expect, it } from "bun:test";

import { Type } from "@sinclair/typebox";

import { flattenSchemas, unflattenArgs } from "./schema.js";

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
  });

  it("handles null/undefined schemas", () => {
    const result = flattenSchemas("test_tool", {
      params: undefined,
      query: undefined,
      body: undefined,
    });

    expect(result.schema.properties).toEqual({});
  });
});

describe("unflattenArgs", () => {
  it("splits flat args back into params, query, and body", () => {
    const { origins } = flattenSchemas("test_tool", {
      params: Type.Object({ id: Type.String({ description: "ID" }) }),
      query: Type.Object({ fields: Type.Optional(Type.String({ description: "Fields" })) }),
      body: Type.Object({ name: Type.String({ description: "Name" }) }),
    });

    const result = unflattenArgs({ id: "123", fields: "name,email", name: "Alice" }, origins);

    expect(result.params).toEqual({ id: "123" });
    expect(result.query).toEqual({ fields: "name,email" });
    expect(result.body).toEqual({ name: "Alice" });
  });

  it("handles missing optional args", () => {
    const { origins } = flattenSchemas("test_tool", {
      params: Type.Object({ id: Type.String({ description: "ID" }) }),
      query: Type.Object({ fields: Type.Optional(Type.String({ description: "Fields" })) }),
    });

    const result = unflattenArgs({ id: "123" }, origins);

    expect(result.params).toEqual({ id: "123" });
    expect(result.query).toEqual({});
  });
});
