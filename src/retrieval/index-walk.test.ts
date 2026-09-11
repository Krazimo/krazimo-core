import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { IndexWalk } from "./index-walk.js";
import type { Mount } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = path.resolve(here, "../../test/fixtures");

const mounts: Mount[] = [
	{ id: "a", mountAs: "wellness", root: path.join(fx, "kb-a"), priority: 1 },
	{ id: "b", mountAs: "safety", root: path.join(fx, "kb-b"), priority: 2 },
];
const kb = new IndexWalk({ mounts });
const TOOL_TAG = "</" + "antml:parameter>";

test("root listing composes every mount", () => {
	const r = kb.list("");
	assert.equal(r.outcome, "ok");
	assert.match(r.text, /wellness\//);
	assert.match(r.text, /safety\//);
});

test("opens a document under its mount", () => {
	const r = kb.open("wellness/sleep/trouble-sleeping.md");
	assert.equal(r.outcome, "ok");
	assert.match(r.text, /Lavender/);
	assert.equal(r.target, "wellness/sleep/trouble-sleeping.md");
});

test("refuses a path no listing ever offered, and names the neighbours", () => {
	const r = kb.open("wellness/sleep/insomnia-cure.md");
	assert.equal(r.outcome, "refused");
	assert.match(r.text, /trouble-sleeping\.md/);
});

test("resolves an unambiguous near-miss and records that it did", () => {
	// The model reaching for the display title rather than the link target.
	const r = kb.open("wellness/sleep/Trouble Sleeping.md");
	assert.equal(r.outcome, "resolved");
	assert.equal(r.target, "wellness/sleep/trouble-sleeping.md");
});

test("refuses a traversal attempt", () => {
	const r = kb.open("wellness/../../../etc/passwd");
	assert.equal(r.outcome, "refused");
});

test("refuses an unknown mount rather than guessing which base was meant", () => {
	const r = kb.open("nonsense/whatever.md");
	assert.equal(r.outcome, "refused");
	assert.match(r.text, /No knowledge base called/);
});

test("find searches across mounts and refuses when nothing matches", () => {
	const hit = kb.find("carrier oil");
	assert.equal(hit.outcome, "ok");
	assert.match(hit.text, /safety\/dilution\.md/);

	const miss = kb.find("cryptocurrency");
	assert.equal(miss.outcome, "refused");
	assert.match(miss.text, /rather than answering from memory/);
});

test("cites a document from its own front matter, never an index", () => {
	const c = kb.citationFor("wellness/sleep/trouble-sleeping.md");
	assert.equal(c?.title, "Trouble falling or staying asleep");
	assert.equal(kb.citationFor("wellness/sleep/INDEX.md"), null);
	// A shard is a piece of the same map, so it is no more citable than the map.
	assert.equal(kb.citationFor("wellness/sleep/INDEX-01.md"), null);
});

test("a single mount does not require its name in the path", () => {
	const one = new IndexWalk({ mounts: [mounts[0]!] });
	assert.equal(one.open("sleep/trouble-sleeping.md").outcome, "ok");
});

test("the three tools are what the model sees", () => {
	assert.deepEqual(kb.tools().map((t) => t.name), ["list", "open", "find"]);
});

/**
 * Paging, and the truncation it replaced.
 *
 * A tiny page budget stands in for a real one: the behaviour under test is that
 * nothing is lost and the model is told where it is, not the size of the
 * window. The old code cut at the budget, appended "[truncated]" and offered no
 * way to read the rest — so the assertion that matters most is the last one.
 */
const paged = new IndexWalk({ mounts, pageChars: 120 });
const LONG = "wellness/sleep/trouble-sleeping.md";

test("a document that fits gets no banner", () => {
	const whole = kb.open(LONG);
	assert.equal(whole.outcome, "ok");
	assert.doesNotMatch(whole.text, /lines \d+-\d+ of/);
	assert.doesNotMatch(whole.text, /more lines/);
});

test("a document that does not fit is paged, not cut", () => {
	const first = paged.open(LONG);
	assert.equal(first.outcome, "ok");
	assert.match(first.text, /lines 1-\d+/);
	assert.match(first.text, /characters are not shown/);
	// The offset to continue with is stated, not implied.
	assert.match(first.text, /from \d+ for the next page/);
	assert.doesNotMatch(first.text, /truncated/);
});

test("paging reaches the end and reassembles the whole document", () => {
	const source = kb.open(LONG).text;
	const total = source.split("\n").length;

	let from = 0;
	const seen: string[] = [];
	for (let guard = 0; guard < 50; guard += 1) {
		const r = paged.open(LONG, from);
		assert.equal(r.outcome, "ok");
		// Cut on the delimiters, not on line counts. `slice(1, -2)` encoded
		// "one banner line, then a blank and a note" — reword the note across two
		// lines and it silently drops a body line, surfacing as a reassembly
		// mismatch that points at the paging logic rather than at this test.
		const body = r.text.slice(r.text.indexOf("\n") + 1, r.text.lastIndexOf("\n\n["));
		seen.push(body);
		assert.ok(body.length <= 120, `a page was ${body.length} chars, budget is 120`);
		const more = /from (\d+) for the next page/.exec(r.text);
		if (!more) {
			assert.match(r.text, /\[end of document\]/);
			break;
		}
		const next = Number(more[1]);
		assert.ok(next > from, "an offset that does not advance would loop forever");
		from = next;
	}
	// Every character arrived exactly once, in order. Pages carry their own
	// line breaks now — the cut keeps the newline it cut on — so they
	// concatenate rather than join.
	assert.equal(seen.join(""), source);
	assert.equal(seen.join("").split("\n").length, total);
});

test("reading past the end says so instead of returning an empty page", () => {
	const r = paged.open(LONG, 99_999);
	assert.match(r.text, /there is nothing at 99999/);
});

test("a line longer than the whole budget is cut, not handed back whole", () => {
	// Ingestion writes a document's entire body as one line, so 587 of 1,702
	// documents in the corpus this was built for carry a line longer than a
	// page. Forcing the longest through whole returned 74,763 characters —
	// 5.3x the hard cap that paging replaced. A bounded page is the point.
	const oneLine = new IndexWalk({ mounts, pageChars: 200 });
	let from = 0;
	let saidMidLine = false;
	for (let guard = 0; guard < 60; guard += 1) {
		const r = oneLine.open("wellness/sleep/one-long-line.md", from);
		assert.equal(r.outcome, "ok");
		const body = r.text.slice(r.text.indexOf("\n") + 1, r.text.lastIndexOf("\n\n["));
		// The property that matters: no page exceeds the budget, whatever the
		// document's line structure. This is what the old escape hatch broke.
		assert.ok(body.length <= 200, `page was ${body.length} chars, budget was 200`);
		if (/stops mid-sentence because the line is longer than a page/.test(r.text)) {
			saidMidLine = true;
		}
		const more = /from (\d+) for the next page/.exec(r.text);
		if (!more) break;
		from = Number(more[1]);
	}
	assert.ok(saidMidLine, "a mid-line cut has to be admitted, not silent");
});

test("listing an indexed folder returns the index itself, and names what it leaves out", () => {
	// Forty filenames with the index first and a note to read it were still
	// skipped; the map is the listing, so there is nothing to skip.
	const r = kb.list("wellness/sleep");
	assert.equal(r.outcome, "ok");
	assert.match(r.text, /^=== wellness\/sleep\/INDEX\.md ===\n# Sleep and rest/);
	assert.match(r.text, /Trouble sleeping/);
	// one-long-line.md is linked from no index in the folder; a shard is an
	// index and is never reported as missing from one.
	assert.match(r.text, /Not in the index: one-long-line\.md/);
	assert.doesNotMatch(r.text, /Not in the index:.*INDEX-01/);
	assert.equal(r.target, "wellness/sleep/INDEX.md");
});

test("a folder with no index still lists its filenames", () => {
	const r = kb.list("wellness/shared");
	assert.equal(r.outcome, "ok");
	assert.match(r.text, /^x\.md/);
});

test("open advertises the offset it accepts", () => {
	const open = kb.tools().find((t) => t.name === "open");
	const props = (open?.parameters as { properties: Record<string, unknown> }).properties;
	assert.ok("from" in props, "the model cannot page with a parameter it is not shown");
});

test("a bare path resolves when exactly one mount has it", () => {
	// Two libraries mounted side by side, and an instruction written when there
	// was only one: "start at products/needs/INDEX.md". With a single mount the
	// name was optional and that path worked. With two it is refused, and the
	// agent spends a step discovering the prefix on EVERY need question —
	// measured on the deployment: open REFUSED, then open again with
	// "wellness/" in front, out of a budget of eight.
	//
	// A path that exists under exactly one mount is not ambiguous, so refusing
	// it protects nothing. Two mounts holding the same path IS ambiguous, and
	// that still refuses — same rule as resolveNear: an unambiguous match is
	// worth accepting and a coin flip is not.
	// `sleep/trouble-sleeping.md` exists under the wellness mount only.
	const r = kb.open("sleep/trouble-sleeping.md");
	assert.equal(r.outcome, "resolved");
	assert.equal(r.target, "wellness/sleep/trouble-sleeping.md");
	assert.match(r.text, /Lavender/);
});

test("a bare path that two mounts both hold is still refused", () => {
	// INDEX.md sits at the root of both mounts. Guessing which was meant is the
	// error this whole strategy exists to avoid.
	const r = kb.open("INDEX.md");
	assert.equal(r.outcome, "refused");
	assert.match(r.text, /wellness/);
	assert.match(r.text, /safety/);
});

test("list resolves a bare folder only one mount holds", () => {
	// `open` learned this and `list` did not, so production traces open with
	// `refused list("diagnostics")` then `ok list("builder/diagnostics")` — a
	// whole round trip, and a re-send of the prompt so far, to learn a prefix
	// the engine could supply. `sleep/` is under the wellness mount only.
	const r = kb.list("sleep");
	assert.equal(r.outcome, "ok");
	assert.match(r.text, /trouble-sleeping\.md/);
});

test("list still refuses a bare folder name no mount holds", () => {
	const r = kb.list("diagnostics");
	assert.equal(r.outcome, "refused");
	assert.match(r.text, /wellness/);
	assert.match(r.text, /safety/);
});

// Three shapes a model actually sent for "no path", all from production traces.
// Each cost a refused first call, a round trip and a re-send of the whole prompt.
for (const [name, arg] of [
	["the two characters the prompt used to show", '""'],
	["a bare newline", "\n"],
	["its own tool-call closing tag, leaked by the provider", TOOL_TAG],
	["whitespace", "   "],
] as const) {
	test(`a malformed empty path (${name}) returns the root, not a refusal`, () => {
		const r = kb.list(arg);
		assert.equal(r.outcome, "ok");
		assert.match(r.text, /wellness\//);
		assert.match(r.text, /safety\//);
	});
}

test("a real path wrapped in quotes is still that path", () => {
	// Seen in production: list('"builder"'). The model quotes the value as well
	// as passing it, and a mount name in quotes named no mount.
	const quoted = kb.list('"wellness"');
	assert.equal(quoted.outcome, "ok");
	assert.deepEqual(quoted.text, kb.list("wellness").text);
});

test("a genuinely wrong path is still refused, and still says what exists", () => {
	// The normalisation must not turn a real mistake into a silent root listing.
	const r = kb.list("nosuchlibrary");
	assert.equal(r.outcome, "refused");
	assert.match(r.text, /No knowledge base called "nosuchlibrary"/);
});

test("a folder name held by two libraries names both instead of denying it exists", () => {
	// Production: list("products") answered "No knowledge base called products"
	// while products/ sat in both. The model re-read the root to learn what the
	// engine already knew, costing a whole round trip out of a budget of eight.
	const r = kb.list("shared");
	assert.equal(r.outcome, "refused");
	assert.match(r.text, /more than one knowledge base/);
	assert.match(r.text, /wellness\/shared/);
	assert.match(r.text, /safety\/shared/);
	assert.doesNotMatch(r.text, /No knowledge base called/);
});

test("open() accepts a path the model wrapped in quotes", () => {
	// Production, seen in a playground traversal: list() had been taught to strip
	// quotes and open() had not, so a turn walked to the right folder and then
	// burned four steps being refused the two documents it had just been shown.
	// The answer was still right, which is why only the traversal revealed it.
	const quoted = kb.open('"wellness/sleep/trouble-sleeping.md"');
	assert.equal(quoted.outcome, "ok");
	assert.deepEqual(quoted.text, kb.open("wellness/sleep/trouble-sleeping.md").text);
});

test("open() still refuses a path that is genuinely wrong", () => {
	const r = kb.open("nosuchlibrary/nope.md");
	assert.equal(r.outcome, "refused");
	assert.match(r.text, /No knowledge base called "nosuchlibrary"/);
});

test("the root listing carries each library's own index, so the map is in view", () => {
	const r = kb.list("");
	assert.equal(r.outcome, "ok");
	assert.match(r.text, /=== wellness\/INDEX\.md ===/);
	assert.match(r.text, /=== safety\/INDEX\.md ===/);
});

test("find ranks a document that carries every word, and the title, above a passing mention", () => {
	// dilution.md is titled "Dilution and carrier oils" and says "carrier oil";
	// a page that merely mentions carrier once must not tie with it.
	const r = kb.find("carrier oil dilution");
	assert.equal(r.outcome, "ok");
	const first = r.text.split("\n")[0] ?? "";
	assert.match(first, /safety\/dilution\.md/);
	assert.match(first, /\(Dilution and carrier oils\)/);
});

test("an indexed folder whose filenames begin with digits still comes back as its index", () => {
	// Before the index was the listing, "349-…" sorted ahead of "INDEX.md" and
	// the signpost sat mid-list; now the digits never get the chance.
	const r = kb.list("wellness/numbered");
	assert.equal(r.outcome, "ok");
	assert.match(r.text, /^=== wellness\/numbered\/INDEX\.md ===/);
	assert.match(r.text, /\[349\]\(349-first\.md\)/);
	assert.doesNotMatch(r.text, /Not in the index/);
});
