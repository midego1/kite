import type { JsonValue } from "./module-types";

const JSON_MAX_DEPTH = 32;
const JSON_MAX_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) return "array";
	return typeof value === "object"
		? ((Object.getPrototypeOf(value) as object | null)?.constructor?.name ?? "object")
		: typeof value;
}

function isArrayIndex(key: string | symbol, length: number): boolean {
	if (typeof key !== "string") return false;
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

/** Why an object or array is not plain JSON: a foreign prototype, symbol keys, or properties JSON.stringify would drop. */
function shapeProblem(value: object, path: string): string | null {
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (!Array.isArray(value)) {
		if (prototype !== Object.prototype && prototype !== null)
			return `${path} is a ${describe(value)}, which is not JSON`;
		return Object.getOwnPropertySymbols(value).length ? `${path} has a symbol key` : null;
	}
	if (prototype !== Array.prototype) return `${path} is a ${describe(value)}, which is not JSON`;
	const extra = Reflect.ownKeys(value).find((key) => key !== "length" && !isArrayIndex(key, value.length));
	// JSON.stringify drops these properties, so a handler could smuggle a function or secret past the scan.
	return extra === undefined ? null : `${path} has an extra property ${String(extra)}`;
}

function scan(value: unknown, path: string, depth: number, ancestors: object[]): string | null {
	if (value === null || typeof value === "boolean" || typeof value === "string") return null;
	if (typeof value === "number") return Number.isFinite(value) ? null : `${path} must be a finite number`;
	if (typeof value !== "object") return `${path} is a ${describe(value)}, which is not JSON`;
	if (depth >= JSON_MAX_DEPTH) return `${path} is nested deeper than ${JSON_MAX_DEPTH} levels`;
	if (ancestors.includes(value)) return `${path} contains a cycle`;
	const shape = shapeProblem(value, path);
	if (shape) return shape;
	ancestors.push(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				const problem = scan(index in value ? value[index] : undefined, `${path}[${index}]`, depth + 1, ancestors);
				if (problem) return problem;
			}
			return null;
		}
		for (const [key, item] of Object.entries(value)) {
			const problem = scan(item, `${path}.${key}`, depth + 1, ancestors);
			if (problem) return problem;
		}
		return null;
	} finally {
		ancestors.pop();
	}
}

/** Why a value is not plain JSON of a bounded size, or null when it is. */
export function jsonValueProblem(value: unknown, label = "value"): string | null {
	const problem = scan(value, label, 0, []);
	if (problem) return problem;
	if (encoder.encode(JSON.stringify(value)).length > JSON_MAX_BYTES) return `${label} is larger than 1 MiB`;
	return null;
}

/** @public Test-only: production code uses `jsonValueProblem`. */
export function assertJsonValue(value: unknown, label = "value"): asserts value is JsonValue {
	const problem = jsonValueProblem(value, label);
	if (problem) throw new TypeError(problem);
}
