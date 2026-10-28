import type { AgentLongContextRates, AgentModelRates, BuiltinModelPrice } from "./provider-types";
import priceList from "./model-prices.json";

/** A price that takes over from `from` (a UTC date), for providers that publish a scheduled change. */
type ModelPriceChange = { from: string; input: number; output: number };

/** One model in `model-prices.json`. Prices are USD per 1M tokens from the provider's official pricing page. */
export type ModelPriceEntry = {
	id: string;
	provider: string;
	input: number;
	output: number;
	/** Other ids for the same model at the same price, such as Anthropic's dated snapshot of an alias. */
	aliases?: string[];
	/** Whether `<id>-YYYYMMDD` and `<id>-YYYY-MM-DD` match too; only set where every snapshot has the same price. */
	datedIds?: boolean;
	longContext?: AgentLongContextRates;
	changes?: ModelPriceChange[];
	source: string;
	asOf: string;
};

const MODEL_PRICES: readonly ModelPriceEntry[] = priceList.models;

const DATED_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;
const indexes = new WeakMap<readonly ModelPriceEntry[], Map<string, ModelPriceEntry>>();

/** Ids compare case-insensitively, and Gemini's `models/` prefix is dropped. */
function normalizeModelId(id: string): string {
	return id
		.trim()
		.toLowerCase()
		.replace(/^models\//, "");
}

function priceIndex(entries: readonly ModelPriceEntry[]): Map<string, ModelPriceEntry> {
	let index = indexes.get(entries);
	if (!index) {
		index = new Map();
		for (const entry of entries)
			for (const id of [entry.id, ...(entry.aliases ?? [])]) index.set(normalizeModelId(id), entry);
		indexes.set(entries, index);
	}
	return index;
}

/** An exact id or alias first, then the id without a dated suffix where allowed. */
function matchModelId(index: Map<string, ModelPriceEntry>, id: string): ModelPriceEntry | null {
	const exact = index.get(id);
	if (exact) return exact;
	const undated = id.replace(DATED_SUFFIX, "");
	const entry = undated === id ? undefined : index.get(undated);
	return entry?.datedIds ? entry : null;
}

/**
 * Providers that route to other vendors' models under `vendor/model` ids, as the provider label usage rows record
 * (`"cloudflare"` or the compatible preset). A direct vendor's own ids never get another vendor's price.
 */
const ROUTER_PROVIDERS: readonly string[] = ["openrouter", "haimaker", "custom"];

export function routesVendorModelIds(provider: string | null | undefined): boolean {
	return !!provider && ROUTER_PROVIDERS.includes(provider);
}

/** Matching options: `vendorPrefixed` lets a router's `vendor/model` id take the vendor's price. */
export type ModelPriceMatch = { vendorPrefixed?: boolean };

/**
 * The vendor prefix routers put before a model id (`anthropic/claude-opus-5-5` on OpenRouter, `deepseek/deepseek-v4.1-flash`
 * on Haimaker), mapped to the provider whose list price the router passes on. OpenRouter writes Anthropic's version
 * with dots (`claude-opus-4.5`), so those ids also match with dashes.
 */
const ROUTER_VENDORS: Record<string, string> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	deepseek: "deepseek",
};
const VENDOR_PREFIXED = /^([a-z0-9-]+)\/([^/]+)$/;

/**
 * The entry for a model id: as listed (Groq's `openai/gpt-oss-120b` is), else, for a router's `vendor/model` id when
 * `match.vendorPrefixed`, the vendor's own model, but only an entry of that vendor.
 */
function findModelPriceEntry(
	modelId: string,
	entries: readonly ModelPriceEntry[] = MODEL_PRICES,
	match: ModelPriceMatch = {},
): ModelPriceEntry | null {
	const index = priceIndex(entries);
	const id = normalizeModelId(modelId);
	const listed = matchModelId(index, id);
	if (listed || !match.vendorPrefixed) return listed;
	const [, vendor, model] = VENDOR_PREFIXED.exec(id) ?? [];
	const provider = vendor ? ROUTER_VENDORS[vendor] : undefined;
	if (!provider) return null;
	const candidates = provider === "anthropic" ? [model, model.replace(/(\d)\.(\d)/g, "$1-$2")] : [model];
	for (const candidate of candidates) {
		const entry = matchModelId(index, candidate);
		if (entry?.provider === provider) return entry;
	}
	return null;
}

/** A model's built-in price on `now`'s UTC date, or null when Kite's list does not know the model. */
export function builtinModelPrice(
	modelId: string,
	now: Date = new Date(),
	entries: readonly ModelPriceEntry[] = MODEL_PRICES,
	match: ModelPriceMatch = {},
): BuiltinModelPrice | null {
	const entry = findModelPriceEntry(modelId, entries, match);
	if (!entry) return null;
	const today = now.toISOString().slice(0, 10);
	let change: ModelPriceChange | undefined;
	for (const item of entry.changes ?? []) if (item.from <= today && (!change || item.from > change.from)) change = item;
	return {
		id: entry.id,
		input: change?.input ?? entry.input,
		output: change?.output ?? entry.output,
		...(entry.longContext ? { longContext: entry.longContext } : {}),
		source: entry.source,
		asOf: entry.asOf,
	};
}

/**
 * The rates spend counts with for each model: the admin's saved rates (typed, or published by the provider's catalog
 * and saved with the model list) win field by field, then Kite's price list; a model in neither keeps no rates, so
 * the token allowances apply. Long-context rates come along only when no saved rate is used.
 */
export function resolveAgentModelRates(
	saved: Record<string, AgentModelRates>,
	modelIds: readonly string[],
	now: Date = new Date(),
	entries: readonly ModelPriceEntry[] = MODEL_PRICES,
	match: ModelPriceMatch = {},
): Record<string, AgentModelRates> {
	const resolved: Record<string, AgentModelRates> = { ...saved };
	for (const id of new Set([...modelIds, ...Object.keys(saved)])) {
		const own = saved[id];
		if (own && own.input !== null && own.output !== null) continue;
		const builtin = builtinModelPrice(id, now, entries, match);
		if (!builtin) continue;
		const manual = own?.input != null || own?.output != null;
		resolved[id] = {
			input: own?.input ?? builtin.input,
			output: own?.output ?? builtin.output,
			...(own?.reasoningEffort ? { reasoningEffort: own.reasoningEffort } : {}),
			...(!manual && builtin.longContext ? { longContext: builtin.longContext } : {}),
		};
	}
	return resolved;
}
