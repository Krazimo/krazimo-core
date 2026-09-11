/**
 * Noticing things about a person, from what they just said.
 *
 * Pinned to temperature 0, and that is not a preference. The same exchange
 * must yield the same facts every time, or what the agent believes about
 * someone depends on when it happened to look — and a belief that drifts is
 * worse than no belief, because it is still asserted with confidence.
 *
 * A failure here returns nothing rather than throwing. Extraction runs after
 * the person already has their answer; losing a fact is a small harm, and
 * failing the turn over it is a large one.
 */
import { generateText } from "ai";
import { modelFor } from "../models/index.js";
import { modelCall, type ModelCall } from "../model-call.js";
import type { MemoryPolicy, Observation } from "./types.js";

/** Built from the tenant's kinds when they have not written their own. */
function defaultSystem(kinds: Record<string, string>): string {
	return [
		"Read one exchange and note anything worth remembering about the PERSON.",
		"Answer with JSON only: {\"facts\": [{\"kind\", \"key\", \"value\", \"confidence\", \"negates\"}]}",
		"",
		"kind must be one of:",
		...Object.entries(kinds).map(([k, v]) => `- ${k}: ${v}`),
		"",
		"key is the thing itself, in a few words, lowercase.",
		"value is optional detail.",
		"confidence: 1 = stated outright, 3 = strongly implied, 5 = a guess.",
		"negates is true when they say something previously true no longer is.",
		"",
		"Record the person, not the answer. Nothing the agent suggested is a fact",
		"about them unless they agreed to it. Return an empty list when nothing",
		"was learned — most exchanges teach nothing, and inventing something to",
		"fill the list is how a memory fills with noise.",
	].join("\n");
}

export async function extract(
	message: string,
	answer: string,
	policy: MemoryPolicy | undefined,
	model: string,
	calls?: ModelCall[],
	/**
	 * `kind/key` for everything already held about this person.
	 *
	 * The store deduplicates on an exact `(kind, key)` match, so whether a fact
	 * is counted again or stored a second time is decided here, by which key the
	 * model picks. Left to invent one per turn it writes a new one every time —
	 * one real person accumulated `goal/enrollment`, `goal/enrolling people` and
	 * `wants_help_with/enrollment` for a single thing they kept raising, and the
	 * cap fills with restatements rather than knowledge. Showing the model what
	 * it already calls things is what makes the match possible.
	 */
	known?: readonly string[],
): Promise<Observation[]> {
	const kinds = policy?.kinds;
	if (!kinds || !Object.keys(kinds).length) return [];
	try {
		const r = await generateText({
			model: modelFor(model),
			system: policy.extractionSystem ?? defaultSystem(kinds),
			prompt: [
				...(known?.length
					? [
						"ALREADY RECORDED ABOUT THIS PERSON, as kind/key:",
						...known.map((k) => `- ${k}`),
						"",
						"When something here is the same thing said again, reuse that kind",
						"and key exactly so it is counted again rather than stored twice.",
						"Only invent a new key for something genuinely not in the list.",
						"",
					]
					: []),
				`PERSON SAID:\n${message}`,
				"",
				`AGENT REPLIED:\n${answer.slice(0, 1500)}`,
			].join("\n"),
			maxOutputTokens: 600,
			temperature: 0,
			include: { requestBody: true },
		});
		calls?.push(modelCall({
			name: "memory_extract", model, usage: r.usage,
			startedAt: r.response?.timestamp,
			ms: r.steps?.[0]?.performance?.responseTimeMs,
			finishReason: r.finishReason,
			text: r.text,
			input: r.request?.body ?? r.request?.messages,
		}));
		const m = /\{[\s\S]*\}/.exec(r.text ?? "");
		if (!m) return [];
		const facts = (JSON.parse(m[0]).facts ?? []) as Observation[];
		// A kind the policy does not define is discarded rather than stored: the
		// vocabulary is the tenant's, and a model inventing a new one silently
		// widens it.
		return facts.filter((f) => f?.kind && f.kind in kinds && String(f.key ?? "").trim());
	} catch {
		return [];
	}
}

/** A rolling summary of a conversation, for picking the thread up cold. */
export async function summarise(
	transcript: string,
	policy: MemoryPolicy | undefined,
	model: string,
	calls?: ModelCall[],
): Promise<string | null> {
	const system = policy?.summarySystem;
	if (!system) return null;
	try {
		const r = await generateText({
			model: modelFor(model), system, prompt: transcript.slice(-12_000),
			maxOutputTokens: 400, temperature: 0,
			include: { requestBody: true },
		});
		calls?.push(modelCall({
			name: "memory_summarise", model, usage: r.usage,
			startedAt: r.response?.timestamp,
			ms: r.steps?.[0]?.performance?.responseTimeMs,
			finishReason: r.finishReason,
			text: r.text,
			input: r.request?.body ?? r.request?.messages,
		}));
		return (r.text ?? "").trim() || null;
	} catch {
		return null;
	}
}
