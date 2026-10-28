"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { routesVendorModelIds } from "@/lib/agent/model-prices-utils";
import type { AgentModelOption } from "@/lib/agent/provider-types";
import type { AgentAdminForm } from "./types";
import { updateAgentModelRate } from "./utils";
import {
	clearAgentModelRate,
	costRateView,
	formatRate,
	longContextText,
	overrideAgentModelRate,
} from "./cost-rates-utils";

type CostRatesProps = {
	form: AgentAdminForm;
	models: AgentModelOption[];
	selectedModelIds: string[];
	setForm: (update: (current: AgentAdminForm) => AgentAdminForm) => void;
};

function RateInput({
	label,
	value,
	disabled,
	onChange,
}: {
	label: string;
	value: number | null | undefined;
	disabled?: boolean;
	onChange?: (value: string) => void;
}) {
	return (
		<label className="text-xs text-neutral-500">
			{label}{" "}
			<Input
				type="number"
				min="0"
				step="any"
				value={value ?? ""}
				disabled={disabled}
				readOnly={disabled}
				onChange={(event) => onChange?.(event.target.value)}
				placeholder="USD / 1M"
			/>
		</label>
	);
}

/**
 * The "Estimated cost rates" list: a rate from the provider's catalog is read-only, one from Kite's price list is
 * shown greyed with its date and source until the admin overrides it, and any other model takes the admin's own rate.
 */
export function CostRates({ form, models, selectedModelIds, setForm }: CostRatesProps) {
	const [overriding, setOverriding] = useState<ReadonlySet<string>>(new Set());
	const toggle = (model: string, on: boolean) =>
		setOverriding((current) => {
			const next = new Set(current);
			if (on) next.add(model);
			else next.delete(model);
			return next;
		});

	return (
		<div id="cost-rates" className="scroll-mt-4 space-y-3">
			<p className="text-sm font-medium">Estimated cost rates</p>
			<p className="text-xs text-neutral-500">
				USD per 1 million tokens. Rates published by the provider are used automatically, and for well-known models
				Kite&apos;s own price list fills in; enter rates yourself for other models or to override Kite&apos;s. Models
				with a rate count against the daily spend cap below; usage without both rates shows spending as unavailable and
				counts against the token allowances instead.
			</p>
			{selectedModelIds.map((model) => {
				const view = costRateView(
					model,
					form.rates,
					models,
					overriding.has(model),
					undefined,
					routesVendorModelIds(form.provider === "cloudflare" ? "cloudflare" : form.preset),
				);
				if (view.kind === "provider")
					return (
						<div
							key={model}
							className="grid gap-2 rounded-xl border border-neutral-200 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
						>
							<span className="min-w-0 break-all">{model}</span>
							<span className="text-neutral-500">
								Input ${form.rates[model]?.input} · Output ${form.rates[model]?.output} / 1M{" "}
								<span className="text-xs">(from provider)</span>
							</span>
						</div>
					);
				const builtin = view.kind === "builtin" ? view.price : view.builtin;
				const longContext = view.kind === "builtin" ? longContextText(view.price) : null;
				return (
					<div
						key={model}
						data-testid={`cost-rate-${model}`}
						className="grid gap-2 rounded-xl border border-neutral-200 p-3 sm:grid-cols-[minmax(0,1fr)_6rem_6rem]"
					>
						<span className="min-w-0 break-all text-sm">{model}</span>
						{view.kind === "builtin" ? (
							<>
								<RateInput label="Input" value={view.price.input} disabled />
								<RateInput label="Output" value={view.price.output} disabled />
							</>
						) : (
							<>
								<RateInput
									label="Input"
									value={form.rates[model]?.input}
									onChange={(value) => setForm((current) => updateAgentModelRate(current, model, "input", value))}
								/>
								<RateInput
									label="Output"
									value={form.rates[model]?.output}
									onChange={(value) => setForm((current) => updateAgentModelRate(current, model, "output", value))}
								/>
							</>
						)}
						{builtin && (
							<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500 sm:col-span-3">
								{view.kind === "builtin" ? (
									<>
										<span>
											From Kite&apos;s price list (as of {builtin.asOf}) ·{" "}
											<a href={builtin.source} target="_blank" rel="noreferrer" className="underline">
												source
											</a>
										</span>
										{longContext && <span>{longContext}</span>}
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-auto px-1 py-0 text-xs font-medium text-blue-700 underline"
											onClick={() => {
												toggle(model, true);
												setForm((current) => overrideAgentModelRate(current, model, builtin));
											}}
										>
											Override
										</Button>
									</>
								) : (
									<>
										<span>
											{`Your rate is used instead of Kite's price list (input $${formatRate(builtin.input)} · output $${formatRate(builtin.output)} as of ${builtin.asOf}).`}
										</span>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-auto px-1 py-0 text-xs font-medium text-blue-700 underline"
											onClick={() => {
												toggle(model, false);
												setForm((current) => clearAgentModelRate(current, model));
											}}
										>
											Use Kite&apos;s price
										</Button>
									</>
								)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
