/**
 * Turning what is remembered into prompt text.
 *
 * Two renderers, because the two make different claims and the prompt has to
 * keep them apart. `about` is what the person stated; `brief` is what we
 * noticed. Collapsing them into one paragraph is how an agent ends up telling
 * someone they said a thing they never said.
 */
import type { Memory, MemoryPolicy } from "./types.js";

const MAX_CHARS = 5000;

/** The questionnaire, and how they asked to be spoken to. Authoritative. */
export function about(m: Memory, policy: MemoryPolicy | undefined): string {
	const out: string[] = [];
	const order = policy?.stated ?? Object.keys(m.stated);
	const stated = order
		.filter((k) => m.stated[k])
		.map((k) => `${k.replace(/_/g, " ")}: ${m.stated[k]}`);
	if (stated.length) out.push(stated.join("; "));

	const scale = policy?.style ?? {};
	const style = Object.entries(m.style)
		.map(([k, v]) => `${k}: ${scale[k]?.[v - 1] ?? v}`);
	if (style.length) {
		out.push(
			"How they asked to be helped — " + style.join("; ") +
				". That governs tone and length, never what is true.",
		);
	}
	return out.join("\n").slice(0, MAX_CHARS);
}

/** What we noticed, with weakly-held things marked as such. */
export function brief(m: Memory, policy: MemoryPolicy | undefined): string {
	const out: string[] = [];
	const byKind = new Map<string, typeof m.facts>();
	for (const f of m.facts) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);

	for (const [kind, items] of byKind) {
		const label = policy?.kinds?.[kind] ?? kind.replace(/_/g, " ");
		const rendered = items
			// Certain things first; among equals, the ones heard most often.
			.sort((a, b) => a.confidence - b.confidence || b.timesSeen - a.timesSeen)
			.map((f) => {
				// Both halves. The key is the thing and the value is what was
				// said about it, so printing only the value gives you
				// "products they have: uses every morning" — a sentence with
				// the product missing from it.
				const body = !f.value
					? f.key
					: f.value.toLowerCase().includes(f.key.toLowerCase())
						? f.value
						: `${f.key} — ${f.value}`;
				// Marked, not hidden. Hiding a weak inference would make it
				// indistinguishable from something the person actually said.
				// 1–2 is stated or near enough; 3 and above is our guess.
				return f.confidence <= 2 ? body : `${body} (unconfirmed)`;
			});
		out.push(`${label}: ${rendered.join("; ")}`);
	}

	// What stopped being true, so the agent does not offer back something they
	// have already said they gave up. A fact that ended is not a fact deleted.
	if (m.ended?.length) {
		out.push("No longer true: " + m.ended.map((f) => f.key).join("; "));
	}

	if (m.episodes.length) {
		out.push("Earlier conversations:\n" + m.episodes.map((e) => `- ${e}`).join("\n"));
	}
	return out.join("\n").slice(0, MAX_CHARS);
}

/** Both halves, in the order the agent should read them. */
export function memoryBrief(m: Memory, policy: MemoryPolicy | undefined): string {
	return [about(m, policy), brief(m, policy)].filter(Boolean).join("\n\n");
}
