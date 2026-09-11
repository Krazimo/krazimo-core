import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGuards } from "./guards.js";
import type { GuardRule } from "./types.js";

const income: GuardRule = {
	id: "no_income_figure",
	when: "\\bearn\\w*|\\bhow much\\b",
	detect: "(\\$\\s?[\\d,]+(\\.\\d+)?)|(\\b\\d[\\d,]*\\s?(dollars|per\\s+month|a\\s+month))",
	action: "strip",
	replacement: "I can't tell you what you'll earn.",
};

test("strips a figure and leaves the rest of the answer", () => {
	const v = applyGuards(
		"Tier Two is a real milestone. Members at Tier Two earn $1,200 per month on average. Focus on the activity instead.",
		[income],
		{ question: "how much will I earn at Tier Two?", sourceText: "" },
	);
	assert.equal(v.applied[0]?.id, "no_income_figure");
	assert.ok(!v.text.includes("$1,200"));
	assert.match(v.text, /Focus on the activity/);
});

test("repairs a quote orphaned by the strip", () => {
	const v = applyGuards(
		'The document carries this: *"Results vary. Tier Two earned $1,200 per month."*',
		[income],
		{ question: "how much do I earn", sourceText: "" },
	);
	assert.ok(!v.text.includes("$1,200"));
	// The opener must not be left dangling with nothing to close it.
	assert.equal((v.text.match(/"/g) ?? []).length % 2, 0);
});

test("falls back to the replacement when stripping empties the answer", () => {
	const v = applyGuards("You'll earn $4,000 a month.", [income], {
		question: "how much will I earn",
		sourceText: "",
	});
	assert.equal(v.text, "I can't tell you what you'll earn.");
});

test("an unsourced rule ignores a figure that is actually in the source", () => {
	const rule: GuardRule = { id: "r", detect: "\\b\\d[\\d,]*\\s*points\\b", unsourced: true, action: "replace", replacement: "NOPE" };
	const inSource = applyGuards("Tier Two needs 9,000 points.", [rule], { question: "q", sourceText: "Tier Two requires 9000 points of volume." });
	assert.equal(inSource.applied.length, 0, "a sourced figure must pass");

	const invented = applyGuards("Tier Two needs 9,000 points.", [rule], { question: "q", sourceText: "nothing numeric here" });
	assert.equal(invented.text, "NOPE");
});

test("a `when` that does not match means the guard never runs", () => {
	const v = applyGuards("The kit costs $275.", [income], { question: "what does the kit cost?", sourceText: "" });
	assert.equal(v.applied.length, 0);
	assert.match(v.text, /\$275/);
});

test("retry short-circuits the remaining guards", () => {
	const toolcall: GuardRule = { id: "leak", detect: "(?:^|\\n|\\s)(?:list|open)\\s*\\(", action: "retry" };
	const v = applyGuards('Let me look. open("a.md")', [toolcall, income], { question: "q", sourceText: "" });
	assert.equal(v.retry, true);
	assert.deepEqual(v.applied.map((a) => a.id), ["leak"]);
});

test("a non-distinctive ratio is not excused by its digits appearing somewhere", () => {
	// 1, 3 and 5 appear in any library of any size. Treating that as evidence
	// called every invented dilution ratio sourced and the guard never fired.
	const rule: GuardRule = {
		id: "no_numeric_dilution",
		detect: "\\b\\d\\s*[-–]\\s*\\d\\s*drops?\\b[^.]{0,30}\\b(?:teaspoon|tsp|ml)\\b",
		unsourced: true,
		action: "replace",
		replacement: "I'm not going to give you a drops-per-teaspoon figure.",
	};
	const source =
		"Dilute with a carrier oil. Use 1 part to more carrier for a child. Episode 5 covers this. Chapter 3.";
	const v = applyGuards("Use 1-3 drops per teaspoon of carrier oil.", [rule], { question: "how much do I dilute", sourceText: source });
	assert.match(v.text, /not going to give you/);
});

test("a distinctive figure that is genuinely in the source still passes", () => {
	const rule: GuardRule = { id: "r", detect: "\\$\\s?[\\d,]+", unsourced: true, action: "strip" };
	const v = applyGuards("The kit costs $275.", [rule], { question: "q", sourceText: "Intro Kit — 275 USD" });
	assert.equal(v.applied.length, 0);
});

test("a money figure with a period attached is an earnings claim without any earnings word", () => {
	// "$500-$2,400+ per month" slipped a keyword-only pattern: the sentence said
	// range, medians and results vary, and none of those are earnings words.
	const stated: GuardRule = {
		id: "no_income_figure_stated",
		detect: "[^.!?]*(?:\\$\\s?[\\d,]+(?:\\.\\d+)?)[^.!?]*(?:\\b(?:earn|income|commission|bonus)\\b|\\b(?:per|a|each)\\s+(?:month|year|week)\\b|\\bmonthly\\b)[^.!?]*",
		action: "strip",
		replacement: "I can't put a number on it.",
	};
	const v = applyGuards(
		"The guide shows a range for the mid-tier band of $500–$2,400+ per month, but those are medians. Focus on the activity.",
		[stated],
		{ question: "is the incentive programme worth doing?", sourceText: "" },
	);
	assert.ok(!v.text.includes("500"), "the figure must not survive");
	assert.match(v.text, /Focus on the activity/, "the rest of the answer should remain");
});
