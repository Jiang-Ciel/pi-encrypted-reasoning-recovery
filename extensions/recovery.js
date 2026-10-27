const INVALID_CONTENT = "invalid_encrypted_content";
const ITEM_PATTERN = /The encrypted content for item (rs_[A-Za-z0-9_-]+) could not be verified/;

export function recoverReasoningContext(messages, model, providers = new Set(["my_model_hub"])) {
	if (model?.api !== "openai-responses" || !providers.has(model.provider)) return messages;

	const hasRejectedReasoning = messages.some((message) => {
		if (message.role !== "assistant" || message.provider !== model.provider || message.stopReason !== "error") return false;
		const error = message.errorMessage;
		return typeof error === "string" && error.includes(INVALID_CONTENT) && ITEM_PATTERN.test(error);
	});
	if (!hasRejectedReasoning) return messages;

	return messages.flatMap((message) => {
		if (message.role !== "assistant" || message.provider !== model.provider || message.api !== "openai-responses" || !Array.isArray(message.content)) {
			return [message];
		}
		const content = message.content.filter((block) => {
			if (block.type !== "thinking" || !block.thinkingSignature) return true;
			try {
				return !JSON.parse(block.thinkingSignature).encrypted_content;
			} catch {
				return true;
			}
		});
		if (content.length === message.content.length) return [message];
		return content.length ? [{ ...message, content }] : [];
	});
}

export default function (pi) {
	const providers = new Set(
		(process.env.PI_REASONING_RECOVERY_PROVIDERS || "my_model_hub")
			.split(",")
			.map((provider) => provider.trim())
			.filter(Boolean),
	);
	pi.on("context", (event, ctx) => {
		const messages = recoverReasoningContext(event.messages, ctx.model, providers);
		if (messages !== event.messages) return { messages };
	});
}
