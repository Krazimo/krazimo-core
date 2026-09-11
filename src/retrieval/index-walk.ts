/**
 * Index-walking retrieval.
 *
 * The model is given a tree of markdown and three tools to move through it. It
 * reads an index, opens what the index names, and answers from what it opened.
 * There is no similarity search anywhere in the path — a nearest neighbour is
 * something the model cannot verify, and an exact filename is.
 *
 * The guarantee this buys: `open` refuses a path no listing ever offered, so an
 * answer either came from a document that exists or it did not happen. Nothing
 * in a prompt can produce that; it comes from the tool saying no.
 *
 * Ported from an earlier single-deployment implementation, with the two-root
 * assumption removed.
 * Comments explaining a rule are kept verbatim wherever the rule survived —
 * each one records a failure that was observed and fixed, and losing them would
 * mean rediscovering it.
 */
import fs from "node:fs";
import path from "node:path";
import type {
	Citation,
	Mount,
	RetrievalStrategy,
	ToolResult,
	ToolSpec,
} from "./types.js";

/** How deep the root listing describes the shape before it stops. */
/** A root index longer than this is cut; the map is meant to be read, not paged. */
const MAX_ROOT_INDEX_CHARS = 12_000;
const MAX_TREE_DEPTH = 3;
/** And how many folders it will name, so a large corpus cannot make it huge. */
const MAX_TREE_LINES = 80;

/**
 * How much of a document one `open` returns. A window, not a limit.
 *
 * This used to cut here and append "[truncated]". On the deployment it was
 * written for that removed most of 656 of 1,629 documents — 40% of the library
 * — and left the two largest indexes 7% and 8% visible, so the agent cited
 * pages it had read a third of: an answer that looks sourced and is not.
 *
 * The number was never the mistake — a 310,323-character document is ~78,000
 * tokens and cannot arrive in one tool result on a step budget of eight. Hiding
 * the decision was. The window is now announced and the rest is reachable.
 */
// Raised from 14,000 in Sept 2026: a deployment's products index became a
// single flat name-lookup list (one line per product, no letter shards) and
// needs ~16k. A name list must arrive whole — a split list reintroduces the
// "which shard?" guess the flat list exists to remove.
export const PAGE_CHARS = 20_000;

export interface IndexWalkOptions {
	mounts: Mount[];
	/** Characters per page of `open`. Renamed from `maxFileChars`, which cut. */
	pageChars?: number;
}

/** How many newlines precede `i`, i.e. the 0-based line `i` sits on. */
function countLines(text: string, i: number): number {
	let n = 0;
	for (let k = text.indexOf("\n"); k !== -1 && k <= i; k = text.indexOf("\n", k + 1)) n += 1;
	return n;
}

/**
 * What the model MEANT by a path, as opposed to what it typed.
 *
 * Models quote the value as well as passing it — `open("\"builder/rank/x.md\"")`
 * arrives with the quote characters inside the string — and some providers leak
 * the model's own tool-call markup into an argument that was meant to be empty.
 * Neither is a path anyone could have intended, and both are refused by every
 * check below for the right reason and the wrong outcome: a round trip, a
 * re-send of the whole prompt so far, and a retry that gets it right.
 *
 * Shared by `list` and `open` because it was NOT, once. `list` learned to strip
 * quotes and `open` did not, so a turn walked the tree correctly and then spent
 * four steps being refused the two documents it had just been shown — visible
 * only in the traversal, because the answer came out right in the end.
 */
function askedPath(p: string | undefined): string {
	return (p ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}

export class IndexWalk implements RetrievalStrategy {
	readonly kind = "index-walk";
	readonly #mounts: Mount[];
	readonly #pageChars: number;

	constructor(opts: IndexWalkOptions) {
		if (!opts.mounts.length) throw new Error("index-walk needs at least one mount");
		const seen = new Set<string>();
		for (const m of opts.mounts) {
			if (seen.has(m.mountAs)) throw new Error(`duplicate mount name: ${m.mountAs}`);
			seen.add(m.mountAs);
		}
		this.#mounts = [...opts.mounts].sort((a, b) => a.priority - b.priority);
		this.#pageChars = opts.pageChars ?? PAGE_CHARS;
	}

	/**
	 * Split a model-supplied path into the mount it names and the rest.
	 *
	 * With one mount the name is optional, so a single-knowledge-base agent sees
	 * exactly the tree it had before mounting existed. With several it is
	 * required, because a bare path would be ambiguous and guessing which base
	 * was meant is the same class of error as guessing which document.
	 */
	#split(p: string): { mount: Mount; rest: string } | null {
		const clean = (p ?? "").replace(/^\/+/, "");
		const head = clean.split("/")[0] ?? "";
		const hit = this.#mounts.find((m) => m.mountAs === head);
		if (hit) return { mount: hit, rest: clean.slice(head.length).replace(/^\/+/, "") };
		if (this.#mounts.length === 1) {
			const only = this.#mounts[0];
			return only ? { mount: only, rest: clean } : null;
		}
		return null;
	}

	/**
	 * The mount that holds a path, when the model did not name one.
	 *
	 * With several mounts `#split` refuses a bare path, on the reasoning that
	 * guessing which library was meant is the same class of error as guessing
	 * which document. That is right when the path is ambiguous and needlessly
	 * strict when it is not.
	 *
	 * It cost a step on every need question. The wellness constitution says
	 * "start at products/needs/INDEX.md" — written when there was one mount and
	 * the name was optional — and after a second library was mounted alongside,
	 * every turn opened that path, was refused, read the top-level listing, and
	 * opened it again with a prefix. Three calls to reach the first document,
	 * out of a budget of eight.
	 *
	 * So: exactly one mount holding the path is not a guess, and resolving it is
	 * recorded as `resolved` like any other correction. Two mounts holding it IS
	 * a guess and still refuses — the same line `#resolveNear` draws.
	 */
	#bareMount(clean: string): Mount | null {
		const hits = this.#holders(clean);
		return hits.length === 1 ? (hits[0] ?? null) : null;
	}

	/** Every mount that actually holds this unprefixed path. */
	#holders(clean: string): Mount[] {
		if (this.#mounts.length < 2 || !clean) return [];
		const hits: Mount[] = [];
		for (const m of this.#mounts) {
			try {
				if (fs.existsSync(this.#safe(m, clean))) hits.push(m);
			} catch {
				/* outside that base: not a hit */
			}
		}
		return hits;
	}

	/**
	 * Resolve a model-supplied path inside one mount.
	 *
	 * The model is not an attacker, but it is a text generator that has read the
	 * whole internet, and "../../.env" is a string it can emit by accident.
	 */
	#safe(mount: Mount, rest: string): string {
		const base = path.resolve(mount.root);
		const full = path.resolve(base, rest.replace(/^\/+/, ""));
		if (full !== base && !full.startsWith(base + path.sep)) {
			throw new Error("path is outside this knowledge base");
		}
		return full;
	}

	/**
	 * The root listing, composed across every mount.
	 *
	 * Each knowledge base appears as one top-level entry, the way a filesystem
	 * mount does. Navigation below that point is unchanged, and a traversal log
	 * still names which library a page came from because the mount name is the
	 * first path segment.
	 */
	#listRoot(): string {
		// The whole shape at once, not one level of it.
		//
		// Measured on a live deployment: 126 `list` calls to 91 `open` calls, and
		// turns finishing at 5-7 steps of a budget of 8. The agent was spending
		// most of its allowance walking down to a folder it could have been shown
		// on the first call. Directories only — the files under them are what
		// `list` on that folder is for, and naming all of them here would trade
		// one problem for a larger one.
		const out: string[] = [];
		let truncated = false;

		const walk = (dir: string, prefix: string, depth: number) => {
			if (truncated || depth > MAX_TREE_DEPTH) return;
			let names: string[];
			try {
				names = fs.readdirSync(dir).sort();
			} catch {
				return;
			}
			for (const name of names) {
				if (truncated) return;
				const full = path.join(dir, name);
				let entries: string[];
				try {
					if (!fs.statSync(full).isDirectory()) continue;
					entries = fs.readdirSync(full);
				} catch {
					continue;
				}
				// A corpus with thousands of folders would turn this into the cost
				// it exists to avoid, so it stops and says it stopped rather than
				// silently showing a slice that reads as the whole thing.
				if (out.length >= MAX_TREE_LINES) {
					truncated = true;
					return;
				}
				out.push(`${prefix}${name}/  (${entries.length} items)`);
				walk(full, `${prefix}${name}/`, depth + 1);
			}
		};

		for (const m of this.#mounts) {
			const n = fs.existsSync(m.root) ? fs.readdirSync(m.root).length : 0;
			out.push(`${m.mountAs}/  (${n} items)`);
			if (fs.existsSync(m.root)) walk(m.root, `${m.mountAs}/`, 1);
		}

		if (truncated) {
			out.push(`… more folders not shown. Use list() on one above to go deeper.`);
		}

		// The map, not only the territory. Folder names and counts say where a
		// thing might be; the root INDEX.md of each library says what each
		// folder is FOR and where the specific things live, and until it was
		// here the model had to choose to open it — which it did not do when it
		// had already decided the answer was not in the library. About 2,500
		// tokens on the first step of a turn, cached from the second.
		for (const m of this.#mounts) {
			const index = path.join(m.root, "INDEX.md");
			if (!fs.existsSync(index)) continue;
			const body = fs.readFileSync(index, "utf8").slice(0, MAX_ROOT_INDEX_CHARS);
			out.push(`\n=== ${m.mountAs}/INDEX.md ===\n${body}`);
		}
		return out.join("\n");
	}

	list(p = ""): ToolResult {
		// Every way a model has been seen to say "no path", treated as no path.
		//
		// Asking for the root is the first call of almost every turn, and it is
		// the one most likely to arrive malformed, because the argument is meant
		// to be absent and "absent" is what serialisers get wrong. Three shapes
		// turned up in production traces: the two characters `""` (the prompt
		// said list("") and the model typed the quotes), a bare newline, and the
		// model's own tool-call closing tag leaking into the value through the
		// provider. All three mean the root, and refusing them costs a round trip
		// and a re-send of the whole prompt so far — the same argument the
		// `#bareMount` note below already makes for a different bad guess.
		//
		// A real path never begins with "<", so that test is narrow enough to
		// name the markup case without swallowing a genuine mistake.
		const asked = askedPath(p);
		if (!asked || asked === "/" || asked.startsWith("<")) {
			return { outcome: "ok", text: this.#listRoot() };
		}

		const clean = asked.replace(/^\/+/, "");
		const split = this.#split(asked);
		// The same correction `open` already makes, for the same reason it makes
		// it. `#bareMount` was added because an unprefixed path cost a step on
		// every need question — and then only `open` was taught to use it, so
		// `list` went on refusing the identical guess.
		//
		// It shows up in almost every production trace as the first thing that
		// happens: `refused list("diagnostics")`, then `ok list("builder/
		// diagnostics")`. A whole round trip, and at this point in a turn that is
		// several seconds and a re-send of the entire prompt so far, to learn a
		// prefix the engine could have supplied. Latency is the reason to fix it;
		// the cost of the wasted step is the smaller half.
		//
		// Still refuses when two libraries hold the path, which is the line
		// `#bareMount` draws and the line that makes this a correction rather
		// than a guess.
		let bare: Mount | null = null;
		if (!split) bare = this.#bareMount(clean);
		if (!split && !bare) {
			// "No knowledge base called products" was false and it was expensive:
			// `products/` is in BOTH libraries, so the ambiguity `#bareMount`
			// correctly refuses to guess was reported as an absence. The model
			// then re-read the whole root to rediscover what the engine already
			// knew. Naming the candidates turns a wasted round trip into a choice.
			const both = this.#holders(clean);
			if (both.length > 1) {
				return {
					outcome: "refused",
					text: `${clean} is in more than one knowledge base. Say which: ${both.map((m) => `${m.mountAs}/${clean}`).join(", ")}`,
				};
			}
			return {
				outcome: "refused",
				text: `No knowledge base called ${JSON.stringify(asked.split("/")[0])}. At the top level there is:\n${this.#listRoot()}`,
			};
		}
		const mount = split ? split.mount : (bare as Mount);
		const rest = split ? split.rest : clean;
		let dir: string;
		try {
			dir = this.#safe(mount, rest);
		} catch {
			return { outcome: "refused", text: "That path is outside the knowledge base." };
		}
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
			return { outcome: "refused", text: `${asked} is not a folder. Use open() for a document.` };
		}
		// A folder that has a map IS its map. Listing it returned forty filenames
		// with the index first and a note saying to read it, and a run was still
		// seen to skip the index and open four documents by filename (12 actions
		// where the index would have named the one). So the listing of an indexed
		// folder is the index itself, followed by whatever the index does not
		// mention — sub-folders and stray documents — so nothing is hidden. The
		// filename dump remains for folders that have no index.
		const indexed = this.#listIndexed(dir, asked);
		if (indexed) return indexed;
		// The map first, then everything else in name order. Plain `.sort()`
		// put "INDEX.md" at the top only while every other name began with a
		// lowercase letter; a folder holding "349-…" and "366-…" sorted digits
		// before "I", and the signpost sat in the middle of 76 names — where a
		// run was seen to skip it and pick documents by filename instead.
		const isIndex = (n: string) => /^INDEX.*\.md$/i.test(n);
		const lines = fs
			.readdirSync(dir)
			.sort((a, b) => Number(isIndex(b)) - Number(isIndex(a)) || a.localeCompare(b))
			.map((name) => {
				const full = path.join(dir, name);
				// One stat per entry. It was two — `isDirectory()` and then `.size`
				// — which on a folder of 600 documents is 600 syscalls spent
				// re-reading what the first call already returned.
				const st = fs.statSync(full);
				if (st.isDirectory()) {
					return `${name}/  (${fs.readdirSync(full).length} items)`;
				}
				// Token cost is shown so the model can budget rather than open blind.
				const cost = `(~${Math.round(st.size / 4)} tokens)`;
				// The index is named, not merely present.
				//
				// It sorts to the top (see above) and was still being skipped,
				// because at the top of forty filenames it looks like a forty-first. Measured on the
				// deployment this was written for: 133 `list` calls against 21
				// opens of an INDEX.md. Nothing in the tool ever said what the file
				// was for, so a listing was a pile of names with a signpost buried
				// in it, face down.
				// Any INDEX*.md, not the exact filename. A large folder's map is
				// split into INDEX-01.md and friends, and those are indexes too —
				// the platform's build gate already globs them, and having the two
				// ends of one convention disagree is how a shard stops counting as
				// a map on only one side.
				if (/^INDEX.*\.md$/i.test(name)) {
					const what = /^INDEX\.md$/i.test(name)
						? "read this first: it says what every document below is for"
						: "part of this folder's index";
					return `${name}  ${cost}  ← ${what}`;
				}
				return `${name}  ${cost}`;
			});
		return { outcome: "ok", text: lines.join("\n") || "(empty)" };
	}

	/**
	 * The index of a folder, as its listing, plus anything the index leaves
	 * out. Null when the folder has no INDEX.md.
	 */
	#listIndexed(dir: string, asked: string): ToolResult | null {
		const indexPath = path.join(dir, "INDEX.md");
		if (!fs.existsSync(indexPath)) return null;
		const names = fs.readdirSync(dir);
		const mentioned = new Set<string>();
		for (const n of names) {
			if (!/^INDEX.*\.md$/i.test(n)) continue;
			mentioned.add(n);
			const text = fs.readFileSync(path.join(dir, n), "utf8");
			for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				mentioned.add(decodeURIComponent(m[1]!).split("/")[0]!);
			}
		}
		const body = fs.readFileSync(indexPath, "utf8").slice(0, this.#pageChars);
		const extra = names
			.filter((n) => !mentioned.has(n) && !n.startsWith("."))
			.sort((a, b) => a.localeCompare(b))
			.map((n) => {
				const full = path.join(dir, n);
				return fs.statSync(full).isDirectory() ? `${n}/  (${fs.readdirSync(full).length} items)` : n;
			});
		const label = asked.replace(/\/+$/, "");
		const head = `=== ${label}/INDEX.md ===\n`;
		const tail = extra.length ? `\n\nNot in the index: ${extra.join(", ")}` : "";
		return { outcome: "ok", text: head + body + tail, target: `${label}/INDEX.md` };
	}

	/**
	 * The real filenames sitting next to a path that did not resolve.
	 *
	 * An index line reads "**[Train to Tier One/Tier Two guide](train-to-tier-one-two-guide.md)**",
	 * and the model kept opening the display title rather than the link target —
	 * five times in a row on one turn, because being told "that does not exist"
	 * gives it nothing to correct towards. Naming the neighbours does.
	 */
	#siblings(mount: Mount, rest: string, limit = 12): string[] {
		try {
			const dir = path.dirname(this.#safe(mount, rest));
			if (!fs.existsSync(dir)) return [];
			return fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".md") && f.toUpperCase() !== "INDEX.MD")
				.slice(0, limit);
		} catch {
			return [];
		}
	}

	/**
	 * Find the file the model meant.
	 *
	 * Index links read **[Readable Title](actual-filename.md)** and the model
	 * reaches for the title, or a slug of it: "making-the-ask.md" for a document
	 * actually called "choose-a-strategy-and-make-the-offer.md". Refusing was
	 * technically correct and practically useless — three wasted steps per miss,
	 * out of eight.
	 *
	 * Only an unambiguous match is accepted. Two candidates means we do not know
	 * what was meant, and opening the wrong document is worse than saying so.
	 */
	#resolveNear(mount: Mount, rest: string): string | null {
		const slug = (t: string) => t.toLowerCase().replace(/\.md$/, "").replace(/[^a-z0-9]/g, "");
		const want = slug(rest.split("/").pop() ?? rest);
		if (!want) return null;
		const dir = rest.includes("/") ? rest.slice(0, rest.lastIndexOf("/")) : "";

		const inDir: string[] = [];
		try {
			const abs = path.dirname(this.#safe(mount, rest));
			if (fs.existsSync(abs)) {
				for (const f of fs.readdirSync(abs)) {
					if (f.endsWith(".md")) inDir.push(dir ? `${dir}/${f}` : f);
				}
			}
		} catch {
			/* an unsafe path resolves to nothing, which is the right answer */
		}

		const base = (c: string) => slug(c.split("/").pop() ?? c);
		const exact = inDir.filter((c) => base(c) === want);
		if (exact.length === 1) return exact[0] ?? null;
		const partial = inDir.filter((c) => base(c).includes(want) || want.includes(base(c)));
		if (partial.length === 1) return partial[0] ?? null;

		// Deliberately no whole-tree fallback.
		//
		// It was tried: resolving an invented path against every document in the
		// library sounds generous and is not. A wrong folder plus a vaguely similar
		// filename resolves to something real and unrelated, the agent answers from
		// it confidently, and the turn looks successful. Coverage fell from 15 to 13
		// and citation from 93% to 83% — the failures moved from visible refusals to
		// invisible wrong answers, which is the worse trade.
		//
		// Refusing here sends it back to the map, which is where a wrong folder
		// should send it.
		return null;
	}

	/**
	 * One window of a document. `from` is a character offset, not a line.
	 *
	 * It was a line number, and cut only on line boundaries, on the reasoning that
	 * a page which cannot be split is better whole than split into nonsense. That
	 * reasoning holds for a line a little over budget and fails badly past it:
	 * ingestion here writes a document's entire body as ONE line, so 587 of 1,702
	 * documents carry a line longer than a page, and forcing the longest through
	 * whole returned 74,763 characters — ~18,700 tokens, 5.3x the hard cap that
	 * paging replaced. Removing a silent truncation is not an improvement if the
	 * replacement can hand back five times as much in a single tool result.
	 *
	 * So the page is bounded, and the cut still prefers a line boundary: the last
	 * newline inside the budget wins, and only a line with no newline to find is
	 * cut mid-line, which is said out loud. A character offset is what makes that
	 * exact — a line number cannot address the middle of a line, so bounding and
	 * line-numbered offsets cannot both be true. Lines are still REPORTED, because
	 * "lines 40-91" is what the model can cite; they are just not the unit of
	 * resumption.
	 *
	 * A document that fits gets no banner at all. Most reads fit, and prefixing
	 * every one of them with "page 1 of 1" would spend tokens on every turn to
	 * describe the case that needs no describing.
	 */
	#page(text: string, target: string, from: number): string {
		// Before any scanning: the common case is a document that fits, and it
		// should cost nothing beyond the length check.
		if (from <= 0 && text.length <= this.#pageChars) return text;

		const start = Math.max(0, from);
		if (start >= text.length) {
			return `[${target} is ${text.length} characters; there is nothing at ${from}.]`;
		}

		let end = start + this.#pageChars;
		let cutMidLine = false;
		if (end >= text.length) {
			end = text.length;
		} else {
			const brk = text.lastIndexOf("\n", end);
			if (brk > start) end = brk + 1;
			else cutMidLine = true;
		}

		const body = text.slice(start, end);
		// Lines counted from the start of the document, so the numbers mean the
		// same thing on every page and can be cited.
		const firstLine = countLines(text, start) + 1;
		const lastLine = countLines(text, end - 1) + 1;
		const head = `[${target} — lines ${firstLine}-${lastLine}]`;

		if (end >= text.length) return `${head}\n${body}\n\n[end of document]`;
		// Continuing is offered, not urged.
		//
		// The step budget is small, and a document long enough to page is long
		// enough to exhaust it. "Read on" as an instruction would spend the whole
		// turn walking one file; the useful behaviour is to read on only when this
		// page did not answer, and otherwise to answer from what is here and say
		// which part it came from.
		return (
			`${head}\n${body}\n\n` +
			`[${text.length - end} of ${text.length} characters are not shown` +
			`${cutMidLine ? ", and this page stops mid-sentence because the line is longer than a page" : ""}. ` +
			`If this page answers the question, answer from it and cite these lines. If it does not, ` +
			`call open with path ${JSON.stringify(target)} and from ${end} for the next page. ` +
			`Do not cite what you have not read.]`
		);
	}

	open(p: string, from: number | undefined = 0): ToolResult {
		// Same normalisation `list` applies, for the same reason. See `askedPath`.
		const asked = askedPath(p);
		const clean = asked.replace(/^\/+/, "");
		const split = this.#split(asked);
		let bare: Mount | null = null;
		if (!split) bare = this.#bareMount(clean);
		if (!split && !bare) {
			return {
				outcome: "refused",
				text: `No knowledge base called ${JSON.stringify(asked.split("/")[0])}. At the top level there is:\n${this.#listRoot()}`,
			};
		}
		const mount = split ? split.mount : (bare as Mount);
		let rest = split ? split.rest : clean;
		// An unprefixed path that only one library holds is a correction, not a
		// clean hit, and the caller is told which library it landed in.
		let resolved = !split;

		let file: string;
		try {
			file = this.#safe(mount, rest);
		} catch {
			return { outcome: "refused", text: "That path is outside the knowledge base." };
		}

		if (!fs.existsSync(file)) {
			const near = this.#resolveNear(mount, rest);
			if (near) {
				rest = near;
				resolved = true;
				file = this.#safe(mount, rest);
			} else {
				const sib = this.#siblings(mount, rest);
				return {
					outcome: "refused",
					text: sib.length
						? `No such document: ${p}. In that folder there is: ${sib.join(", ")}. Open one of those exactly as written.`
						: `No such document: ${p}. Use list() to see what is actually there.`,
				};
			}
		}

		if (fs.statSync(file).isDirectory()) return this.list(p);

		const text = fs.readFileSync(file, "utf8");
		const target = `${mount.mountAs}/${rest}`.replace(/\/+/g, "/");
		const body = this.#page(text, target, from);
		return resolved
			? { outcome: "resolved", target, text: body }
			: { outcome: "ok", target, text: body };
	}

	/**
	 * Keyword search across every mount, for when the indexes do not obviously
	 * say where to look. Deliberately a grep and not an embedding: an exact-word
	 * match is something the model can verify, and a nearest neighbour is not.
	 *
	 * Ranked, not merely matched. The first version scored one point per query
	 * word present anywhere in the file, so a podcast that mentioned "account"
	 * and "rep" once tied with a page titled "Who is my account manager" whose
	 * front matter said "who is my account rep", and folder order broke the
	 * tie: the directory was read-across in 2 production runs of 4 and never
	 * reached in the other 2. Now a word counts every time it appears, counts
	 * more in the title, the filename and the front matter's `answers` line,
	 * and a document that carries every word outranks one that carries some.
	 */
	find(query: string, limit = 12): ToolResult {
		const terms = (query || "")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 2);
		if (!terms.length) {
			return { outcome: "refused", text: "Give at least one word of three letters or more." };
		}

		const hits: { rel: string; score: number; line: string; title: string }[] = [];
		for (const mount of this.#mounts) {
			if (!fs.existsSync(mount.root)) continue;
			const walk = (dir: string) => {
				for (const name of fs.readdirSync(dir)) {
					const full = path.join(dir, name);
					if (fs.statSync(full).isDirectory()) {
						walk(full);
						continue;
					}
					if (!name.endsWith(".md")) continue;
					const raw = fs.readFileSync(full, "utf8");
					const text = raw.toLowerCase();
					const front = frontMatter(raw);
					const head = `${name} ${front.get("title") ?? ""} ${front.get("answers") ?? ""}`.toLowerCase();
					let score = 0;
					let matched = 0;
					for (const t of terms) {
						// Occurrences in the body, capped so a long document does not
						// win on length alone; a stem still matches, as the tool
						// description promises.
						const inBody = Math.min(5, count(text, t));
						const inHead = count(head, t);
						if (!inBody && !inHead) continue;
						matched += 1;
						score += inBody + 4 * inHead;
					}
					if (!matched) continue;
					// Every word present beats most words present, whatever the counts.
					score += matched === terms.length ? 100 * terms.length : 10 * matched;
					const i = text.indexOf(terms[0] ?? "");
					hits.push({
						rel: `${mount.mountAs}/${path.relative(mount.root, full)}`,
						score,
						title: front.get("title") ?? "",
						line: raw.slice(Math.max(0, i - 60), i + 140).replace(/\s+/g, " "),
					});
				}
			};
			walk(mount.root);
		}

		if (!hits.length) {
			return {
				outcome: "refused",
				text: `Nothing matches ${JSON.stringify(query)}. Say so rather than answering from memory.`,
			};
		}
		hits.sort((a, b) => b.score - a.score);
		return {
			outcome: "ok",
			text: hits
				.slice(0, limit)
				.map((h) => `${h.rel}${h.title ? `  (${h.title})` : ""}\n    …${h.line}…`)
				.join("\n"),
		};
	}

	/**
	 * The front matter of an opened document, for citing it.
	 *
	 * An answer that cannot say which document it came from is exactly what this
	 * whole design exists to avoid, so provenance is read from the same file the
	 * model read — not reconstructed afterwards from the text.
	 */
	citationFor(p: string): Citation | null {
		const split = this.#split(p);
		if (!split) return null;
		let file: string;
		try {
			file = this.#safe(split.mount, split.rest);
		} catch {
			return null;
		}
		if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
		// An index is a signpost, not a source. Citing one tells the reader nothing,
		// and that is as true of INDEX-07.md as of INDEX.md — a shard is a piece of
		// the same map, so the same rule has to reach it.
		if (/^INDEX.*\.md$/i.test(path.basename(file))) return null;

		const head = fs.readFileSync(file, "utf8").slice(0, 2000);
		const m = /^---\n([\s\S]*?)\n---/.exec(head);
		if (!m?.[1]) return null;
		const f: Record<string, string> = {};
		for (const line of m[1].split("\n")) {
			const i = line.indexOf(":");
			if (i > 0) f[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		const title = f["title"];
		if (!title) return null;
		const id = Number(f["id"]);
		return {
			path: p,
			title,
			...(Number.isFinite(id) && id > 0 ? { id } : {}),
			...(f["source"] ? { url: f["source"] } : {}),
			...(f["authority"] ? { authority: f["authority"] } : {}),
		};
	}

	tools(): ToolSpec[] {
		return [
			{
				name: "list",
				description:
					"List a folder of the knowledge base. Call with no path first: it returns the whole folder " +
					"structure and each library's own index. A folder that has an index comes back as that index — " +
					"one line per document saying what it is for, or a link to a theme index holding more — plus " +
					"anything the index leaves out. Read the line, then open the document it names. Always look " +
					"before answering.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Folder path, or empty for the top level." } },
					required: [],
				},
				run: (a: { path?: string }) => this.list(a.path ?? ""),
			},
			{
				name: "open",
				description:
					"Open one document and read it. Use the filename exactly as a listing gave it — a path that no " +
					"listing offered will be refused. A long document comes back one page at a time and says so; " +
					"to continue, call again with the same path and the `from` it gives you. Never cite part of a " +
					"document you have not read.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to a document." },
						from: {
							type: "integer",
							description:
								"Where to resume. Omit for the beginning; a paged result tells you what to pass.",
						},
					},
					required: ["path"],
				},
				run: (a: { path: string; from?: number }) => this.open(a.path, a.from),
			},
			{
				name: "find",
				description:
					"Keyword search, for when no index says where to look — typically a detail buried inside a " +
					"document that no index line would mention, such as a caveat or a named ingredient. " +
					"Matches any part of a word and ignores case, so \"dilut\" finds \"dilution\" — prefer a short " +
					"stem to a whole phrase. Words of two letters or fewer are ignored. A document that carries " +
					"every word ranks first, then by how often the words appear, with the title and the front " +
					"matter counting most; each result shows the document's title.",
				parameters: {
					type: "object",
					properties: { query: { type: "string", description: "Two or three words." } },
					required: ["query"],
				},
				run: (a: { query: string }) => this.find(a.query),
			},
		];
	}
}

/** Occurrences of a stem in text, case already folded. */
function count(text: string, term: string): number {
	let n = 0;
	let i = text.indexOf(term);
	while (i !== -1) {
		n += 1;
		i = text.indexOf(term, i + term.length);
	}
	return n;
}

/**
 * The scalar fields of a document's front matter, if it has one. Only what
 * `find` ranks on is read; `citationFor` has its own, fuller reader.
 */
function frontMatter(raw: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!raw.startsWith("---")) return out;
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return out;
	for (const line of raw.slice(3, end).split("\n")) {
		const m = /^([a-z_]+):\s*(.+)$/i.exec(line);
		if (m?.[1] && m[2]) out.set(m[1].toLowerCase(), m[2].trim());
	}
	return out;
}
