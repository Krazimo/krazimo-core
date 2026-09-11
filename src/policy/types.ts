import type { MemoryPolicy } from "../memory/types.js";

/**
 * A policy is everything about how an agent is allowed to behave, as data.
 *
 * It was code. The first client's constitution, the escalation categories and
 * each output guard were literals in the engine, which meant a second client could
 * not exist and a compliance change was a deploy. Moving them here is what makes
 * the engine general — and it is also what makes the behaviour *reviewable*,
 * because a policy version is a document a compliance owner can read and sign.
 *
 * The important design point: **guards are deterministic and run after
 * generation.** Everything here was tried as a prompt instruction first and
 * failed. The clearest case, kept as the reason this exists at all: asked what
 * someone would earn at a given rank, a mentor answered with a specific monthly
 * range — correctly retrieved and correctly cited from an official earnings
 * disclosure. The retrieval gate had worked exactly as designed; the official
 * source simply contains the figures. Better prompting did not fix it, because
 * the model was not misbehaving. So the last word is code. A regex cannot be
 * talked round.
 */

/** What a guard does when it fires. */
export type GuardAction =
	/** Remove the offending sentences and keep the rest of the answer. */
	| "strip"
	/** Replace the whole answer with `replacement`. */
	| "replace"
	/** Discard the answer and ask the model again without tools. */
	| "retry";

export interface GuardRule {
	id: string;
	/** Why this exists. Carried into logs and reports, so keep it honest. */
	because?: string;
	/**
	 * Only consider this guard when the *question* matches. Lets a rule apply to
	 * "how much will I earn" without also policing every mention of a price.
	 */
	when?: string;
	/** Fires when the *answer* matches. */
	detect: string;
	/**
	 * Fire only when the detected text is absent from what the agent actually
	 * read. A figure that appears in an opened document is sourced; the same
	 * figure appearing from nowhere is invented, and only the second is a
	 * problem. Comparison is on digits, so formatting differences do not excuse
	 * an invented number.
	 */
	unsourced?: boolean;
	action: GuardAction;
	/** Used by `replace`, and appended by `strip` when the answer empties out. */
	replacement?: string;
}

/**
 * A situation where the agent must stop and hand off.
 *
 * Detection is a model call rather than a regex, because the cost of missing one
 * is high and the phrasing is unbounded. The *reply* is fixed text: a crisis
 * answer must not be generated fresh each time.
 */
export interface Escalation {
	id: string;
	/** Told to the screening model: what this category covers. */
	describes: string;
	reply: string;
}

/**
 * One row of the scope table, and one category the screen may return.
 *
 * `reply` absent is how a policy says THIS is the category that passes forward.
 * The engine used to know the name "in_scope" and treat everything else as a
 * refusal by definition, which is why the vocabulary could not grow: a fifth
 * category was unreachable without changing this file. A row carries its own
 * consequence instead, so adding one is data.
 */
export interface ScopeCategory {
	id: string;
	/** Told to the screening model: what this category covers. */
	describes: string;
	/** Fixed reply, ending the turn. Absent means the turn continues. */
	reply?: string;
}

/**
 * A category id. Was a closed union of the original four, which is exactly the
 * constraint `categories` exists to remove — the valid set is now whatever the
 * policy defines, checked at screen time against that list.
 */
export type ScopeVerdict = string;

export interface ScopeRule {
	/**
	 * `in_scope` is allowed, and load-bearing.
	 *
	 * Without it a policy can only say what to refuse, so a message naming the
	 * subject outright — "what does Lavender help with" — still had to be sent
	 * to a classifier that might call it off topic. Our subject wins before the
	 * off-topic net and before the model; rules are read in order, so where an
	 * `in_scope` rule sits relative to the others is the policy author's
	 * decision, not the engine's.
	 */
	verdict: ScopeVerdict;
	pattern: string;
}

export interface ScopePolicy {
	/**
	 * The categories, in the order the screening model is shown them.
	 *
	 * When present this is the source and the rubric is compiled from it at
	 * screen time, so what the model was given exists in no file — it is
	 * reproducible from the table and the frame around it, and both are on the
	 * policy version.
	 */
	categories?: ScopeCategory[];
	/**
	 * Guidance appended after the compiled table: the agent-specific judgement
	 * calls a category list cannot carry. The WHOLE rubric when there are no
	 * categories, which is the pre-table shape and still supported.
	 */
	system: string;
	/**
	 * Retired 2026-09-11. Read by nothing; kept so old policy versions still
	 * parse and can still be rolled back to.
	 *
	 * A regex pre-screen that could refuse a turn outright. It matched on
	 * subject, and subject is where a banned word turns out to be a product
	 * name: against a real rule set, a question about a product whose name
	 * collided with an off-topic term was refused. It also bought nothing — a
	 * fast-pathed turn measured no faster than one that ran the screen, because
	 * the escalation screen runs beside it and takes about as long.
	 *
	 * Do not revive this field. If a cheap deterministic pre-filter is wanted
	 * again, it should only ever be able to skip work, never to refuse, and it
	 * cannot live beside a fast-path rule without the ordering between them
	 * becoming load-bearing.
	 */
	rules?: ScopeRule[];
	/** Pre-table replies, keyed by verdict. Ignored once `categories` is set. */
	replies?: Record<string, string>;
}

/**
 * A model id per screening step. Every field optional; see `PolicyDocument.screens`.
 *
 * `memory` covers both halves of remembering — extracting facts from a turn and
 * rewriting the rolling summary — because they are the same job on the same
 * text and nobody has yet wanted them apart. Split it when somebody does.
 */
export interface ScreenModels {
	/** The scope screen: which category this message falls in. */
	scope?: string;
	/** The escalation screen: which escalation, if any, this message trips. */
	escalation?: string;
	/** Fact extraction and the conversation summary. */
	memory?: string;
}

export interface PolicyDocument {
	id: string;
	version: number;
	/** The system prompt. Everything the agent is and is not. */
	constitution: string;
	scope?: ScopePolicy;
	escalations?: Escalation[];
	/**
	 * The system prompt the safety screen runs with.
	 *
	 * A category list assembled from `describes` gets the obvious cases and
	 * misses the ones that matter — a follow-up like "what about for a child?"
	 * only reads as an infant question next to the turn before it, and telling a
	 * classifier that takes paragraphs, not a bullet. Those paragraphs are the
	 * tenant's, because which edge cases matter is a property of who is being
	 * protected. Absent, a list is generated from the categories.
	 */
	escalationSystem?: string;
	/** Used when an escalation fires but names no reply of its own. */
	escalationDefault?: string;
	guards?: GuardRule[];
	/**
	 * What this agent may remember about a person, and in whose words.
	 *
	 * Optional: an agent that should forget everyone between turns simply omits
	 * it, and nothing is stored. That is a real configuration, not a degraded
	 * one — a compliance reviewer asking "what does it keep about me" should be
	 * able to be told "nothing" and have that be true.
	 */
	memory?: MemoryPolicy;
	/**
	 * The ways the agent may reply. Each is a tool the model calls; calling one
	 * ends the turn.
	 *
	 * This was one tool, hard-coded, with two required fields — `message` and
	 * `next_step` — and the description of the second said "if you asked a
	 * question in message, this still has to be an action they can take
	 * whichever way they answer it". Read that back: a turn that is only a
	 * question was impossible, and the client's feedback was that shape exactly
	 * ("which of these fits?" at the end of 456 words covering both). The
	 * shape of a reply is a property of what the agent is for, so it is data
	 * here, like the guards and the escalations, and the engine builds the
	 * tools from it. Absent means one `reply` tool with `message` and
	 * `next_step`, which is the behaviour every existing agent already has.
	 */
	tools?: ReplyTool[];
	/**
	 * Checks on a tool call before it runs. A failing check hands `say` back to
	 * the model as the tool's result, and the model calls again.
	 *
	 * This is the interception point every agent framework exposes — Pydantic
	 * AI's ModelRetry, the OpenAI SDK's tool guardrails, the Claude SDK's
	 * PreToolUse deny — and it is where the engine's hard gates used to live as
	 * code: "the reply is withheld until a document has been opened" was an
	 * `activeTools` restriction in the loop, and it could not tell a question
	 * from an assertion. As a check it can: `tool: answer, when:
	 * !turn.openedLeaf`. Absent means that one check on the default tool, so
	 * nothing changes for a policy that has not been told otherwise.
	 */
	checks?: ToolCheck[];
	/**
	 * The retrieval strategy's tools this agent has, by name. Absent means all
	 * of them; listed means exactly these, in this order.
	 *
	 * The case that exists is leaving `find` out. Measured over one day of
	 * production traces on a library built for index traversal: of 18 turns
	 * that called it, none reached a page the indexes did not already name,
	 * and two answered from the wrong page it returned. A bad result set read
	 * to the model as "the library has nothing", the one conclusion traversal
	 * exists to prevent, and a question that looked like personal data ("who
	 * is my account rep") went find, find, list, find without opening the
	 * index that named the directory.
	 */
	navigation?: string[];
	/**
	 * How the answer is produced: a tool the model calls, or a schema it fills.
	 *
	 * `tools` (the default, and what every agent did before this) exposes each
	 * `ReplyTool` as a function the model may call; calling one ends the turn.
	 * `structured` sends the same fields as a response schema instead, and the
	 * model answers with an object rather than a call.
	 *
	 * The distinction the industry draws is the one to keep: a TOOL is the model
	 * calling into your system, and STRUCTURED OUTPUT is the model answering the
	 * person in a shape. An agent that navigates a library is doing the first
	 * even when its last act looks like the second; a scorer handed a transcript
	 * is only ever doing the second.
	 *
	 * Both give the same guarantee — the model cannot answer in any other shape,
	 * because `toolChoice: "required"` forces the call and a response schema
	 * constrains generation. What differs is what they cost and what they carry.
	 * `checks` and the retry-with-reason primitive exist only on the tool path,
	 * because there is no call to intercept when the model is filling a schema.
	 *
	 * MEASURED, because the comment on the reply tool below says structured
	 * output cost half a turn and that is true of the case it describes and not
	 * of this one. On a one-step scorer, same model, same prompt, same fields,
	 * reasoning disabled on both, six runs each: tools 11.43s median and 892
	 * output tokens, structured 9.52s and 655. Structured was faster, cheaper,
	 * and the only one to fill every field on every run. The 5,858ms figure was
	 * a schema attached to an eight-step navigation loop — a statement about how
	 * many steps pay for it, not about what it costs per call. Which is why this
	 * is a choice rather than a replacement.
	 */
	reply?: "tools" | "structured";
	/**
	 * Which model runs each screen, when it should not be the one that answers.
	 *
	 * A screen is a short classification over a message that already exists —
	 * it writes a label, not prose — and there is no reason it should cost what
	 * an answer costs. This was one deployment-wide value covering all of them
	 * at once, which is the wrong shape twice over: the steps have genuinely
	 * different jobs (a four-way scope verdict is not the same task as picking
	 * one escalation out of nine), and a workspace on its own key cannot use a
	 * model the deployment reaches with ours.
	 *
	 * Per step, and every field optional. Absent falls back to the deployment's
	 * default and then to the answering model, so a policy that says nothing
	 * behaves exactly as it did.
	 */
	screens?: ScreenModels;
	/**
	 * Ceiling on what one step may generate. Absent means `DEFAULT_OUTPUT_BUDGET`.
	 *
	 * 1200 was the only value for as long as a reply was prose plus a next step,
	 * and it is right for that: an answer that long is already past what anyone
	 * reads, so the cap doubled as a length guard.
	 *
	 * It stops being right when the reply tool IS the product. An agent whose
	 * fields are a scorecard — four scores, four justifications, a summary, a
	 * per-agent breakdown — emits all of it as one tool call, and hitting the
	 * ceiling truncates the JSON mid-string rather than dropping a field. That
	 * matters because the two failures are not equally recoverable:
	 * `experimental_repairToolCall` fills a field the model left out, but it
	 * parses the arguments first, and half a string is not parseable. So the
	 * call errors, the step retries, the retry truncates in the same place, and
	 * the turn ends `declined` having spent the budget twice. Observed exactly
	 * so on the first scorecard agent: two steps, 1200 output tokens each, both
	 * discarded.
	 *
	 * Per policy rather than a raised constant because the constant is load
	 * bearing where it is. Raising it globally would quietly buy every chat
	 * agent permission to write twice as much, which is a product change made by
	 * accident.
	 */
	outputBudget?: number;
}

/** What a step may generate when the policy does not say. */
export const DEFAULT_OUTPUT_BUDGET = 1200;

/** The scalar shapes a reply field may take. Absent means `string`. */
export type ReplyFieldType = "string" | "integer" | "number" | "boolean";

/** One field of a reply. */
export interface ReplyField {
	/** Argument name the model fills. `message` is conventional for the text the person reads. */
	name: string;
	/** Told to the model: what goes in this field. */
	describes: string;
	optional?: boolean;
	/** Fix the field to one of these values. */
	values?: string[];
	/**
	 * What kind of value this is. Absent means `string`, which is what every
	 * field was before this existed.
	 *
	 * Everything was a string because the first agents replied in prose, and it
	 * stayed that way long enough to distort the things built on top: a scorer
	 * returning 1-4 had to declare `values: ["1","2","3","4"]` and hand its
	 * caller `"1"`, so every reader of a score had to know to cast it. The type
	 * is here so a number can be a number.
	 *
	 * `values` still narrows: with `type: "integer"` it is the set of permitted
	 * integers, and the strings are parsed. A field with `values` and no type
	 * stays a string enum, so nothing that exists today changes shape.
	 */
	type?: ReplyFieldType;
}

/**
 * A tool the model calls to reply. Calling it ends the turn once its checks
 * pass, and the fields named in `say` are what the person reads, joined by a
 * blank line in that order.
 */
export interface ReplyTool {
	id: string;
	/** Told to the model: when to use this tool and what it does. */
	describes: string;
	fields: ReplyField[];
	/** Which fields compose the reply the person sees, in order. Default: `["message"]`. */
	say?: string[];
}

/**
 * A rule evaluated against a tool call before it executes.
 *
 * `when` is a CEL expression over `args` (the call's arguments) and `turn`
 * (`step`, `stepsLeft`, `opened`, `openedLeaf`, `history`), with `words(s)`
 * available. True means the call is refused and `say` goes back to the model.
 * CEL rather than code because a rule is something a policy owner reads and
 * signs; rather than JsonLogic because a one-line expression is legible in a
 * console field the way a regex is. It is compiled where it is saved, so a rule
 * that does not parse fails in the editor and never at answer time.
 */
export interface ToolCheck {
	id: string;
	/** Which tool this applies to. */
	tool: string;
	when: string;
	/** Handed back to the model when the check fires. Say what to do instead. */
	say: string;
	/** Why this exists. */
	because?: string;
}
