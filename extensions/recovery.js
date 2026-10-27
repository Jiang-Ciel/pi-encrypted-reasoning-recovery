const ITEM_PATTERN = /The encrypted content for item (rs_[A-Za-z0-9_-]+) could not be verified/i;
const RETRY_TYPE = "encrypted-reasoning-recovery-retry";

function isRejectedReasoningError(message, provider) {
	if (message?.role !== "assistant" || message.provider !== provider || message.stopReason !== "error") return false;
	const error = message.errorMessage;
	// Some compatible gateways wrap the upstream error and omit its structured code.
	return typeof error === "string" && ITEM_PATTERN.test(error);
}

function isUnsafeThinking(block) {
	if (block.type !== "thinking" || !block.thinkingSignature) return false;
	try {
		return Boolean(JSON.parse(block.thinkingSignature).encrypted_content);
	} catch {
		// The Responses serializer parses signed thinking as JSON.
		return true;
	}
}

export function recoverReasoningContext(messages, model, providers = new Set(["my_model_hub"]), branch = []) {
	if (model?.api !== "openai-responses" || !providers.has(model.provider)) return messages;

	// Compaction can hide the original error from the projected request context.
	const hasRejectedReasoning = messages.some((message) => isRejectedReasoningError(message, model.provider)) ||
		branch.some((entry) => entry.type === "message" && isRejectedReasoningError(entry.message, model.provider));
	if (!hasRejectedReasoning) return messages;

	return messages.flatMap((message) => {
		if (message.role !== "assistant" || message.provider !== model.provider || message.api !== "openai-responses" || !Array.isArray(message.content)) {
			return [message];
		}
		const content = message.content.filter((block) => !isUnsafeThinking(block));
		if (content.length === message.content.length) return [message];
		return content.length ? [{ ...message, content }] : [];
	});
}

export function planRecoveryRetry(event, model, branch, providers = new Set(["my_model_hub"])) {
	if (event.outcome !== "error" || event.continue || model?.api !== "openai-responses" || !providers.has(model.provider)) return;
	const lastMessage = branch.findLast((entry) => entry.type === "message")?.message;
	if (!isRejectedReasoningError(lastMessage, model.provider)) return;

	const lastUserIndex = branch.findLastIndex((entry) => entry.type === "message" && entry.message?.role === "user");
	const alreadyRetried = branch.slice(lastUserIndex + 1).some((entry) => entry.type === "custom_message" && entry.customType === RETRY_TYPE);
	if (alreadyRetried || event.entries.some((entry) => entry.type === "custom_message" && entry.customType === RETRY_TYPE)) return;

	return {
		entries: [...event.entries, {
			type: "custom_message",
			customType: RETRY_TYPE,
			content: "Continue the interrupted task using the remaining conversation and tool results.",
			display: false,
		}],
		continue: true,
	};
}

export default function (pi) {
	const providers = new Set(
		(process.env.PI_REASONING_RECOVERY_PROVIDERS || "my_model_hub")
			.split(",")
			.map((provider) => provider.trim())
			.filter(Boolean),
	);
	pi.on("context", (event, ctx) => {
		const messages = recoverReasoningContext(event.messages, ctx.model, providers, ctx.sessionManager.getBranch());
		if (messages !== event.messages) return { messages };
	});
	pi.on("agent_before_settle", (event, ctx) => planRecoveryRetry(event, ctx.model, ctx.sessionManager.getBranch(), providers));
}
