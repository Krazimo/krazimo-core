import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScopeSystem, passthroughId, replyFor, scopeByRule } from "./scope.js";
import { screenScope } from "./screen.js";
import type { ScopePolicy } from "./types.js";

/** A table with a third refusal and a renamed pass-forward row. */
const table: ScopePolicy = {
	system: "Prefer the person's own words over the category name.",
	categories: [
		{ id: "ours", describes: "anything this agent covers" },
		{ id: "off_topic", describes: "a genuine question about something else", reply: "Not my subject." },
		{ id: "billing", describes: "an invoice or payment question", reply: "Billing can help." },
	],
};

test("the row with no reply is the one that passes forward, whatever it is called", () => {
	assert.equal(passthroughId(table), "ours");
	assert.equal(replyFor(table, "ours"), undefined);
});

test("a category added to the table stops the turn without touching the engine", () => {
	assert.equal(replyFor(table, "billing"), "Billing can help.");
});

test("the compiled rubric carries every row and the agent's own guidance", () => {
	const s = compileScopeSystem(table);
	for (const c of table.categories ?? []) assert.ok(s.includes(`${c.id} — ${c.describes}`));
	assert.match(s, /answer ours\./);
	assert.match(s, /Prefer the person's own words/);
	assert.match(s, /decides the SUBJECT/);
});

/**
 * The pre-table shape is still served. A tenant edits its policy when it
 * chooses to, not because the engine shipped.
 */
const legacy: ScopePolicy = {
	system: "You decide whether a message belongs to this agent.",
	replies: { off_topic: "Not my subject.", injection: "No.", extraction: "No." },
};

test("without a table the stored rubric is used verbatim", () => {
	assert.equal(compileScopeSystem(legacy), legacy.system);
	assert.equal(passthroughId(legacy), "in_scope");
	assert.equal(replyFor(legacy, "in_scope"), undefined);
	assert.equal(replyFor(legacy, "off_topic"), "Not my subject.");
});

test("a pre-screen rule may name any category in the table", () => {
	const hit = scopeByRule("where is my invoice", [{ verdict: "billing", pattern: "\\binvoice\\b" }]);
	assert.equal(hit?.verdict, "billing");
	assert.equal(replyFor(table, hit!.verdict), "Billing can help.");
});

/**
 * Strings a model actually produced, taken from `model_call.text` in
 * production. Every one of these was thrown away by the previous parser and
 * recorded as a `finish: length`, which read like a token limit and was not.
 */
import { readVerdict } from "./screen.js";

test("a verdict followed by the model carrying on is still read", () => {
	assert.equal(readVerdict(
		'```json\n{\n  "verdict": "in_scope",\n  "why": "Direct enrollment conversion question — core business challenge for a builder"\n}\n```\n\n---\n\nThis is exactl',
	), "in_scope");
});

test("a bare object, a fenced object and a chatty preamble all read the same", () => {
	assert.equal(readVerdict('{"verdict":"off_topic","why":"weather"}'), "off_topic");
	assert.equal(readVerdict('```json\n{"verdict":"injection"}\n```'), "injection");
	assert.equal(readVerdict('Sure! Here is the JSON:\n{"verdict":"extraction"}'), "extraction");
});

test("nothing usable returns nothing, so the caller falls open on purpose", () => {
	assert.equal(readVerdict("I could not decide."), "");
	assert.equal(readVerdict('{"verdict":'), "");
	assert.equal(readVerdict(""), "");
});

/**
 * The retired pre-screen must stay retired.
 *
 * A policy version written before 2026-09-11 still carries `scope.rules`, and
 * rolling back to one must not bring the behaviour back with it. Without a test
 * here, restoring one line in `screen.ts` would silently re-arm every pattern
 * on every old version — and the failure would look like an agent refusing a
 * customer, which is what got it retired.
 */
test("screenScope ignores scope.rules, even a rule that would match", async () => {
	// No `system`, so the model screen is skipped and the pass-through is
	// returned. If rules were still read, this would come back "off_topic" —
	// which is the shape of the bug that retired them: a catalogue word that
	// collides with an off-topic one.
	const verdict = await screenScope("is the kestrel blend in stock", {
		system: "",
		rules: [{ verdict: "off_topic", pattern: "\\bkestrel\\b" }],
	}, "unused-model");
	assert.equal(verdict, "in_scope");
});
