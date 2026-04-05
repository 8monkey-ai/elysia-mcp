/**
 * Auto-generates MCP tool names from HTTP method + path.
 *
 * Convention:
 *   GET /collection         → list_collection
 *   GET /collection/:id     → get_singular
 *   POST /collection        → create_singular
 *   PATCH /collection/:id   → update_singular
 *   PUT /collection/:id     → replace_singular
 *   DELETE /collection/:id  → delete_singular
 *
 * Nested paths include all non-parameter segments:
 *   GET /users/:userId/posts → list_user_posts
 */

const VERB_MAP: Record<string, { withParam: string; withoutParam: string }> = {
	GET: { withParam: "get", withoutParam: "list" },
	POST: { withParam: "create", withoutParam: "create" },
	PATCH: { withParam: "update", withoutParam: "update" },
	PUT: { withParam: "replace", withoutParam: "replace" },
	DELETE: { withParam: "delete", withoutParam: "delete" },
};

function singularize(word: string): string {
	if (word.endsWith("ies")) return word.slice(0, -3) + "y";
	if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes") || word.endsWith("ches") || word.endsWith("shes")) return word.slice(0, -2);
	if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
	return word;
}

/**
 * Determines whether the route ends with a path parameter (e.g. `/users/:id`).
 */
function endsWithParam(path: string): boolean {
	const last = path.split("/").pop();
	return last?.startsWith(":") ?? false;
}

export function generateToolName(method: string, path: string): string {
	const upper = method.toUpperCase();
	const mapping = VERB_MAP[upper];
	if (!mapping) {
		// Fallback for HEAD, OPTIONS, etc.
		return `${upper.toLowerCase()}_${path.replace(/[/:]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}`;
	}

	const hasTrailingParam = endsWithParam(path);
	const verb = hasTrailingParam ? mapping.withParam : mapping.withoutParam;

	// Collect non-parameter segments (skip leading empty string from split)
	const segments = path
		.split("/")
		.filter((s) => s.length > 0 && !s.startsWith(":"));

	if (segments.length === 0) {
		return `${verb}_root`;
	}

	// For "get"/"update"/"delete" (single-resource verbs), singularize the last segment
	// For "list"/"create" on a collection, keep as-is
	const needsSingular = hasTrailingParam;

	const parts = segments.map((seg, i) => {
		// Singularize all segments when targeting a single resource,
		// except keep the last one for "list" operations
		if (needsSingular || i < segments.length - 1) {
			return singularize(seg);
		}
		return seg;
	});

	return `${verb}_${parts.join("_")}`;
}
