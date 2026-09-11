#!/usr/bin/env node
/**
 * Every shipped dependency must be permissively licensed.
 *
 * This repo is released under Apache-2.0. A copyleft dependency anywhere in the
 * production tree would make that release wrong — not "worth reviewing", wrong —
 * and the usual way one arrives is a transitive bump in a lockfile that nobody
 * reads. There were eight direct dependencies and no advisories when this was
 * written; that is a state worth holding rather than rediscovering.
 *
 * Dev dependencies are not checked. They are not distributed, so their terms do
 * not travel with the package.
 *
 *   node scripts/check-licences.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/** Permissive, and compatible with redistributing under Apache-2.0. */
const OK = new Set([
	"MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
	"Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0",
]);

/** Read an SPDX expression loosely: "(MIT OR Apache-2.0)" passes if any side does. */
function permissive(spdx) {
	if (!spdx) return false;
	const parts = String(spdx).replace(/[()]/g, " ").split(/\s+(?:OR|AND)\s+/i);
	return parts.some((p) => OK.has(p.trim()));
}

let paths;
try {
	paths = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
} catch (e) {
	// `npm ls` exits non-zero on peer-dep warnings while still printing the tree.
	paths = e.stdout ?? "";
}

const bad = [];
let checked = 0;

for (const dir of paths.split("\n").filter(Boolean)) {
	if (dir === ROOT) continue;
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
	} catch {
		continue;
	}
	checked += 1;
	const spdx = pkg.license ?? pkg.licenses?.[0]?.type ?? null;
	if (!permissive(spdx)) {
		bad.push({ name: pkg.name, version: pkg.version, licence: spdx ?? "none declared" });
	}
}

if (!checked) {
	console.error("licences: no production dependencies resolved — run npm ci first");
	process.exit(1);
}

if (!bad.length) {
	console.log(`licences: ${checked} production package(s), all permissive`);
	process.exit(0);
}

console.error(`\nlicences: ${bad.length} package(s) are not permissive\n`);
for (const b of bad) console.error(`  ${b.name}@${b.version}  ${b.licence}`);
console.error(
	"\nA copyleft or undeclared dependency cannot ship inside an Apache-2.0 release.\n" +
		"Replace it, or add its SPDX id to OK in this file with the reason in the pull request.\n",
);
process.exit(1);
