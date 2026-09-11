/**
 * The deterministic guard engine.
 *
 * Every rule it runs is data (see `types.ts` for why). This file is only the
 * machinery: match, decide, and record what happened — because a guard that
 * fires silently is indistinguishable from a guard that does not work, and the
 * assurance report is built from exactly these records.
 */
import type { GuardRule } from "./types.js";

export interface GuardVerdict {
	/** The answer after guards ran. */
	text: string;
	/** Every rule that fired, in order. */
	applied: { id: string; action: GuardRule["action"]; because?: string }[];
	/** True when a rule demanded the whole turn be regenerated. */
	retry: boolean;
}

/** Sentence-ish split that keeps its delimiters, so stripping stays readable. */
function sentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+/);
}

/**
 * Digits present in a string, grouped.
 *
 * `unsourced` comparison is on digits rather than the matched text, because
 * "$1,200" and "1200" and "1,200.00" are the same claim wearing different
 * clothes, and a formatting difference must not launder an invented number into
 * a sourced one.
 */
function digitGroups(text: string): string[] {
	return (text.match(/\d[\d,.]*/g) ?? []).map((d) => d.replace(/[^\d]/g, "")).filter(Boolean);
}

function normalise(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Is this claim actually present in what the agent read?
 *
 * Digits are only evidence when they are *distinctive*. A four-digit figure like
 * 1200 appearing in the source is a real match. Single digits are not: "1-3
 * drops per 5 mL" is made of 1, 3 and 5, which appear somewhere in any library
 * of any size, so a digit-set test called every invented dilution ratio sourced
 * and the guard never fired. Found by the grounded suite, on exactly the case
 * that guard exists for.
 *
 * So: distinctive numbers match on digits, everything else must match as a
 * phrase.
 */
function sourced(match: string, sourceText: string): boolean {
	const groups = digitGroups(match);
	const distinctive = groups.filter((d) => d.length >= 3);
	if (distinctive.length) {
		const have = new Set(digitGroups(sourceText));
		return distinctive.every((d) => have.has(d));
	}
	return normalise(sourceText).includes(normalise(match));
}

/**
 * Repair quote and emphasis markers orphaned by a strip.
 *
 * Removing the sentence that closed a quotation leaves the opening one behind:
 * `The document also carries this: *"Results vary…` with nothing to close it.
 * The figure is gone, which is the safety property, but the answer reads broken
 * — so drop the unmatched opener rather than leaving it on screen.
 */
function balance(text: string): string {
	let out = text;
	for (const mark of ['"', "**", "*"]) {
		const n = out.split(mark).length - 1;
		// `**` is counted before `*`, so a balanced bold pair does not leave two
		// stray singles behind.
		if (n % 2 === 1) {
			const at = out.lastIndexOf(mark);
			if (at >= 0) out = out.slice(0, at) + out.slice(at + mark.length);
		}
	}
	return out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

export interface GuardContext {
	/** The person's message. Used by `when`. */
	question: string;
	/** Everything the tools showed the model this turn. Used by `unsourced`. */
	sourceText: string;
}

/**
 * Run every guard in order.
 *
 * Order matters and is the policy author's business: a `strip` that empties the
 * answer should be followed by something that puts a reply back, and a `retry`
 * short-circuits the rest.
 */
export function applyGuards(
	answer: string,
	rules: GuardRule[] | undefined,
	ctx: GuardContext,
): GuardVerdict {
	const applied: GuardVerdict["applied"] = [];
	let text = answer;

	for (const rule of rules ?? []) {
		if (rule.when && !new RegExp(rule.when, "i").test(ctx.question)) continue;

		const detect = new RegExp(rule.detect, "gi");
		const hits = text.match(detect);
		if (!hits?.length) continue;

		// An `unsourced` rule only fires on claims absent from what was read.
		const offending = rule.unsourced
			? hits.filter((h) => !sourced(h, ctx.sourceText))
			: hits;
		if (!offending.length) continue;

		const record = rule.because
			? { id: rule.id, action: rule.action, because: rule.because }
			: { id: rule.id, action: rule.action };

		if (rule.action === "retry") {
			applied.push(record);
			return { text, applied, retry: true };
		}

		if (rule.action === "replace") {
			text = rule.replacement ?? text;
			applied.push(record);
			continue;
		}

		// strip: drop whole sentences containing an offending match, because a
		// half-removed figure reads worse than the figure did.
		const kept = sentences(text).filter(
			(s) => !offending.some((o) => s.includes(o)),
		);
		const next = balance(kept.join(" ").replace(/\s+/g, " ").trim());
		text = next.length ? next : (rule.replacement ?? next);
		applied.push(record);
	}

	return { text, applied, retry: false };
}
