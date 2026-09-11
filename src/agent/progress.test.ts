/**
 * Progress reporting must never cost a turn, and a folder's name must come from
 * the library rather than from a table in some console.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emit, folderLabel, type TurnEvent } from "./index.js";

test("emit delivers the event", () => {
	const seen: TurnEvent[] = [];
	emit((e) => seen.push(e), { kind: "screening" });
	assert.deepEqual(seen, [{ kind: "screening" }]);
});

test("a subscriber that throws does not fail the turn", () => {
	assert.doesNotThrow(() => emit(() => { throw new Error("spinner broke"); }, { kind: "guarding" }));
});

test("no subscriber is a no-op", () => {
	assert.doesNotThrow(() => emit(undefined, { kind: "guarding" }));
});

test("a real heading names the folder", () => {
	assert.equal(
		folderLabel("# The Grounding Sequence\n\nAn introduction…",
			"knowledge/wellness/recommendations/grounding"),
		"The Grounding Sequence",
	);
});

test("a heading that only echoes the folder falls back to the folder, read aloud", () => {
	assert.equal(
		folderLabel("# for-feeling\n\n- [Abandoned](abandoned.md)",
			"knowledge/wellness/recommendations/for-feeling"),
		"for feeling",
	);
	// Punctuation and case are not a difference: "# Rank and pay" over
	// `rank-and-pay` is still the slug, and shows as the slug.
	assert.equal(folderLabel("# Rank and pay", "knowledge/business/rank-and-pay"), "rank and pay");
});

test("no heading at all still names the folder", () => {
	assert.equal(folderLabel("- [A](a.md)\n- [B](b.md)", "wellness/products"), "products");
});

test("a folder with nothing left after the quotes is the library, not a folder called \"\"", () => {
	// `folderLabel` never sees this case — the caller resolves an empty path to
	// the library — but the humanising it falls back to must not turn punctuation
	// into a name either.
	assert.equal(folderLabel("# products", "wellness/products"), "products");
	assert.equal(folderLabel("", ""), "");
});
