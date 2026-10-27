import assert from "node:assert/strict";
import { test } from "node:test";
import recoveryExtension, { recoverReasoningContext } from "../extensions/recovery.js";

const model = { provider: "my_model_hub", api: "openai-responses" };
const reasoning = (id) => ({ type: "thinking", thinkingSignature: JSON.stringify({ type: "reasoning", id, encrypted_content: "ciphertext" }) });
const failure = (id, code = "invalid_encrypted_content", provider = "my_model_hub") => ({
	role: "assistant",
	provider,
	stopReason: "error",
	errorMessage: `${provider} API error (400): {"message":"The encrypted content for item ${id} could not be verified.","code":"${code}"}`,
	content: [],
});

test("quarantines encrypted reasoning after an error without modifying the session", () => {
	const original = {
		role: "assistant",
		provider: "my_model_hub",
		api: "openai-responses",
		content: [reasoning("rs_bad"), reasoning("rs_good"), { type: "toolCall", id: "call_1", name: "read", arguments: {} }],
	};
	const messages = [original, { role: "toolResult", content: [{ type: "text", text: "ok" }] }, failure("rs_bad")];
	const result = recoverReasoningContext(messages, model);
	assert.deepEqual(result[0].content, [original.content[2]]);
	assert.equal(original.content.length, 3);
	assert.equal(result[1], messages[1]);
});

test("does not change context for unrelated errors or providers", () => {
	const messages = [{ role: "assistant", provider: model.provider, api: model.api, content: [reasoning("rs_bad")] }, failure("rs_bad")];
	assert.equal(recoverReasoningContext(messages, { provider: "other", api: model.api }), messages);
	const unrelated = [messages[0], failure("rs_bad", "other_error")];
	assert.equal(recoverReasoningContext(unrelated, model), unrelated);
});

test("supports an explicitly configured provider without crossing providers", () => {
	const other = { provider: "custom_gateway", api: "openai-responses" };
	const messages = [{ role: "assistant", provider: other.provider, api: other.api, content: [reasoning("rs_bad")] }, failure("rs_bad", "invalid_encrypted_content", other.provider)];
	assert.equal(recoverReasoningContext(messages, other), messages);
	assert.deepEqual(recoverReasoningContext(messages, other, new Set([other.provider])), [messages[1]]);
});

test("drops an empty reasoning-only message while retaining other messages", () => {
	const messages = [{ role: "assistant", provider: model.provider, api: model.api, content: [reasoning("rs_bad")] }, failure("rs_bad")];
	assert.deepEqual(recoverReasoningContext(messages, model), [messages[1]]);
});

test("quarantines remaining encrypted blocks after compaction removed the rejected item", () => {
	const kept = { role: "assistant", provider: model.provider, api: model.api, content: [reasoning("rs_remaining"), { type: "text", text: "result" }] };
	const messages = [{ role: "compactionSummary", summary: "Previous work" }, kept, failure("rs_compacted")];
	assert.deepEqual(recoverReasoningContext(messages, model)[1].content, [kept.content[1]]);
});

test("registers a request-local context hook", () => {
	let handler;
	recoveryExtension({ on(event, callback) { assert.equal(event, "context"); handler = callback; } });
	const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
	assert.equal(handler({ messages }, { model }), undefined);
});
