#!/usr/bin/env node
/**
 * Refuse to let a client reach a public repository.
 *
 * This exists because the obvious check failed. Grepping for known client names
 * found three references. The same tree also held a second client's slug, a brand
 * spelled with a non-ASCII letter, two product names, a programme name, a kit with
 * its real price, and a real monthly earnings figure. Not one of those contains a
 * client's name, and every one identifies the client to anyone in that industry.
 *
 * So a denylist alone cannot work, and not because this one was written badly.
 * A denylist only knows the clients we have already had. The client we sign next
 * month is, by construction, not in it — and that is precisely the leak nobody
 * would be looking for.
 *
 * Hence two layers, and the second is the one that matters:
 *
 *   1. KNOWN   — names we have already leaked once, stored as hashes in
 *                scripts/publishable-denylist.json. Hashed because this file is
 *                published: a plaintext list of client names in a public repo is
 *                itself the leak, and the check would become the thing it guards
 *                against. A hash matches just as well and reads back as nothing.
 *   2. UNKNOWN — a positive contract. Every proper noun in this repo must appear
 *                in scripts/publishable-allowlist.json. A name nobody has thought
 *                about yet is not in that file, so it fails. Adding it is a
 *                deliberate, reviewable act by a person.
 *
 * Layer 2 is deliberately annoying. That is the feature: the annoyance is a
 * person being asked "should this name be public?" at the only moment when the
 * answer can still be no.
 *
 * One trap, learned the hard way: the allowlist was first seeded by running this
 * script over the tree and accepting what it found. That tree was not clean, so
 * two generic-looking tokens went straight into the allowlist and went on hiding
 * a pointer to a private workspace and a sibling repository in `docs/DESIGN.md`.
 * Seed from a tree a person has actually read, never from an unaudited one, and
 * treat a generic-looking entry in the allowlist as a question rather than a fact.
 *
 *   node scripts/check-publishable.mjs             check every tracked file
 *   node scripts/check-publishable.mjs --staged     check only what is about to be committed
 *   node scripts/check-publishable.mjs --list       print what it would allow, to seed the file
 *   node scripts/check-publishable.mjs --hash "x"   hash a term for the denylist
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const hashArg = process.argv.indexOf("--hash");
if (hashArg !== -1) {
	const term = process.argv[hashArg + 1] ?? "";
	const norm = term.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	if (!norm) {
		console.error('usage: node scripts/check-publishable.mjs --hash "some name"');
		process.exit(1);
	}
	console.log(`${createHash("sha256").update(norm).digest("hex").slice(0, 16)}   (${norm.split(" ").length} word(s))`);
	process.exit(0);
}

const deny = JSON.parse(fs.readFileSync(path.join(HERE, "publishable-denylist.json"), "utf8"));
const DENY = new Set(deny.hashes);
const MAX_GRAM = deny.maxGram ?? 3;

/** Lowercase words only, so punctuation and casing cannot dodge a hash. */
function words(line) {
	return line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

function digest(s) {
	return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** The first denied run of 1..MAX_GRAM words on this line, or null. */
function denied(line) {
	const w = words(line);
	for (let n = 1; n <= MAX_GRAM; n += 1) {
		for (let i = 0; i + n <= w.length; i += 1) {
			if (DENY.has(digest(w.slice(i, i + n).join(" ")))) return w.slice(i, i + n).join(" ");
		}
	}
	return null;
}

/** Machine-generated, enormous, and not prose. Scanned for nothing. */
const SKIP = new Set(["package-lock.json"]);

/**
 * Verbatim third-party documents we did not write.
 *
 * The denylist and the non-ASCII rule still run on these, because a client name
 * must not hide in one. The proper-noun and acronym rules do NOT: they exist to
 * question names WE introduce, and a licence and a code of conduct are full of
 * title-case headings that are nobody's secret. Allowlisting those fifteen
 * headings instead would put fifteen generic-looking entries in the allowlist,
 * which is precisely how a real leak stayed hidden once already.
 */
const BOILERPLATE = new Set(["LICENSE", "CODE_OF_CONDUCT.md"]);

/**
 * Paths that must never exist here at all.
 *
 * Core has no tenant, so it has no tenant directory, no knowledge base and no
 * environment file. Each of these is a shape that carries a client's content
 * rather than a mention of one, so no wording change can make it acceptable —
 * the file is in the wrong repository.
 */
const FORBIDDEN_PATTERNS = [
	// Shapes, not names, so these are safe to state in the open. A region string is
	// legitimate here and a pool id is not, and only the shape tells them apart.
	{ what: "an identity pool id", re: /\b[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{9}\b/ },
	{ what: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const FORBIDDEN_PATHS = [
	/^tenants?\//,
	/(^|\/)knowledge\//,
	/(^|\/)\.env($|\.)/,
	/\.(pem|key|p12|pfx|keystore)$/,
];

/**
 * No tracked file may be larger than this.
 *
 * A corpus arrives as one big file long before anyone notices it is a corpus.
 * Nothing legitimate in an engine repo is this size, so the bound is the check.
 */
const MAX_BYTES = 512 * 1024;

/** Typography we write on purpose. Anything else non-ASCII is a name or an accident. */
const OK_NON_ASCII = new Set([..."—–…‘’“”→←⇒×·° "]);

const allow = JSON.parse(fs.readFileSync(path.join(HERE, "publishable-allowlist.json"), "utf8"));
const ALLOWED_NOUNS = new Set(allow.properNouns);
const ALLOWED_ACRONYMS = new Set(allow.acronyms);

/**
 * Tokens that name a file which actually exists here.
 *
 * `README`, `LICENSE`, `DESIGN` and the rest are shouted filenames, and a link to a
 * file in this repo is never a leak. Deriving them beats listing them, and it is
 * strictly narrower than the allowlist entry it replaces: `docs/DESIGN.md` passes
 * because that file exists, while a shouted filename that is NOT in this repo does
 * not — which is exactly what a blanket allowlist entry quietly permitted for weeks.
 */
const FILENAME_TOKENS = new Set();

const staged = process.argv.includes("--staged");

/** Every tracked path, SKIP included — filename tokens come from all of them. */
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
	.split("\n")
	.filter(Boolean);

const files = (
	staged
		? execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
				cwd: ROOT,
				encoding: "utf8",
		  })
				.split("\n")
				.filter(Boolean)
		: tracked
).filter((f) => !SKIP.has(f));

for (const rel of tracked) {
	for (const tok of rel.split(/[^A-Za-z0-9]+/)) {
		if (tok.length >= 4) FILENAME_TOKENS.add(tok.toUpperCase());
	}
}

const findings = [];
const seen = { nouns: new Set(), acronyms: new Set() };

for (const rel of files) {
	for (const bad of FORBIDDEN_PATHS) {
		if (bad.test(rel)) {
			findings.push({ at: rel, kind: "path that must not exist in core", hit: rel, line: "" });
		}
	}

	let stat;
	try {
		stat = fs.statSync(path.join(ROOT, rel));
	} catch {
		continue; // staged deletion, or gone
	}
	if (stat.size > MAX_BYTES) {
		findings.push({
			at: rel,
			kind: `file is ${Math.round(stat.size / 1024)}KB, over the ${MAX_BYTES / 1024}KB bound`,
			hit: rel,
			line: "",
		});
	}

	let text;
	try {
		text = fs.readFileSync(path.join(ROOT, rel), "utf8");
	} catch {
		continue; // binary or gone
	}
	text.split("\n").forEach((line, i) => {
		const at = `${rel}:${i + 1}`;

		const hit = denied(line);
		if (hit) findings.push({ at, kind: "known name (denylist)", hit, line });

		for (const p of FORBIDDEN_PATTERNS) {
			const m = line.match(p.re);
			if (m) findings.push({ at, kind: `looks like ${p.what}`, hit: m[0], line });
		}

		for (const ch of line) {
			if (ch.codePointAt(0) > 127 && !OK_NON_ASCII.has(ch)) {
				findings.push({ at, kind: "non-ASCII character", hit: ch, line });
				break;
			}
		}

		if (BOILERPLATE.has(rel)) return; // leak rules only, above

		for (const m of line.matchAll(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/g)) {
			seen.nouns.add(m[0]);
			if (!ALLOWED_NOUNS.has(m[0])) {
				findings.push({ at, kind: "proper noun not on the allowlist", hit: m[0], line });
			}
		}

		for (const m of line.matchAll(/\b[A-Z][A-Z0-9]{3,}\b/g)) {
			const w = m[0];
			seen.acronyms.add(w);
			if (ALLOWED_ACRONYMS.has(w)) continue;
			if (FILENAME_TOKENS.has(w)) continue; // names a file that is really here
			findings.push({ at, kind: "unknown acronym", hit: w, line });
		}
	});
}

if (process.argv.includes("--list")) {
	console.log("properNouns:");
	for (const n of [...seen.nouns].sort()) console.log(`  ${JSON.stringify(n)},`);
	console.log("acronyms (not English words):");
	for (const a of [...seen.acronyms].sort()) console.log(`  ${JSON.stringify(a)},`);
	process.exit(0);
}

if (!findings.length) {
	console.log(`publishable: ${files.length} ${staged ? "staged " : ""}file(s) clean`);
	process.exit(0);
}

console.error(`\npublishable: ${findings.length} thing(s) must not go public\n`);
for (const f of findings) {
	console.error(`  ${f.at}`);
	console.error(`    ${f.kind}: ${JSON.stringify(f.hit)}`);
	if (f.line.trim()) console.error(`    ${f.line.trim().slice(0, 120)}`);
	console.error("");
}
console.error(
	"A name here is either wrong wording, or it belongs in krazimo-platform.\n" +
		"If it is genuinely generic, add it to scripts/publishable-allowlist.json\n" +
		"and say in the pull request why a public reader may see it.\n",
);
process.exit(1);
