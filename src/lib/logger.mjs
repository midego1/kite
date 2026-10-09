/** JSON-line logs shared by the app and relay. Pass operational metadata only. */
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const sensitiveKey =
	/authorization|cookie|password|secret|token|signature|body|headers|recipient|sender|forwardTo|email/i;

// Codes such as ECONNRESET or SQLITE_BUSY; anything else could be free text.
const safeErrorCode = /^[A-Za-z0-9_.:-]{1,64}$/;

/** @param {Error} error */
function safeError(error) {
	const code = /** @type {{code?: unknown}} */ (error).code;
	if ((typeof code === "string" && safeErrorCode.test(code) && !code.includes("@")) || Number.isInteger(code))
		return { type: error.name, code };
	return { type: error.name };
}

/** @param {unknown} value @param {WeakSet<object>} seen */
function safeValue(value, seen) {
	// Exception messages/stacks can contain mail, URLs and credentials. The event,
	// error type and a code-shaped `code` identify the failure without copying
	// those values into logs.
	if (value instanceof Error) return safeError(value);
	if (typeof value === "bigint") return value.toString();
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const result = Array.isArray(value)
		? value.map((item) => safeValue(item, seen))
		: Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					sensitiveKey.test(key)
						? "[REDACTED]"
						: key === "error" && !(item instanceof Error)
							? { type: typeof item }
							: safeValue(item, seen),
				]),
			);
	seen.delete(value);
	return result;
}

/**
 * @param {string} component
 * @param {{level?: 'debug'|'info'|'warn'|'error', sink?: (line: string, level: string) => void}} [options]
 */
export function createLogger(component, options = {}) {
	const envLevel = typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined;
	const level = options.level ?? (envLevel && Object.hasOwn(levels, envLevel) ? envLevel : "info");
	const threshold = levels[/** @type {keyof typeof levels} */ (level)];
	/** @param {keyof typeof levels} severity @param {string} event @param {Record<string, unknown>} [fields] */
	function write(severity, event, fields = {}) {
		if (levels[severity] < threshold) return;
		const line = JSON.stringify({
			timestamp: new Date().toISOString(),
			level: severity,
			component,
			event,
			fields: safeValue(fields, new WeakSet()),
		});
		if (options.sink) options.sink(line, severity);
		else if (severity === "error") console.error(line);
		else if (severity === "warn") console.warn(line);
		else console.log(line);
	}
	return {
		debug: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) =>
			write("debug", event, fields),
		info: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) =>
			write("info", event, fields),
		warn: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) =>
			write("warn", event, fields),
		error: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) =>
			write("error", event, fields),
	};
}
