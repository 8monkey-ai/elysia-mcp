/**
 * Response unwrapping utilities.
 *
 * Elysia handlers may return responses wrapped in `status(code, data)`.
 * This module extracts the raw data for MCP JSON serialisation.
 */

/** Symbol used by Elysia's status() helper to wrap responses */
const STATUS_SYMBOL = Symbol.for("ElysiaCustomStatusResponse");

/**
 * Unwrap an Elysia `status()` response to get the raw data.
 * If the value is not a status wrapper, returns it unchanged.
 */
export function unwrapStatus(value: unknown): unknown {
	if (value == null || typeof value !== "object") return value;

	// Elysia's status() returns an object with [Symbol.for('ElysiaCustomStatusResponse')]
	const record = value as Record<string | symbol, unknown>;
	if (STATUS_SYMBOL in record) {
		return record["response"];
	}

	return value;
}

/**
 * Format a handler result as MCP tool content.
 * Always returns `{ content: [{ type: "text", text: string }] }`.
 */
export function toMcpContent(data: unknown): {
	content: Array<{ type: "text"; text: string }>;
} {
	const unwrapped = unwrapStatus(data);
	const text = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);

	return {
		content: [{ type: "text" as const, text }],
	};
}
