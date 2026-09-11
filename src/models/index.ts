/**
 * Which provider serves a model id.
 *
 * Model ids are written as `provider:model` and default to OpenRouter when no
 * prefix is given, so `google/gemini-2.5-flash` keeps working untouched and
 * `bedrock:us.anthropic.claude-sonnet-4-6` reaches Bedrock. Keeping the routing
 * inside the id means every place that names a model can move provider
 * independently without a second setting per knob, and a fallback chain can
 * deliberately span two providers so one vendor's outage is survivable.
 *
 * Adding a provider is a case in `modelFor`. Nothing else in the engine knows
 * or cares which one is in use.
 */
import { createHash } from "node:crypto";

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { generateText, type LanguageModel } from "ai";

import { type AwsCredentials, chainProvider, resolveCredentials } from "./credentials.js";

export type Provider = "bedrock" | "openrouter";

/**
 * How this model's provider wants a cache point marked, or null if it has none.
 *
 * The caching dialect belongs here, with the rest of the provider knowledge,
 * because this file's own rule is that "adding a provider is a case in
 * `modelFor`; nothing else in the engine knows or cares which one is in use".
 * The agent loop broke that rule: it hardcoded Bedrock's spelling and claimed in
 * a comment that "a provider that does not know the key ignores it, so the
 * engine still runs anywhere". It does not. Amazon Nova on Bedrock REJECTS it —
 * `Malformed input request: extraneous key [cachePoint] is not permitted` — so
 * every request failed with a 502 and the engine ran nowhere but Anthropic.
 *
 * Returning null is the important case: a model whose provider has no dialect we
 * know runs uncached rather than not at all. Caching is an optimisation and must
 * degrade like one.
 *
 * Dialects, from each provider's documentation:
 *   Bedrock + Claude   `cachePoint: { type: "default" }`      (Converse API)
 *   Bedrock + Nova     automatic; no explicit point, and it errors on one
 *   Bedrock + GPT-5.6  `prompt_cache_breakpoint`              (Responses API)
 *   OpenRouter         `cache_control: { type: "ephemeral" }` (Anthropic models)
 *
 * The first two are implemented. The rest stay null until someone verifies them
 * against a real call — a wrong dialect is what caused the outage this function
 * exists to prevent, so the bar is a measurement and not a documentation page.
 *
 * OpenRouter was measured on 2026-09-01, twice, because the first answer was
 * wrong. `@ai-sdk/openai` pointed at OpenRouter's base URL emits OpenAI's
 * spelling, `prompt_cache_breakpoint`, and OpenRouter silently ignores it:
 * two identical calls, $0.00928 both times, `cached_tokens: 0` on the second.
 * Silently, which is the whole problem — nothing fails, the bill just stays
 * high. With `cache_control` the same pair is $0.010291 then $0.0009668, a
 * 10.6x cut, `cache_write_tokens: 4054` then `cached_tokens: 4054`. That is why
 * `modelFor` uses the OpenRouter provider rather than the OpenAI one: it is the
 * only one that can spell this, and the dialect is the reason it is a
 * dependency.
 *
 * Anthropic's five-minute TTL is the default and the one we want. The cache is
 * re-marked on every step of a turn, and a turn does not last five minutes.
 */
export function cacheHint(model: string): ProviderOptions | null {
	const [provider, id] = model.startsWith("bedrock:")
		? ["bedrock", model.slice("bedrock:".length)]
		: model.startsWith("openrouter:")
			? ["openrouter", model.slice("openrouter:".length)]
			: ["openrouter", model];

	if (provider === "bedrock") {
		// The geography prefix (`us.`, `global.`) sits in front of the vendor.
		const vendor = id.replace(/^(?:us|eu|apac|global)\./, "").split(".")[0];
		if (vendor === "anthropic") return { bedrock: { cachePoint: { type: "default" } } };
	}
	if (provider === "openrouter") {
		// Vendor-gated for the same reason Bedrock is: `cache_control` is
		// Anthropic's, and OpenRouter passes provider fields through to whatever
		// is behind the id. Sending it to a model that does not know it is how
		// Nova started returning 502s.
		if (id.startsWith("anthropic/")) {
			return { openrouter: { cacheControl: { type: "ephemeral" } } };
		}
	}
	return null;
}

const BEDROCK_REGION =
	process.env["KZ_AWS_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";

/**
 * Bedrock credentials for this request.
 *
 * The resolution rules, and the production failure that moved them into their
 * own module, are documented in `./credentials.ts`. The short version: never
 * cache what comes back from here.
 */
function credentials(): Promise<AwsCredentials> {
	return chainProvider().then(resolveCredentials);
}

let bedrockClient: ReturnType<typeof createAmazonBedrock> | null = null;
function bedrock() {
	bedrockClient ??= createAmazonBedrock({
		region: BEDROCK_REGION,
		credentialProvider: credentials,
	});
	return bedrockClient;
}

/**
 * The OpenRouter provider, not `createOpenAI` pointed at OpenRouter's base URL.
 *
 * The OpenAI-shaped client works for inference — it ran the whole tool loop and
 * the structured answer correctly — and cannot express `cache_control`, which
 * costs about half the bill on this agent. See `cacheHint` for the two
 * measurements. Its own base URL is the default, so there is none to set here.
 */
/**
 * A caller-supplied inference credential — the "bring your own key" case.
 *
 * It is DATA passed in, never something this package looks up. Core has no
 * concept of a tenant and must not grow one to support this: whoever knows
 * which customer is asking is the same layer that knows which key is theirs,
 * and that layer is not here.
 *
 * `provider` is not decoration. A key for one provider is not a key for
 * another, and the failure when they are confused is a 401 in front of a
 * customer rather than a type error, so the pairing is stated rather than
 * inferred from the model id.
 */
export interface InferenceCredential {
	provider: "openrouter";
	apiKey: string;
}

/**
 * One client per distinct key, not one per process.
 *
 * The singleton this replaced was bound to `OPENROUTER_API_KEY` at first use,
 * which is correct for a single-tenant deployment and silently wrong for a
 * multi-tenant one: one container serves every customer, so the first key to
 * arrive would have served all of them and the bill would have landed on
 * whoever's key that was.
 *
 * Keyed by digest rather than by the key itself. The client still closes over
 * the secret — that cannot be avoided — but the map's own index does not, so a
 * heap dump or a careless log of the cache does not spell it out.
 */
const clients = new Map<string, ReturnType<typeof createOpenRouter>>();
/** Bounded so key rotation cannot grow it without limit. Tenants are tens. */
const MAX_CLIENTS = 64;

function openrouter(cred?: InferenceCredential) {
	const apiKey = cred?.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? "";
	const id = createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
	let c = clients.get(id);
	if (!c) {
		if (clients.size >= MAX_CLIENTS) clients.clear();
		c = createOpenRouter({ apiKey });
		clients.set(id, c);
	}
	return c;
}

/**
 * Resolve a `provider:model` id to a model. Unprefixed ids are OpenRouter.
 *
 * `cred` is the customer's own key when they have one. Omitted, this falls back
 * to the deployment's key, which is the escape hatch and has to be a deliberate
 * choice made one layer up rather than something that happens when a lookup
 * quietly returns nothing.
 */
export function modelFor(id: string, cred?: InferenceCredential): LanguageModel {
	if (id.startsWith("bedrock:")) {
		// Bedrock authenticates with the task role, so a customer key has no
		// meaning here and honouring the model id would put their inference on
		// OUR account without either party being told. Refused, not ignored:
		// silently paying someone else's bill is the failure this whole path
		// exists to prevent, and it is invisible until an invoice arrives.
		if (cred) {
			throw new Error(
				`${id} runs on this deployment's own AWS role and cannot be billed to a ` +
					`supplied key. Choose a model the key can serve, or turn the key off for ` +
					`this agent.`,
			);
		}
		return bedrock()(id.slice("bedrock:".length));
	}
	if (id.startsWith("openrouter:")) return openrouter(cred)(id.slice("openrouter:".length));
	return openrouter(cred)(id);
}

/**
 * One plain model call: no tools, no policy, no retrieval.
 *
 * Five places in this package already reach for `generateText` directly, and a
 * caller outside it could not — the AI SDK is this package's dependency, so a
 * consumer wanting one cheap completion had to add the SDK itself and then keep
 * its version in step with ours. The eval judge is exactly that caller: it
 * reads an answer and grades it, and must be on the same provider as the thing
 * it is grading.
 *
 * Deliberately thin. Anything that needs tools, steps or caching is an agent
 * and belongs in `agent/`.
 */
export async function complete(opts: {
	model: string;
	system: string;
	prompt: string;
	maxOutputTokens?: number;
	/** Pass 0 for a reproducible answer. Graders want this; writers do not. */
	temperature?: number;
}): Promise<{ text: string; input: number; output: number }> {
	const r = await generateText({
		model: modelFor(opts.model),
		system: opts.system,
		prompt: opts.prompt,
		maxOutputTokens: opts.maxOutputTokens ?? 600,
		...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
	});
	return {
		text: r.text ?? "",
		input: r.usage?.inputTokens ?? 0,
		output: r.usage?.outputTokens ?? 0,
	};
}

/** Which provider a model id will use. Used by health checks and metering. */
export function providerOf(id: string): Provider {
	return id.startsWith("bedrock:") ? "bedrock" : "openrouter";
}

/**
 * Is there a usable credential for the model we are about to call?
 *
 * Health checks used to test for an OpenRouter key, which reports the product as
 * down whenever it is running entirely on Bedrock. The question is per-provider,
 * so ask it that way. Bedrock's answer is deliberately loose: credentials may
 * come from an instance role or a profile rather than an environment variable,
 * and the only certain test is a real call.
 */
export function llmConfigured(id: string): boolean {
	if (providerOf(id) === "bedrock") {
		return Boolean(
			(process.env["KZ_AWS_ACCESS_KEY_ID"] && process.env["KZ_AWS_SECRET_ACCESS_KEY"]) ||
				process.env["AWS_ACCESS_KEY_ID"] ||
				process.env["KZ_AWS_PROFILE"] ||
				process.env["AWS_PROFILE"] ||
				process.env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"] ||
				process.env["AWS_WEB_IDENTITY_TOKEN_FILE"],
		);
	}
	return Boolean(process.env["OPENROUTER_API_KEY"]);
}
