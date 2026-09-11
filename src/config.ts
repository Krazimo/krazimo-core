/**
 * The agent config file.
 *
 * Built on Agent Format (agentformat.org) rather than a shape invented here.
 * It covers metadata, execution_policy and action_space; it does not cover
 * knowledge, memory, guardrails or evaluation — which is exactly our surface, so
 * those are namespaced extensions and the split between standard and extension
 * is the split between the undifferentiated part and the part that is ours.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { loadPolicy } from "./policy/index.js";
import type { PolicyDocument } from "./policy/index.js";
import { IndexWalk } from "./retrieval/index.js";
import type { Mount, RetrievalStrategy } from "./retrieval/types.js";

export interface AgentFile {
	schema_version?: string;
	metadata: { id: string; name?: string; version?: number; description?: string;
	            starters?: string[] };
	execution_policy?: { model?: string; max_steps?: number; temperature?: number;
	                     cache_prompt?: boolean };
	/** krazimo extension. `root` is relative to the config file. */
	knowledge_bases?: { ref?: string; mount_as: string; root: string; priority?: number }[];
	/** krazimo extension. Path to a policy document, relative to the config file. */
	policy: string;
	retrieval?: { strategy?: "index-walk" };
}

export interface LoadedAgent {
	id: string;
	name: string;
	description?: string;
	/** Example questions to offer on an empty conversation. */
	starters?: string[];
	model: string;
	maxSteps: number;
	temperature: number;
	cachePrompt: boolean;
	policy: PolicyDocument;
	retrieval: RetrievalStrategy;
	mounts: Mount[];
}

export function loadAgent(file: string): LoadedAgent {
	const dir = path.dirname(path.resolve(file));
	const doc = parse(fs.readFileSync(file, "utf8")) as AgentFile;
	if (!doc?.metadata?.id) throw new Error(`${file}: metadata.id is required`);
	if (!doc.policy) throw new Error(`${file}: policy is required`);

	const strategy = doc.retrieval?.strategy ?? "index-walk";
	if (strategy !== "index-walk") {
		// Vector and hybrid are designed for but not built. Failing here is better
		// than silently serving a different guarantee than the config asked for.
		throw new Error(`${file}: retrieval strategy ${JSON.stringify(strategy)} is not implemented yet`);
	}

	const mounts: Mount[] = (doc.knowledge_bases ?? []).map((k, i) => ({
		id: k.ref ?? k.mount_as,
		mountAs: k.mount_as,
		root: path.resolve(dir, k.root),
		priority: k.priority ?? i + 1,
	}));
	if (!mounts.length) throw new Error(`${file}: at least one knowledge_base is required`);

	const loaded: LoadedAgent = {
		id: doc.metadata.id,
		name: doc.metadata.name ?? doc.metadata.id,
		model: doc.execution_policy?.model ?? "bedrock:global.anthropic.claude-sonnet-4-6",
		maxSteps: doc.execution_policy?.max_steps ?? 8,
		temperature: doc.execution_policy?.temperature ?? 0.3,
		cachePrompt: doc.execution_policy?.cache_prompt ?? true,
		policy: loadPolicy(path.resolve(dir, doc.policy)),
		retrieval: new IndexWalk({ mounts }),
		mounts,
	};
	if (doc.metadata.description) loaded.description = doc.metadata.description;
	// Example questions for whoever opens the playground. The tenant's own,
	// because "what would I even ask this thing" has a different answer for
	// every agent, and an engine that guessed would guess from one client.
	if (doc.metadata.starters?.length) loaded.starters = doc.metadata.starters;
	return loaded;
}

/** Every `*.agent.yaml` in a directory. */
export function loadAgents(dir: string): LoadedAgent[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".agent.yaml") || f.endsWith(".agent.yml"))
		.map((f) => loadAgent(path.join(dir, f)));
}
