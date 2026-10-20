/**
 * workers-ai-provider 4.0.0 turns both the native `response` / `tool_calls` fields and the OpenAI-style
 * `choices[0].delta` of one SSE event into deltas. Models that send both formats in every event (for
 * example Llama 3.3 70B) then repeat their text ("OK." becomes "OKOK..") and their tool calls. These
 * helpers drop the native copy from such events before the provider reads them; events in only one
 * format pass through unchanged, and nothing is compared by text, so genuinely repeated words stay.
 * Remove them once a provider release maps only one of the two (cloudflare/ai#615).
 */

const SSE_DATA_LINE = /^(data: ?)(\{.*\})(\r?)$/s;

function hasText(value: unknown): boolean {
	return typeof value === "string" && value.length > 0;
}

/** One SSE line with the duplicate native fields removed; anything that is not a JSON data line is returned as is. */
function dropDuplicateNativeFields(line: string): string {
	const match = SSE_DATA_LINE.exec(line);
	if (!match) return line;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(match[2]) as Record<string, unknown>;
	} catch {
		return line;
	}
	const choices = event.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
	const delta = Array.isArray(choices) ? choices[0]?.delta : undefined;
	if (!delta || typeof delta !== "object") return line;
	let changed = false;
	if ("response" in event && hasText(delta.content)) {
		delete event.response;
		changed = true;
	}
	if ("tool_calls" in event && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
		delete event.tool_calls;
		changed = true;
	}
	return changed ? `${match[1]}${JSON.stringify(event)}${match[3]}` : line;
}

/** The stream with `dropDuplicateNativeFields` applied to every line, including lines split across chunks. */
function dedupeWorkersAIStream(stream: ReadableStream<Uint8Array | string>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let pending = "";
	return stream.pipeThrough(
		new TransformStream<Uint8Array | string, Uint8Array>({
			transform(chunk, controller) {
				const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
				const lines = (pending + text).split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) controller.enqueue(encoder.encode(`${dropDuplicateNativeFields(line)}\n`));
			},
			flush(controller) {
				const rest = pending + decoder.decode();
				if (rest) controller.enqueue(encoder.encode(dropDuplicateNativeFields(rest)));
			},
		}),
	);
}

type RunnableBinding = { run: (...args: never[]) => Promise<unknown> };

/**
 * The binding with `run` returning a deduplicated stream when the result is a stream. Other members are
 * bound to the real binding, because native binding methods reject a proxy as `this`.
 */
export function withDedupedStreams<T extends RunnableBinding>(binding: T): T {
	return new Proxy(binding, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (prop === "run" && typeof value === "function") {
				return async (...args: unknown[]) => {
					const result = await (value as (...runArgs: unknown[]) => Promise<unknown>).apply(target, args);
					return result instanceof ReadableStream ? dedupeWorkersAIStream(result) : result;
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
