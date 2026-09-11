import type { Citation, RetrievalStrategy, ToolSpec } from "./types.js";

/**
 * An agent that reads nothing, because its subject arrives in the message.
 *
 * The engine was built around index-walking and assumed every agent had a
 * library: `IndexWalk` throws without at least one mount, and the platform's
 * registry dropped a mountless agent rather than serving it. That assumption
 * held for as long as every agent answered questions FROM something.
 *
 * It stops holding for a scorer. Such an agent is handed one support
 * conversation and grade it — the transcript is the input, not a lookup key,
 * and there is nothing to retrieve. Before this existed they were given a
 * knowledge base they never opened, purely so the registry would serve them,
 * with `navigation: []` to take the tools away again. Machinery cancelling
 * machinery, and a mount in the console implying a library the agent had no
 * way to read.
 *
 * So: no tools, and nothing is citable. `open` cannot be taken away from an
 * agent that navigates — that rule is in `parsePolicy` and it stays — but an
 * agent that navigates at all is now a choice rather than the only shape.
 *
 * This is deliberately not "IndexWalk with zero mounts". A strategy that
 * offers `open` over an empty tree would let the model spend steps discovering
 * there is nothing there, and would report those as refusals in the traversal
 * log, which reads as retrieval failing rather than retrieval being absent.
 */
export class NoRetrieval implements RetrievalStrategy {
	readonly kind = "none";

	tools(): ToolSpec[] {
		return [];
	}

	citationFor(): Citation | null {
		return null;
	}
}
