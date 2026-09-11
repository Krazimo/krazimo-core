/**
 * A retrieval strategy is a knowledge base plus the tools that read it.
 *
 * Index-walking is the strategy this engine was built around, and it is the one
 * that can refuse structurally: `open` rejects a path that no listing ever
 * offered, so an answer either came from a document the model actually read or
 * it did not happen. Vector retrieval has no such property — nearest neighbours
 * are always returned, however far away they are — so a vector strategy has to
 * reconstruct refusal from a score threshold and a groundedness check.
 *
 * That difference is why the strategy owns its own tool set rather than
 * implementing a shared `search()` interface. The tools are the contract the
 * model sees, and flattening them would erase the guarantee.
 */

/** A single readable unit inside a knowledge base. */
export interface Document {
	/** Path relative to the knowledge base root, e.g. `products/needs/sleep.md`. */
	path: string;
	text: string;
}

/** Where an answer came from, for the caller to render and for evals to check. */
export interface Citation {
	path: string;
	title: string;
	/**
	 * The rest of the front matter, when the document carries it.
	 *
	 * The parser already reads these and used to throw them away, which meant a
	 * caller could show a title but not link to the original or say how
	 * authoritative it was — and an application storing which asset an answer
	 * cited had nothing to key on. Optional, because a library is not required
	 * to have an asset registry behind it.
	 */
	id?: number;
	url?: string;
	authority?: string;
}

/**
 * The outcome of one tool call.
 *
 * `refused` and `resolved` are first-class rather than error strings because
 * they are the interesting ones: how often a strategy refuses is a health
 * metric, and a resolved near-miss records that the model asked for a path that
 * did not exist and was corrected.
 */
export type ToolOutcome = "ok" | "refused" | "resolved" | "error";

export interface ToolResult {
	outcome: ToolOutcome;
	/** What was actually read, when that differs from what was asked for. */
	target?: string;
	text: string;
}

/**
 * A tool exactly as the model sees it, before it is adapted to a model SDK.
 *
 * Kept SDK-agnostic so the same definition can be handed to the AI SDK, exposed
 * over MCP, or called directly from a test.
 */
export interface ToolSpec<Args = Record<string, unknown>> {
	name: string;
	description: string;
	/** JSON Schema for the arguments. */
	parameters: Record<string, unknown>;
	run(args: Args): Promise<ToolResult> | ToolResult;
}

export interface RetrievalStrategy {
	readonly kind: string;
	/** The tools this strategy exposes. The model sees these and nothing else. */
	tools(): ToolSpec[];
	/** Resolve a path the model opened into a citation, or null if it is not citable. */
	citationFor(path: string): Citation | null;
}

/**
 * One knowledge base mounted into an agent.
 *
 * `mountAs` is the name it appears under in the composed root index. An agent
 * with several knowledge bases sees one tree with each base as a top-level
 * entry, the way a filesystem mount works, so navigation is unchanged and the
 * traversal log still names which library a page came from.
 */
export interface Mount {
	id: string;
	mountAs: string;
	root: string;
	priority: number;
}
