/**
 * Reply tools and the checks that run before one is accepted.
 *
 * The engine knows how to build a tool from a `ReplyTool`, how to evaluate a
 * `ToolCheck` against a call, and nothing else about what a reply is. What the
 * tools are called, what fields they carry and which checks apply are the
 * policy's, and the defaults below exist only so a policy that never mentions
 * them behaves exactly as every agent did before they were data.
 */
import { Environment, ParseError } from "@marcbachmann/cel-js";
import type { ReplyTool, ToolCheck } from "./types.js";

/** What a check may look at, besides the call's own arguments. */
export interface TurnState {
	/** Zero-based step in the loop. */
	step: number;
	/** Steps the model still has after this one. */
	stepsLeft: number;
	/** Paths opened so far this turn. */
	opened: string[];
	/** Whether any of those is a document rather than an index. */
	openedLeaf: boolean;
	/** Earlier turns of the conversation, as many as were supplied. */
	history: number;
}

/**
 * The single reply tool every agent had before this was configurable, and the
 * one check the loop used to enforce as a hard gate. Data, so it can be read.
 */
export const DEFAULT_TOOLS: ReplyTool[] = [
	{
		id: "reply",
		describes:
			"Give your final reply to the person. Call this when you have read enough to " +
			"answer, or to say what you could not find. This is the ONLY way to reply: " +
			"prose written outside this tool never reaches them.",
		fields: [
			{
				name: "message",
				describes:
					"The reply, exactly as the person will read it. Nothing about your own " +
					"process: not what you looked for, not what you found, not whether it " +
					"helped. It must read as though you already knew the answer.",
			},
			{
				name: "next_step",
				describes:
					"ONE concrete thing they can do next, as a single sentence. Not a plan, not a list.",
			},
		],
		say: ["message", "next_step"],
	},
];

export const DEFAULT_CHECKS: ToolCheck[] = [
	{
		id: "read_before_reply",
		tool: "reply",
		when: "!turn.openedLeaf",
		say: "Not delivered: nothing has been opened yet. Look first, then reply from what you read.",
		because:
			"\"Never answer from your own knowledge\" holds right up until the model is confident; " +
			"asked what someone earns at a rank, one answered with a range having opened nothing.",
	},
];

function wordsIn(s: string): number {
	return s.trim().split(/\s+/).filter(Boolean).length;
}

const env = new Environment({ unlistedVariablesAreDyn: false })
	.registerVariable("args", "map")
	.registerVariable("turn", "map")
	.registerFunction("words(string): int", (s: string) => BigInt(wordsIn(s)));

/**
 * Whether an expression parses. Returns the parser's message, or null.
 *
 * Called where a policy is saved: a check that does not compile should be
 * refused in the editor, because the alternative is that it throws at answer
 * time for whoever is talking to the agent.
 */
export function badCheck(when: string): string | null {
	try {
		env.parse(when);
		return null;
	} catch (e) {
		return e instanceof ParseError ? e.message.split("\n")[0] ?? "does not parse" : (e as Error).message;
	}
}

/**
 * The first check that fires for this call, or null.
 *
 * An evaluation error — a check that reads a key the call does not carry —
 * counts as not firing. A check that cannot be evaluated must not become a
 * refusal the model can never satisfy, and the policy editor already refused
 * the ones that do not parse.
 */
export function failingCheck(
	checks: ToolCheck[], tool: string, args: Record<string, unknown>, turn: TurnState,
): ToolCheck | null {
	for (const c of checks) {
		if (c.tool !== tool) continue;
		try {
			if (env.evaluate(c.when, { args, turn }) === true) return c;
		} catch {
			/* see above */
		}
	}
	return null;
}

/** The fields the person reads, joined in the order the tool says. */
export function compose(tool: ReplyTool, args: Record<string, unknown>): string {
	const say = tool.say?.length ? tool.say : ["message"];
	const parts: string[] = [];
	for (const name of say) {
		const v = args[name];
		if (typeof v !== "string") continue;
		const t = v.trim();
		if (!t) continue;
		// A model that ends the message with the next step anyway would
		// otherwise say it twice.
		if (parts.length && parts[parts.length - 1]!.endsWith(t)) continue;
		parts.push(t);
	}
	return parts.join("\n\n");
}
