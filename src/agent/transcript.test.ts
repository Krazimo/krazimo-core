/**
 * The stored transcript must shrink from the oldest tool exchanges first and
 * never strand a tool result without the call that asked for it — an orphaned
 * half is a hard provider error, not a quality loss.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "ai";
import { pruneTranscript } from "./index.js";

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const call = (id: string): ModelMessage => ({
	role: "assistant",
	content: [{ type: "tool-call", toolCallId: id, toolName: "open", input: { path: id } }],
});
const result = (id: string, size: number): ModelMessage => ({
	role: "tool",
	content: [{
		type: "tool-result", toolCallId: id, toolName: "open",
		output: { type: "text", value: "x".repeat(size) },
	}],
});

test("a transcript under budget passes through untouched", () => {
	const t = [user("hi"), call("a"), result("a", 100)];
	assert.deepEqual(pruneTranscript(t), t);
});

test("over budget, the oldest tool exchange goes first and user turns survive", () => {
	const t: ModelMessage[] = [
		user("first question"),
		call("a"), result("a", 70_000),
		user("second question"),
		call("b"), result("b", 70_000),
	];
	const out = pruneTranscript(t);
	// The oldest pair is gone, both user turns remain, the newer pair remains.
	assert.deepEqual(out.map((m) => m.role), ["user", "user", "assistant", "tool"]);
	assert.equal(JSON.stringify(out).includes('"path":"a"'), false);
	assert.equal(JSON.stringify(out).includes('"path":"b"'), true);
});

test("a tool call followed by several tool messages is dropped as one unit", () => {
	const t: ModelMessage[] = [
		user("q"),
		call("a"), result("a", 70_000), result("a2", 70_000),
		user("q2"),
	];
	const out = pruneTranscript(t);
	assert.deepEqual(out.map((m) => m.role), ["user", "user"]);
});
