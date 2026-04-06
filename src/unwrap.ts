/**
 * Response unwrapping utilities.
 *
 * Elysia handlers may return responses wrapped in `status(code, data)`.
 * This module extracts the raw data for MCP JSON serialisation.
 */

import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { ElysiaCustomStatusResponse } from "elysia";

/** Symbol used by Elysia's status() helper to wrap responses */
const STATUS_SYMBOL = Symbol.for("ElysiaCustomStatusResponse");
type StatusResponse = Pick<ElysiaCustomStatusResponse<number, unknown>, "response">;
type McpTextContent = { content: TextContent[] };

function isStatusResponse(value: unknown): value is StatusResponse {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    STATUS_SYMBOL in value &&
    "response" in value
  );
}

function toTextContent(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Unwrap an Elysia `status()` response to get the raw data.
 * If the value is not a status wrapper, returns it unchanged.
 */
export function unwrapStatus(value: unknown): unknown {
  return isStatusResponse(value) ? value.response : value;
}

/**
 * Format a handler result as MCP tool content.
 * Always returns `{ content: [{ type: "text", text: string }] }`.
 */
export function toMcpContent(data: unknown): McpTextContent {
  const unwrapped = unwrapStatus(data);
  let text: string;
  if (typeof unwrapped === "string") {
    text = unwrapped;
  } else {
    try {
      text = JSON.stringify(unwrapped);
    } catch {
      text = String(unwrapped);
    }
  }

  return {
    content: [toTextContent(text)],
  };
}
