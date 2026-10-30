const ITEM_PATTERN = /The encrypted content for item (rs_[A-Za-z0-9_-]+) could not be verified/i;
const RETRY_TYPE = "encrypted-reasoning-recovery-retry";
const LIMIT_RETRY_TYPE = "provider-limit-recovery-retry";

export function limitRetryOptions(env = process.env) {
	const integer = (name, fallback, min, max) => {
		const value = env[name] === undefined ? fallback : Number(env[name]);
		if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected ${min}..${max}`);
		return value;
	};
	return {
		intervalMs: integer("PI_LIMIT_RETRY_INTERVAL_MS", 60_000, 1, 3_600_000),
		maxRetries: integer("PI_LIMIT_RETRY_MAX_RETRIES", 5, 0, 100),
	};
}

export function isProviderLimitError(message, provider) {
	if (message?.role !== "assistant" || message.provider !== provider || message.stopReason !== "error") return false;
	const error = message.errorMessage;
	if (typeof error !== "string" || /billing|payment.required|balance|authentication|unauthorized|access.denied/i.test(error)) return false;
	return /\btpm\b|tokens? per minute|throughput limit|provisioned.managed|rate.?limit|too many requests|\b429\b|insufficient_quota|quota[ _-]*(?:exceeded|exhausted)|exceed(?:ed|s)?.{0,40}quota/i.test(error);
}

// Boundary continuations stay in the same session. Never discard executed tool
// results or replay a failed attempt containing tool calls in this recovery path.
export function planLimitRetry(event, model, branch, providers, options = limitRetryOptions()) {
	if (event.outcome !== "error" || event.continue || model?.api !== "openai-responses" || !providers.has(model.provider)) return;
	const failure = branch.findLast((entry) => entry.type === "message");
	if (!failure?.id || !isProviderLimitError(failure.message, model.provider) ||
		failure.message.content?.some((block) => block.type === "toolCall")) return;
	const lastUser = branch.findLastIndex((entry) => entry.type === "message" && entry.message?.role === "user");
	const attempts = [...branch.slice(lastUser + 1), ...event.entries]
		.filter((entry) => entry.type === "custom" && entry.customType === LIMIT_RETRY_TYPE && entry.data?.provider === model.provider);
	if (attempts.length >= options.maxRetries || attempts.some((entry) => entry.data?.failureId === failure.id)) return;
	return {
		entries: [...event.entries,
			{ type: "context_edit", targetId: failure.id, replacement: null },
			{ type: "custom", customType: LIMIT_RETRY_TYPE, data: {
				provider: model.provider, failureId: failure.id, attempt: attempts.length + 1,
				intervalMs: options.intervalMs,
			} },
		],
		continue: true,
	};
}

export function waitForRetry(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
		const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Aborted")); };
		const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

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

export default function (pi, { env = process.env, wait = waitForRetry } = {}) {
	const providers = new Set(
		(env.PI_REASONING_RECOVERY_PROVIDERS || "my_model_hub")
			.split(",")
			.map((provider) => provider.trim())
			.filter(Boolean),
	);
	const options = limitRetryOptions(env);
	const pending = new Map();
	const sessionKey = (ctx) => ctx.sessionManager.getSessionId();
	pi.on("context", (event, ctx) => {
		const messages = recoverReasoningContext(event.messages, ctx.model, providers, ctx.sessionManager.getBranch());
		if (messages !== event.messages) return { messages };
	});
	pi.on("agent_before_settle", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const recovery = planRecoveryRetry(event, ctx.model, branch, providers);
		if (recovery) return recovery;
		const retry = planLimitRetry(event, ctx.model, branch, providers, options);
		if (retry) {
			pending.set(sessionKey(ctx), retry.entries.at(-1).data);
			return retry;
		}
	});
	// Wait at the provider-request boundary, not agent_before_settle: Pi's
	// active AbortSignal is live here, so Escape/RPC abort interrupts the timer.
	pi.on("before_provider_request", async (_event, ctx) => {
		const key = sessionKey(ctx);
		const retry = pending.get(key);
		if (!retry) return;
		pending.delete(key);
		const signal = ctx.getSignal();
		if (!signal) throw new Error("Limit recovery requires Pi getSignal() support");
		ctx.ui?.setStatus?.(LIMIT_RETRY_TYPE, `额度/吞吐限流：${Math.ceil(retry.intervalMs / 1000)} 秒后重试 ${retry.attempt}/${options.maxRetries}`);
		try {
			await wait(retry.intervalMs, signal);
		} catch (error) {
			// Pi observes the aborted provider signal itself; avoid an extension
			// error notification on normal Escape/RPC cancellation.
			if (!signal.aborted) throw error;
		} finally {
			ctx.ui?.setStatus?.(LIMIT_RETRY_TYPE, undefined);
		}
	});
	pi.on("session_shutdown", (_event, ctx) => pending.delete(sessionKey(ctx)));
}
