/**
 * What an agent is allowed to remember about a person, as data.
 *
 * Two kinds of knowledge, deliberately never mixed. **Stated** is the
 * questionnaire: what someone told us outright, plus how they asked to be
 * spoken to. It is theirs, it is authoritative, and it is never inferred.
 * **Noticed** is what a model extracted from a conversation, and it carries a
 * confidence and can be contradicted later.
 *
 * Presenting the two as the same kind of claim is the failure this separation
 * exists to prevent: an agent that says "you told me you avoid X" about
 * something it guessed has damaged the only thing it was selling.
 *
 * The vocabulary is the tenant's — which fields their questionnaire has, which
 * kinds of thing are worth noticing, how the style sliders read in words. The
 * engine owns none of it, which is what lets a second tenant remember entirely
 * different things about entirely different people.
 */

export interface MemoryPolicy {
	/** Kinds of noticed fact, and what each one means, for the extractor. */
	kinds?: Record<string, string>;
	/** Questionnaire fields, in the order they should be rendered. */
	stated?: string[];
	/**
	 * Style sliders and the words for each position, low to high.
	 *
	 * These govern tone and length and never what is true, which the rendered
	 * brief says out loud — a person asking to be spoken to gently must not
	 * quietly become a person who is told gentler facts.
	 */
	style?: Record<string, string[]>;
	/** The system prompt the extractor runs with. Absent, one is generated. */
	extractionSystem?: string;
	/** The system prompt for rolling conversation summaries. */
	summarySystem?: string;
}

export interface Fact {
	/** Set when the store assigned one, so a caller can ask to forget it. */
	id?: number;
	kind: string;
	key: string;
	value: string | null;
	/**
	 * 1–5, where **1 is certain**: 1 was stated outright, 3 strongly implied,
	 * 5 a guess. The scale reads backwards from the obvious direction and that
	 * is load-bearing — `LEAST` is how a fact strengthens when it is heard
	 * again, so the number can only fall towards certainty. Reading it the
	 * intuitive way round labels everything a person actually told you as
	 * something you might have made up.
	 */
	confidence: number;
	timesSeen: number;
}

export interface Memory {
	/** The questionnaire, as given. */
	stated: Record<string, string>;
	/** Slider name to position, 1-based. */
	style: Record<string, number>;
	facts: Fact[];
	/** Recently ended facts, so the agent knows what to stop offering. */
	ended?: Fact[];
	/** Rolling summaries of earlier conversations, newest last. */
	episodes: string[];
}

/** One thing the extractor noticed. `negates` ends a fact rather than adding one. */
export interface Observation {
	kind: string;
	key: string;
	value?: string;
	confidence?: number;
	negates?: boolean;
}

export const EMPTY_MEMORY: Memory = { stated: {}, style: {}, facts: [], episodes: [] };
