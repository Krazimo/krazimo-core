/** Load a policy document from YAML or JSON, and fail loudly on a bad one. */
import fs from "node:fs";
import { parse } from "yaml";
import { badCheck } from "./reply.js";
import type { PolicyDocument } from "./types.js";

export function parsePolicy(text: string): PolicyDocument {
	const doc = parse(text) as Partial<PolicyDocument>;
	if (!doc || typeof doc !== "object") throw new Error("policy is not an object");
	if (!doc.id) throw new Error("policy needs an id");
	if (typeof doc.version !== "number") throw new Error("policy needs a numeric version");
	if (!doc.constitution?.trim()) throw new Error("policy needs a constitution");

	// Regexes are validated at load, not at first use. A policy with a broken
	// pattern must fail to deploy rather than fail on the one turn it matters.
	for (const g of doc.guards ?? []) {
		if (!g.id) throw new Error("every guard needs an id");
		try {
			new RegExp(g.detect, "i");
			if (g.when) new RegExp(g.when, "i");
		} catch (e) {
			throw new Error(`guard ${g.id} has an invalid pattern: ${(e as Error).message}`);
		}
		if (g.action === "replace" && !g.replacement) {
			throw new Error(`guard ${g.id} replaces but names no replacement`);
		}
	}
	for (const r of doc.scope?.rules ?? []) {
		try {
			new RegExp(r.pattern, "i");
		} catch (e) {
			throw new Error(`scope rule has an invalid pattern: ${(e as Error).message}`);
		}
	}
	// Same reasoning for a check: a CEL expression that does not parse is a
	// refusal the model can never satisfy, on every turn, for everyone.
	const toolIds = new Set((doc.tools ?? []).map((t) => t.id));
	for (const t of doc.tools ?? []) {
		if (!t.id) throw new Error("every reply tool needs an id");
		if (!t.fields?.length) throw new Error(`reply tool ${t.id} has no fields`);
		for (const name of t.say ?? []) {
			if (!t.fields.some((f) => f.name === name)) {
				throw new Error(`reply tool ${t.id} says "${name}", which is not one of its fields`);
			}
		}
	}
	for (const c of doc.checks ?? []) {
		if (!c.id) throw new Error("every check needs an id");
		if (toolIds.size && !toolIds.has(c.tool)) throw new Error(`check ${c.id} names no reply tool "${c.tool}"`);
		const bad = badCheck(c.when);
		if (bad) throw new Error(`check ${c.id} does not parse: ${bad}`);
	}
	// What `reply` promises, refused here rather than discovered at answer time.
	//
	// Both mechanisms guarantee the shape; they differ in what they can carry.
	// A response schema is ONE shape, so a policy offering the model a choice of
	// replies cannot be expressed as one — and `checks` are an interception on a
	// tool CALL, so under a schema there is nothing to intercept and a policy
	// carrying them would be silently weaker than it reads.
	if (doc.reply !== undefined) {
		if (doc.reply !== "tools" && doc.reply !== "structured") {
			throw new Error('reply must be "tools" or "structured"');
		}
		if (doc.reply === "structured") {
			if ((doc.tools ?? []).length > 1) {
				throw new Error(
					"structured reply asks the model for one shape, but this policy declares " +
						`${doc.tools?.length} reply tools — a schema cannot offer a choice`);
			}
			if ((doc.checks ?? []).length) {
				throw new Error(
					"structured reply has no tool call to intercept, so checks would never run — " +
						"remove them, or use the tools reply");
			}
		}
	}

	// A screen model is a model id, and a typo in one is not visible until that
	// screen runs — which is a turn nobody is watching, on a step that fails
	// open. The engine cannot know which ids a deployment can invoke, so this
	// checks the only thing it can: that the value is a non-empty string and
	// not an accidental object or number from hand-edited YAML.
	if (doc.screens !== undefined) {
		if (typeof doc.screens !== "object" || doc.screens === null || Array.isArray(doc.screens)) {
			throw new Error("screens must be an object with scope, escalation or memory");
		}
		for (const step of ["scope", "escalation", "memory"] as const) {
			const v = (doc.screens as Record<string, unknown>)[step];
			if (v === undefined) continue;
			if (typeof v !== "string" || !v.trim()) {
				throw new Error(`screens.${step} must be a model id`);
			}
		}
		for (const k of Object.keys(doc.screens)) {
			if (!["scope", "escalation", "memory"].includes(k)) {
				throw new Error(`screens.${k} is not a screening step`);
			}
		}
	}

	for (const t of doc.tools ?? []) {
		for (const f of t.fields) {
			if (f.type && !["string", "integer", "number", "boolean"].includes(f.type)) {
				throw new Error(`field ${t.id}.${f.name}: type must be string, integer, number or boolean`);
			}
			// A numeric enum whose members are not numbers compiles to a schema
			// nothing can satisfy, and the model would be refused every turn.
			if (f.values?.length && (f.type === "integer" || f.type === "number")) {
				const bad = f.values.filter((v) => !Number.isFinite(Number(v)));
				if (bad.length) {
					throw new Error(`field ${t.id}.${f.name}: ${f.type} values must be numeric, got ${bad.join(", ")}`);
				}
			}
		}
	}

	// An agent with no way to read is a chatbot with a prompt: refused here,
	// where it is a configuration error, not at the first turn.
	// Published as null to mean "all of them": a part of a versioned document
	// is cleared by writing null, never by deleting the key.
	if ((doc as { navigation?: unknown }).navigation === null) delete doc.navigation;
	if (doc.navigation !== undefined) {
		if (!Array.isArray(doc.navigation) || !doc.navigation.every((n) => typeof n === "string" && n)) {
			throw new Error("navigation must be a list of tool names");
		}
		// Empty is a real configuration and means NO navigation at all.
		//
		// The rule below — an agent that can navigate must be able to `open` —
		// still holds for every agent that navigates. What it used to also say,
		// by having no empty case, is that every agent must navigate, and that
		// is not true of an agent whose subject arrives in the message. The
		// scorer agents read one conversation transcript and grade it; there is
		// nothing for them to look up, and a step spent looking is a step not
		// spent answering. `[]` says that out loud, where omitting the key says
		// the opposite (all tools) and `["open"]` hands them a tool the forced
		// tool choice lets them waste their only step on.
		if (doc.navigation.length && !doc.navigation.includes("open")) {
			throw new Error("navigation must include open");
		}
	}
	return doc as PolicyDocument;
}

export function loadPolicy(file: string): PolicyDocument {
	return parsePolicy(fs.readFileSync(file, "utf8"));
}
