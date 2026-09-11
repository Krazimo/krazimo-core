/**
 * One model call, as it was billed.
 *
 * A turn is not one call. It is however many steps the answer loop took, plus a
 * salvage retry when a guard asked for one, plus the screens, plus the two
 * memory calls that run after the answer has already been handed over. Every one
 * of them spends tokens, and until this type existed only the first was recorded
 * anywhere — `TurnResult.usage` aggregated the answer loop and nothing else, so
 * the screens and the memory writer were spending money invisibly.
 *
 * Recorded per call rather than summed, because a total cannot answer the
 * question anyone actually asks: which of these is the expensive one.
 *
 * Core does not store these. It returns them, the way it already returns
 * `toolCalls`, and the platform decides where they go — so the engine still
 * boots with a knowledge base and a config file and nothing else.
 */
import type { LanguageModelUsage } from "ai";
import type { ToolCallRecord } from "./agent/index.js";
import { providerOf } from "./models/index.js";

export interface ModelCall {
	/** Which of the calls this is: `answer`, `salvage`, `scope_screen`, … */
	name: string;
	/** The id as configured, `bedrock:us.anthropic.claude-sonnet-4-6`. */
	model: string;
	provider: string;
	/** When the provider began the response. ISO 8601. */
	startedAt: string;
	ms: number;
	/**
	 * Input tokens, split by the rate each was billed at.
	 *
	 * Deliberately not a single `inputTokens`. The AI SDK's `inputTokens` is the
	 * *inclusive* total — `@ai-sdk/amazon-bedrock` builds it as
	 * `inputTokens + cacheReadTokens + cacheWriteTokens` — so pricing that
	 * number at the base rate charges the cached tokens twice, once cheap and
	 * once full. On a turn where 20,020 of 20,088 input tokens are cache reads,
	 * that is not a rounding error. Stored pre-split so no consumer can make
	 * that mistake; the display total is the sum of the three.
	 */
	uncachedIn: number;
	cachedIn: number;
	cacheWrite: number;
	tokensOut: number;
	finishReason: string | null;
	/**
	 * What the model wrote on this call.
	 *
	 * Usually empty on a step that only asked for tools, and that emptiness is
	 * itself the useful signal — it says the step was traversal, not answering.
	 * Capped, because a trace row is a debugging aid and not a second copy of
	 * the library: a step that read a 60k document must not write 60k here.
	 */
	text: string;
	/**
	 * The tools this call asked for, with what came back.
	 *
	 * Held against the call that made them rather than in a flat list beside it.
	 * A turn's tool calls listed on their own say what happened but not who
	 * asked or why, which is the half that makes a trace readable.
	 */
	toolCalls: ToolCallRecord[];
	/**
	 * Exactly what was sent to the provider for this call.
	 *
	 * The output alone cannot answer the question a trace is opened for. When an
	 * answer is wrong the useful question is almost never "what did it say" — it
	 * is "was the memory brief actually in the prompt", "did the document we
	 * think it read really reach it", "where did the cache point land". None of
	 * that is recoverable from the reply, and reconstructing the prompt by
	 * reading the code is how you confirm the bug you already believe in.
	 *
	 * This is the provider's own request body, not our reconstruction of it, so
	 * it stays true when the two disagree — which is the case worth catching.
	 *
	 * Kept for a retention window and then deleted: see `model_call_input`.
	 */
	input: unknown;
}

/** Long enough to read a verdict or an answer; short enough that a row stays a row. */
const TEXT_CAP = 4_000;
/**
 * A pathological prompt must not become a pathological row. Generous enough for
 * a document-heavy step, bounded enough that one turn cannot fill a table.
 */
const INPUT_CAP = 1_000_000;

/** Total input tokens, at every rate. */
export function inputTokens(c: ModelCall): number {
	return c.uncachedIn + c.cachedIn + c.cacheWrite;
}

/**
 * Read one call's record off an AI SDK result.
 *
 * `noCacheTokens` is preferred over subtracting, because the SDK reports it
 * directly and arithmetic on numbers a provider may round independently is how
 * a negative token count reaches a price.
 */
export function modelCall(args: {
	name: string;
	model: string;
	usage: LanguageModelUsage | undefined;
	startedAt?: Date | undefined;
	ms?: number | undefined;
	finishReason?: string | undefined;
	text?: string | undefined;
	toolCalls?: ToolCallRecord[] | undefined;
	input?: unknown;
}): ModelCall {
	const u = args.usage;
	const d = u?.inputTokenDetails;
	const cachedIn = d?.cacheReadTokens ?? 0;
	const cacheWrite = d?.cacheWriteTokens ?? 0;
	const uncachedIn = d?.noCacheTokens
		?? Math.max(0, (u?.inputTokens ?? 0) - cachedIn - cacheWrite);
	return {
		name: args.name,
		model: args.model,
		provider: providerOf(args.model),
		startedAt: (args.startedAt ?? new Date()).toISOString(),
		ms: Math.max(0, Math.round(args.ms ?? 0)),
		uncachedIn,
		cachedIn,
		cacheWrite,
		tokensOut: u?.outputTokens ?? 0,
		finishReason: args.finishReason ?? null,
		text: (args.text ?? "").slice(0, TEXT_CAP),
		toolCalls: args.toolCalls ?? [],
		input: capped(args.input),
	};
}

/**
 * The request body, unless it is absurd.
 *
 * Measured after serialising because that is the size that will be stored; an
 * object that serialises past the cap is replaced by a note rather than
 * truncated, since half a JSON document is not a debugging aid.
 */
function capped(input: unknown): unknown {
	if (input === undefined || input === null) return null;
	try {
		const json = JSON.stringify(input);
		if (json === undefined) return null;
		return json.length > INPUT_CAP
			? { omitted: `request body of ${json.length} bytes exceeded the ${INPUT_CAP}-byte cap` }
			: input;
	} catch {
		return null;
	}
}
