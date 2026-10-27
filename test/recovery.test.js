import assert from "node:assert/strict";
import { test } from "node:test";
import recoveryExtension, { recoverReasoningContext, planRecoveryRetry } from "../extensions/recovery.js";

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
	const unrelated = [messages[0], { ...failure("rs_bad", "other_error"), errorMessage: "rate limit exceeded" }];
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

test("recovers when compaction hides the rejected error from request context", () => {
	const signed = { role: "assistant", provider: model.provider, api: model.api, content: [reasoning("rs_bad"), { type: "text", text: "keep" }] };
	const messages = [signed, { role: "user", content: [{ type: "text", text: "continue" }] }];
	const branch = [{ type: "message", message: failure("rs_bad") }, { type: "compaction", summary: "prior work" }];
	assert.deepEqual(recoverReasoningContext(messages, model, new Set([model.provider]), branch)[0].content, [signed.content[1]]);
	assert.equal(recoverReasoningContext(messages, model), messages);
});

test("recognizes gateway error without an upstream code and discards malformed signed thinking", () => {
	const bad = { role: "assistant", provider: model.provider, api: model.api, content: [{ type: "thinking", thinkingSignature: "not-json" }, reasoning("rs_bad")] };
	const error = { ...failure("rs_bad"), errorMessage: "The encrypted content for item rs_bad could not be verified. Reason: Encrypted content could not be decrypted or parsed." };
	assert.deepEqual(recoverReasoningContext([bad, error], model), [error]);
});

test("retries a failed request once, without retrying unrelated or prior failures", () => {
	const error = failure("rs_bad");
	const branch = [{ type: "message", message: { role: "user" } }, { type: "message", message: error }];
	const event = { outcome: "error", continue: false, entries: [], context: { contextMessages: [error] } };
	const retry = planRecoveryRetry(event, model, branch);
	assert.equal(retry.continue, true);
	assert.equal(retry.entries[0].customType, "encrypted-reasoning-recovery-retry");
	assert.equal(planRecoveryRetry(event, model, [...branch, retry.entries[0]]), undefined);
	assert.equal(planRecoveryRetry({ ...event, outcome: "aborted" }, model, branch), undefined);
	assert.equal(planRecoveryRetry(event, model, [...branch, { type: "message", message: { role: "user" } }]), undefined);
});

test("registers request-local context and boundary hooks", () => {
	const handlers = {};
	recoveryExtension({ on(event, callback) { handlers[event] = callback; } });
	const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
	const ctx = { model, sessionManager: { getBranch: () => [] } };
	assert.equal(handlers.context({ messages }, ctx), undefined);
	assert.equal(handlers.agent_before_settle({ outcome: "completed", continue: false }, ctx), undefined);
});
