/**
 * The two model-driven screens that run before the agent does.
 *
 * Both were in the policy document from the beginning — `scope.system` is a
 * system prompt for a classifier, and every escalation carries a `describes`
 * written to be read by one — and the engine used only the cheap regex
 * pre-screen and ignored the rest. A platform running this policy therefore
 * answered questions the policy says to refuse, and, far worse, screened for no
 * safety category at all: a message about chest pain reached the ordinary agent
 * loop and was answered out of a wellness library.
 *
 * Detection is a model call rather than a regex because the phrasing is
 * unbounded and the cost of missing one is high. The *reply* stays fixed text:
 * a crisis answer must not be improvised, and must be identical every time.
 */
import { generateText } from "ai";
import { modelFor } from "../models/index.js";
import { modelCall, type ModelCall } from "../model-call.js";
import { compileScopeSystem, passthroughId } from "./scope.js";
import type { Escalation, ScopePolicy, ScopeVerdict } from "./types.js";

/** Accepted only when the policy defines no table of its own. */
const LEGACY_VERDICTS: ScopeVerdict[] = ["in_scope", "off_topic", "injection", "extraction"];

/**
 * Both screens see what came before, not just the latest line.
 *
 * "The 3am thing is happening again" reads as an unspecified crisis on its own
 * and returned an emergency reply to someone asking about sleep. A follow-up is
 * only interpretable next to what it follows.
 */
export function screenContext(
	memoryBrief: string | undefined,
	history: { role: string; content: string }[] | undefined,
): string {
	return [
		memoryBrief ?? "",
		(history ?? []).slice(-4).map((m) => `${m.role}: ${m.content}`).join("\n"),
	].filter(Boolean).join("\n").slice(0, 1500);
}

function prompt(message: string, context: string): string {
	return context ? `EARLIER:\n${context}\n\nMESSAGE:\n${message}` : message;
}

/**
 * Pinned to 0. The same message must reach the same verdict every time.
 *
 * `calls` is an optional collector rather than a second return value, so every
 * existing caller keeps working untouched. A screen used to throw `r.usage` away
 * and return only the text, which is why screen tokens were spent on every turn
 * and recorded nowhere.
 */
async function classify(
	model: string, system: string, text: string, maxOutputTokens: number,
	name: string, calls?: ModelCall[],
) {
	const r = await generateText({
		model: modelFor(model), system, prompt: text, maxOutputTokens, temperature: 0,
		include: { requestBody: true },
	});
	calls?.push(modelCall({
		name, model, usage: r.usage,
		startedAt: r.response?.timestamp,
		ms: r.steps?.[0]?.performance?.responseTimeMs,
		finishReason: r.finishReason,
		text: r.text,
		input: r.request?.body ?? r.request?.messages,
	}));
	return r.text ?? "";
}

/**
 * The verdict out of whatever the model actually said.
 *
 * Takes the FIRST object in the reply rather than parsing the reply. The screen
 * used to parse the whole string, so a model that answered correctly and then
 * carried on — "```json {...}``` --- This is exactly the kind of question…" —
 * threw on the trailing prose and fell through to the pass-forward. 214 of 698
 * screens on record did exactly that: the verdict was present, correct, and
 * discarded, and the only sign was a `finish: length` that read like a token
 * limit. The escalation screen has always extracted, which is why it never had
 * the problem.
 *
 * Exported because the interesting cases are real strings a model produced, and
 * a parser that can only be exercised by paying for a model call is a parser
 * nobody writes tests for.
 */
export function readVerdict(text: string): string {
	const m = /\{[\s\S]*?\}/.exec((text ?? "").replace(/```json|```/g, ""));
	if (!m) return "";
	try {
		return String((JSON.parse(m[0]) as { verdict?: unknown }).verdict ?? "");
	} catch {
		return "";
	}
}

/**
 * Is this in scope? Regex first, model only for what survives it.
 *
 * An unparseable or unexpected verdict lets the turn through. Failing closed
 * would refuse real questions every time the classifier hiccups, which is a
 * worse product than occasionally answering something off topic.
 */
export async function screenScope(
	message: string,
	policy: ScopePolicy | undefined,
	model: string,
	context = "",
	calls?: ModelCall[],
): Promise<ScopeVerdict> {
	if (!policy) return "in_scope";
	// `policy.rules` is not consulted. Retired 2026-09-11; see `ScopePolicy.rules`.
	//
	// Measured on a live deployment before removing it: of the turns a pattern
	// decided, the ones it fast-pathed were no faster than the ones that ran the
	// screen (17.5s against 16.0s median). The escalation screen runs beside
	// this one in a `Promise.all` and takes about as long, so skipping this call
	// alone never saved wall-clock time.
	//
	// Against that: patterns matched on subject, and subject is exactly where a
	// banned word turns out to be a product name. Probed against a real rule
	// set, half of ten plausible questions were refused wrongly, each because a
	// catalogue word collided with an off-topic one.
	//
	// Keeping only the fast-path rules was the tempting half-measure and is
	// unsafe: the attack patterns are ordered ahead of them, and they are what
	// stops an injection that happens to mention an in-scope subject matching
	// the fast path and skipping the screen entirely. The pieces were
	// load-bearing on each other, so they go together.
	//
	// Nothing is lost: the model screen already carries every verdict the
	// patterns did.
	// Compiled from the table when there is one, so the rubric and the categories
	// cannot disagree — there is only one of them.
	const system = compileScopeSystem(policy);
	const pass = passthroughId(policy);
	if (!system) return pass;
	const known = policy.categories?.length
		? policy.categories.map((c) => c.id)
		: LEGACY_VERDICTS;
	try {
		const text = await classify(
			model, system, prompt(message, context), 120, "scope_screen", calls);
		const v = readVerdict(text);
		if (known.includes(v)) return v;
		// Falling open is deliberate — a hiccup must not refuse a real question —
		// but it must not be silent either. Nothing recorded that a screen had
		// not screened, so a third of turns went unscreened without a single line
		// anywhere saying so.
		console.warn(`[scope_screen] no usable verdict, passing as ${pass}: ${JSON.stringify(text.slice(0, 120))}`);
		return pass;
	} catch (e) {
		console.warn(`[scope_screen] unreadable, passing as ${pass}: ${(e as Error).message}`);
		return pass;
	}
}

/**
 * Does this need a person rather than an agent?
 *
 * A screen that fails must not block the reply — the deterministic guards still
 * apply, and refusing to answer because a classifier timed out is a worse
 * failure than answering an ordinary question unscreened.
 */
export async function screenEscalation(
	message: string,
	escalations: Escalation[] | undefined,
	model: string,
	context = "",
	system?: string,
	calls?: ModelCall[],
): Promise<string | null> {
	if (!escalations?.length) return null;
	const rubric = system ?? [
		"You are a safety screen. Read the message and decide whether it falls into",
		"one of the categories below. Answer with JSON only: {\"category\": \"<id>\"}",
		"or {\"category\": null} when none applies. Do not explain.",
		"",
		...escalations.map((e) => `- ${e.id}: ${e.describes}`),
	].join("\n");
	try {
		const text = await classify(
			model, rubric, prompt(message, context), 200, "escalation_screen", calls);
		const m = /\{[\s\S]*\}/.exec(text);
		const cat = m ? (JSON.parse(m[0]).category as string | null) : null;
		return cat && escalations.some((e) => e.id === cat) ? cat : null;
	} catch {
		return null;
	}
}
