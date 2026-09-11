/**
 * Credentials must be re-resolved, not resolved once and kept.
 *
 * Written after production returned 502 `model_call_failed` on every turn for
 * a day: "The security token included in the request is expired". Nothing was
 * misconfigured — the task role was attached and carried the right policy. The
 * engine had cached the *credentials* where it meant to cache the *provider*,
 * so the first six-hour ECS session it resolved was the only one it ever used.
 *
 * `/api/health` stayed green throughout, because it does not call a model. The
 * only thing that can catch this is a test that asks the question directly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { __resetCredentialCache, resolveCredentials } from "./credentials.js";

test("resolves credentials through the provider on every call", async () => {
	let resolved = 0;
	const provider = async () => {
		resolved += 1;
		return { accessKeyId: `key-${resolved}`, secretAccessKey: "secret" };
	};

	__resetCredentialCache();
	const first = await resolveCredentials(provider);
	const second = await resolveCredentials(provider);

	// The provider is what caches and refreshes; asking it twice must reach it
	// twice, or an expiry it knows about can never reach us.
	assert.equal(resolved, 2);
	assert.equal(first.accessKeyId, "key-1");
	assert.equal(second.accessKeyId, "key-2");
});

test("a rotated credential is picked up rather than served from cache", async () => {
	// The production failure, in miniature: the session behind `key-1` expires
	// and the provider starts handing out `key-2`. Anything that returns
	// `key-1` here 403s forever in a long-running container.
	const sessions = ["key-1", "key-2"];
	const provider = async () => ({
		accessKeyId: sessions.shift() ?? "exhausted",
		secretAccessKey: "secret",
	});

	__resetCredentialCache();
	await resolveCredentials(provider);
	const afterRotation = await resolveCredentials(provider);

	assert.equal(afterRotation.accessKeyId, "key-2");
});

test("the environment override still short-circuits the chain", async () => {
	// KZ_AWS_* exists because some hosts reserve the AWS_-prefixed names. When
	// it is set the chain must not be consulted at all.
	let reached = 0;
	const provider = async () => {
		reached += 1;
		return { accessKeyId: "from-chain", secretAccessKey: "secret" };
	};

	process.env["KZ_AWS_ACCESS_KEY_ID"] = "from-env";
	process.env["KZ_AWS_SECRET_ACCESS_KEY"] = "secret";
	try {
		__resetCredentialCache();
		const got = await resolveCredentials(provider);
		assert.equal(got.accessKeyId, "from-env");
		assert.equal(reached, 0);
	} finally {
		delete process.env["KZ_AWS_ACCESS_KEY_ID"];
		delete process.env["KZ_AWS_SECRET_ACCESS_KEY"];
	}
});
