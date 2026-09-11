import assert from "node:assert/strict";
import { test } from "node:test";
import { badCheck, compose, DEFAULT_CHECKS, DEFAULT_TOOLS, failingCheck, type TurnState } from "./reply.js";
import { parsePolicy } from "./load.js";

const turn = (over: Partial<TurnState> = {}): TurnState => ({
	step: 2, stepsLeft: 5, opened: ["a/INDEX.md", "a/b.md"], openedLeaf: true, history: 0, ...over,
});

test("the default check refuses a reply before anything is opened, and not after", () => {
	// The gate the loop used to enforce as code, now the one default check.
	const before = failingCheck(DEFAULT_CHECKS, "reply", { message: "x" }, turn({ opened: [], openedLeaf: false }));
	assert.equal(before?.id, "read_before_reply");
	assert.equal(failingCheck(DEFAULT_CHECKS, "reply", { message: "x" }, turn()), null);
});

test("a check applies to its tool only", () => {
	const checks = [{ id: "c", tool: "answer", when: "true", say: "no" }];
	assert.equal(failingCheck(checks, "ask", {}, turn())?.id, undefined);
	assert.equal(failingCheck(checks, "answer", {}, turn())?.id, "c");
});

test("checks read the call's arguments and the turn, with words()", () => {
	const checks = [
		{ id: "two_moves", tool: "answer", when: "args.message.matches('\\\\?\\\\s*$')", say: "ask instead" },
		{ id: "budget", tool: "answer", when: "words(args.message) > 3", say: "shorter" },
		{ id: "late", tool: "answer", when: "turn.stepsLeft < 1", say: "n/a" },
	];
	assert.equal(failingCheck(checks, "answer", { message: "Which one fits?" }, turn())?.id, "two_moves");
	assert.equal(failingCheck(checks, "answer", { message: "one two three four." }, turn())?.id, "budget");
	assert.equal(failingCheck(checks, "answer", { message: "one two." }, turn()), null);
});

test("a check that reads a key the call lacks does not fire", () => {
	// An evaluation error must not become a refusal the model can never satisfy.
	const checks = [{ id: "c", tool: "answer", when: "args.nope == 'x'", say: "no" }];
	assert.equal(failingCheck(checks, "answer", { message: "hi" }, turn()), null);
});

test("badCheck names the parse error and accepts a good expression", () => {
	assert.equal(badCheck("!turn.openedLeaf && words(args.message) > 120"), null);
	assert.ok(badCheck("args.message.matches("));
});

test("compose says the named fields in order and skips a repeated tail", () => {
	const t = { ...DEFAULT_TOOLS[0]!, say: ["message", "next_step"] };
	assert.equal(compose(t, { message: "Do A.", next_step: "Then B." }), "Do A.\n\nThen B.");
	assert.equal(compose(t, { message: "Do A. Then B.", next_step: "Then B." }), "Do A. Then B.");
	assert.equal(compose({ ...t, say: ["message"] }, { message: "Only this.", next_step: "ignored" }), "Only this.");
});

test("parsePolicy refuses a check that does not parse or names no tool", () => {
	const base = "id: p\nversion: 1\nconstitution: x\n";
	assert.throws(() => parsePolicy(base + "checks:\n  - id: c\n    tool: reply\n    when: 'args.message.matches('\n    say: no\n"), /does not parse/);
	assert.throws(() => parsePolicy(base + "tools:\n  - id: ask\n    describes: q\n    fields: [{name: message, describes: m}]\nchecks:\n  - id: c\n    tool: answer\n    when: 'true'\n    say: no\n"), /names no reply tool/);
	assert.throws(() => parsePolicy(base + "tools:\n  - id: ask\n    describes: q\n    fields: [{name: message, describes: m}]\n    say: [nope]\n"), /not one of its fields/);
	assert.ok(parsePolicy(base + "tools:\n  - id: ask\n    describes: q\n    fields: [{name: message, describes: m}]\nchecks:\n  - id: c\n    tool: ask\n    when: 'words(args.message) > 40'\n    say: shorter\n"));
});

test("parsePolicy refuses a structured reply that cannot be one shape", () => {
	const base = "id: p\nversion: 1\nconstitution: x\n";
	const one = "tools:\n  - id: ask\n    describes: q\n    fields: [{name: message, describes: m}]\n";
	const two = one + "  - id: answer\n    describes: a\n    fields: [{name: message, describes: m}]\n";
	assert.throws(() => parsePolicy(base + "reply: json\n"), /tools" or "structured/);
	// A schema is ONE shape, so a policy offering the model a choice of replies
	// cannot be expressed as one — and a check intercepts a tool CALL, so under
	// a schema it would silently never run.
	assert.throws(() => parsePolicy(base + two + "reply: structured\n"), /cannot offer a choice/);
	assert.throws(() => parsePolicy(base + one
		+ "checks:\n  - id: c\n    tool: ask\n    when: 'true'\n    say: no\nreply: structured\n"), /never run/);
	assert.ok(parsePolicy(base + one + "reply: structured\n"));
	assert.ok(parsePolicy(base + two + "reply: tools\n"));
});

test("parsePolicy refuses a field type nothing can compile", () => {
	const base = "id: p\nversion: 1\nconstitution: x\n";
	const f = (extra: string) =>
		`tools:\n  - id: ask\n    describes: q\n    fields: [{name: score, describes: s, ${extra}}]\n    say: [score]\n`;
	assert.throws(() => parsePolicy(base + f("type: date")), /string, integer, number or boolean/);
	// A numeric enum whose members are not numbers is a schema nothing
	// satisfies: the model would be refused every turn rather than told.
	assert.throws(() => parsePolicy(base + f("type: integer, values: ['0', four]")), /must be numeric, got four/);
	assert.ok(parsePolicy(base + f("type: integer, values: ['0', '1']")));
	assert.ok(parsePolicy(base + f("type: boolean")));
});
