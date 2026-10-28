import { builtinModelPrice } from "@/lib/agent/model-prices-utils";
import type { AgentModelOption, AgentModelRates, BuiltinModelPrice } from "@/lib/agent/provider-types";
import type { AgentAdminForm } from "./types";

/**
 * Where a selected model's rate comes from in the "Estimated cost rates" list: the provider's catalog (read-only),
 * Kite's price list (shown greyed until the admin overrides it), or the admin's own fields.
 */
export type CostRateView =
	| { kind: "provider" }
	| { kind: "builtin"; price: BuiltinModelPrice }
	| { kind: "manual"; builtin: BuiltinModelPrice | null };

function hasOwnRate(rates: AgentModelRates | undefined): boolean {
	return rates?.input != null || rates?.output != null;
}

export function costRateView(
	model: string,
	rates: Record<string, AgentModelRates>,
	models: AgentModelOption[],
	overriding: boolean,
	now: Date = new Date(),
): CostRateView {
	if (models.find((item) => item.id === model)?.rates) return { kind: "provider" };
	const builtin = builtinModelPrice(model, now);
	if (builtin && !overriding && !hasOwnRate(rates[model])) return { kind: "builtin", price: builtin };
	return { kind: "manual", builtin };
}

/** Starts an override from Kite's price, so the admin edits a value instead of an empty field. */
export function overrideAgentModelRate(form: AgentAdminForm, model: string, price: BuiltinModelPrice): AgentAdminForm {
	const current = form.rates[model] ?? { input: null, output: null };
	return { ...form, rates: { ...form.rates, [model]: { ...current, input: price.input, output: price.output } } };
}

/** Drops the admin's rate so Kite's price list applies again; a saved reasoning effort stays. */
export function clearAgentModelRate(form: AgentAdminForm, model: string): AgentAdminForm {
	const current = form.rates[model] ?? { input: null, output: null };
	return { ...form, rates: { ...form.rates, [model]: { ...current, input: null, output: null } } };
}

/** A USD rate with cents, keeping finer digits where a price has them ($0.027). */
export function formatRate(value: number): string {
	return Number.isInteger(Math.round(value * 1e6) / 1e4) ? value.toFixed(2) : String(value);
}

/** "Over 100,000 input tokens: input $0.50 · output $2.50 / 1M", or null for a flat price. */
export function longContextText(price: BuiltinModelPrice): string | null {
	const long = price.longContext;
	if (!long) return null;
	const threshold = long.aboveInputTokens.toLocaleString("en-US");
	return `Over ${threshold} input tokens: input $${formatRate(long.input)} · output $${formatRate(long.output)} / 1M`;
}
