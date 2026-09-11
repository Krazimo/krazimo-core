/**
 * What a memory brief is FOR has to travel with it.
 *
 * The brief is prepended to the user's message, so "products they own:
 * Lavender, Peppermint" lands immediately before the question while the
 * constitution sits far above in a cached system block. Recency won: asked
 * about aching legs, the mentor opened with Peppermint — an "also helps if
 * they have it" entry — on a shelf whose primaries are Eucalyptus. Same for
 * focus, insects and stale breath. Their reviewer: "almost every response is
 * suggesting peppermint."
 *
 * Nothing was wrong with the facts. They arrived unlabelled, and an unlabelled
 * list of products next to a question reads as a shortlist to answer from.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { composeUserMessage } from "./brief.js";

test("a message with no brief is passed through untouched", () => {
	assert.equal(composeUserMessage(undefined, "My legs ache"), "My legs ache");
	assert.equal(composeUserMessage("", "My legs ache"), "My legs ache");
});

test("a brief is labelled as background rather than left bare", () => {
	const out = composeUserMessage("products they own: Lavender, Peppermint", "My legs ache");

	// The facts survive.
	assert.match(out, /products they own: Lavender, Peppermint/);
	// The question is still the last thing the model reads.
	assert.ok(out.trimEnd().endsWith("My legs ache"));
	// And the brief says what it is for, so it is not read as a shortlist.
	assert.match(out, /background/i);
	assert.match(out, /not a shortlist|not a list to recommend from/i);
});

test("the brief is delimited so it cannot be read as part of the question", () => {
	const out = composeUserMessage("role: customer", "What should I use?");
	const briefAt = out.indexOf("role: customer");
	const questionAt = out.indexOf("What should I use?");
	assert.ok(briefAt >= 0 && questionAt > briefAt, "brief must precede the question");
	// Something separates them; a bare blank line was what let them run together.
	assert.match(out.slice(briefAt, questionAt), /\[|\]|---/);
});
