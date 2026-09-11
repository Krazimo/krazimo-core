/**
 * Bedrock credentials, resolved the way the AWS CLI resolves them.
 *
 * Locally that means a named profile, which can reach an account through IAM
 * Roles Anywhere and a `credential_process`, so nothing long-lived is written to
 * disk. On a host with no profile the same chain falls through to environment
 * variables. Some hosts reserve the `AWS_`-prefixed names for their own use,
 * hence the `KZ_AWS_` aliases: read first and, when present, skip the chain.
 *
 * This lives in its own file because of what went wrong when it did not. The
 * cache used to hold the resolved credentials:
 *
 *     cached ??= import(...).then(({ fromNodeProviderChain }) =>
 *         fromNodeProviderChain(...)());     // <- invoked, result cached
 *
 * which pins the first session the process ever resolved. On ECS those come
 * from the task-role endpoint and expire in about six hours, so a container that
 * had been up a day answered every single turn with 502 `model_call_failed` —
 * "The security token included in the request is expired" — while `/api/health`
 * stayed green, because health does not call a model. Nothing was misconfigured;
 * the credentials were simply never asked for again.
 *
 * The provider is the thing worth caching. It does its own caching and its own
 * refreshing, and it is cheap to call. So the import is cached, the provider is
 * cached, and the CREDENTIALS ARE NOT — every call goes through the provider and
 * gets whatever is valid now.
 */

/** What the Bedrock client needs, and all this module promises to return. */
export interface AwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/** Anything that can hand back credentials — the AWS chain, or a test double. */
export type CredentialProvider = () => Promise<AwsCredentials>;

/**
 * Credentials for right now.
 *
 * Deliberately calls `provider()` every time. Caching here is what broke
 * production; the provider already caches correctly and knows its own expiry.
 */
export async function resolveCredentials(
	provider: CredentialProvider,
): Promise<AwsCredentials> {
	const id = process.env["KZ_AWS_ACCESS_KEY_ID"];
	const secret = process.env["KZ_AWS_SECRET_ACCESS_KEY"];
	if (id && secret) {
		const token = process.env["KZ_AWS_SESSION_TOKEN"];
		return token
			? { accessKeyId: id, secretAccessKey: secret, sessionToken: token }
			: { accessKeyId: id, secretAccessKey: secret };
	}
	return provider();
}

let chain: Promise<CredentialProvider> | null = null;

/**
 * The AWS credential chain, imported once and kept.
 *
 * Imported lazily: the chain pulls in a large dependency tree and reads the
 * filesystem, neither of which should happen in a deployment that only ever
 * talks to OpenRouter. What is cached is the provider — calling it is the cheap
 * part and the part that must not be skipped.
 */
export function chainProvider(): Promise<CredentialProvider> {
	const profile = process.env["KZ_AWS_PROFILE"] ?? process.env["AWS_PROFILE"];
	chain ??= import("@aws-sdk/credential-providers").then(
		({ fromNodeProviderChain }) =>
			fromNodeProviderChain(profile ? { profile } : {}) as CredentialProvider,
	);
	return chain;
}

/** Drop the cached provider. For tests; nothing in the engine calls this. */
export function __resetCredentialCache(): void {
	chain = null;
}
