import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFor, providerOf } from "./index.js";
import type { InferenceCredential } from "./index.js";

const A: InferenceCredential = { provider: "openrouter", apiKey: "sk-or-test-AAAA" };
const B: InferenceCredential = { provider: "openrouter", apiKey: "sk-or-test-BBBB" };

/**
 * The Authorization header the model would actually send.
 *
 * Asserted on rather than on client identity, because `modelFor` builds a fresh
 * model object per call whichever client made it — a test comparing the two
 * objects passes just as happily against the singleton this replaced, which is
 * worse than no test at all.
 */
function authOf(model: unknown): string {
	const cfg = (model as { config: { headers: unknown } }).config;
	const h = typeof cfg.headers === "function"
		? (cfg.headers as () => Record<string, string>)()
		: (cfg.headers as Record<string, string>);
	return h["Authorization"] ?? "";
}

test("each key reaches its own client", () => {
	// The singleton this replaced bound itself to the first key it saw. One
	// container serves every customer, so that meant whoever arrived first paid
	// for everybody — invisible until an invoice landed.
	process.env["OPENROUTER_API_KEY"] = "sk-deployment";
	assert.equal(authOf(modelFor("openrouter:anthropic/claude-sonnet-5", A)), "Bearer sk-or-test-AAAA");
	assert.equal(authOf(modelFor("openrouter:anthropic/claude-sonnet-5", B)), "Bearer sk-or-test-BBBB");
	// And back again: a cached client must still be the right one.
	assert.equal(authOf(modelFor("openrouter:anthropic/claude-sonnet-5", A)), "Bearer sk-or-test-AAAA");
});

test("no key means the deployment's own", () => {
	process.env["OPENROUTER_API_KEY"] = "sk-deployment";
	assert.equal(authOf(modelFor("openrouter:anthropic/claude-sonnet-5")), "Bearer sk-deployment");
	// Unprefixed ids route to OpenRouter and behave the same.
	assert.equal(authOf(modelFor("anthropic/claude-sonnet-5")), "Bearer sk-deployment");
	assert.equal(providerOf("anthropic/claude-sonnet-5"), "openrouter");
});

test("a supplied key cannot run a Bedrock model, and says why", () => {
	// Bedrock authenticates with the task role, so honouring the model id would
	// put a customer's inference on OUR account and nothing would report it.
	// Ignoring the key silently is the bug; refusing is the feature.
	assert.throws(
		() => modelFor("bedrock:us.anthropic.claude-sonnet-4-6", A),
		/cannot be billed to a supplied key/,
	);
});

test("the same Bedrock model is fine on the deployment's own credentials", () => {
	assert.equal(providerOf("bedrock:us.anthropic.claude-sonnet-4-6"), "bedrock");
	assert.doesNotThrow(() => modelFor("bedrock:us.anthropic.claude-sonnet-4-6"));
});
