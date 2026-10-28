"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { parseAgentModelIds } from "@/lib/agent/model-ids";
import { CostRates } from "./cost-rates";
import { ModelPicker } from "./model-picker";
import { ProviderEndpointFields } from "./provider-endpoint-fields";
import type { AgentAdminForm, AgentAdminSettingsResponse, AgentProviderEditTarget } from "./types";
import { useAgentModels } from "./use-agent-models";
import {
	agentProviderFormBlocked,
	agentProviderSubmitLabel,
	PROVIDER_PRESETS,
	saveAgentProvider,
	selectAgentProvider,
} from "./utils";

type ProviderFormProps = {
	target: AgentProviderEditTarget;
	initial: AgentAdminForm;
	/** Whether a key is stored for the provider being edited, for its initial endpoint. */
	hasSavedKey: boolean;
	cloudflareAvailable: boolean;
	/** False before migration 0077: there is one provider and it has no name. */
	providersReady: boolean;
	onSaved: (data: AgentAdminSettingsResponse) => void;
	/** The stored key could not be opened (sealed under another APP_ENCRYPTION_KEY). */
	keyUnreadable?: boolean;
	onCancel?: () => void;
};

/** The settings of one provider: kind, endpoint, key, models and their rates. */
export function ProviderForm(props: ProviderFormProps) {
	const { target, initial, hasSavedKey, cloudflareAvailable, providersReady, onSaved, onCancel, keyUnreadable } = props;
	const [form, setForm] = useState<AgentAdminForm>(initial);
	const [activate, setActivate] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const isNew = target.kind === "new";
	const canUseSavedKey = hasSavedKey && initial.preset === form.preset && initial.baseUrl === form.baseUrl;
	const selectedModelIds = parseAgentModelIds(form.model);
	const catalog = useAgentModels(form, target, canUseSavedKey, setForm);

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true);
		setError(null);
		try {
			const data = await saveAgentProvider(target, form, activate);
			onSaved(data);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save agent settings");
		} finally {
			setSaving(false);
		}
	}

	return (
		<form onSubmit={submit} className="space-y-5">
			{providersReady && (
				<div className="space-y-2">
					<Label htmlFor="agent-provider-name">Name</Label>
					<Input
						id="agent-provider-name"
						value={form.name}
						maxLength={80}
						placeholder="For example Haimaker (work account)"
						onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
					/>
				</div>
			)}
			<div className="space-y-2">
				<Label htmlFor="agent-provider">Provider</Label>
				<Select
					id="agent-provider"
					containerClassName="h-10 w-full"
					className="text-sm"
					value={form.provider === "cloudflare" ? "cloudflare" : form.preset}
					onChange={(event) => setForm((current) => selectAgentProvider(current, event.target.value))}
				>
					{PROVIDER_PRESETS.map((item) => (
						<option key={item.id} value={item.id}>
							{item.label}
						</option>
					))}
					<option value="cloudflare">Cloudflare Workers AI</option>
				</Select>
				{form.provider === "cloudflare" && !cloudflareAvailable && (
					<p className="text-xs text-amber-700">Cloudflare Workers AI requires an AI binding on this installation.</p>
				)}
			</div>
			{form.provider === "compatible" && (
				<ProviderEndpointFields
					form={form}
					canUseSavedKey={canUseSavedKey}
					keyUnreadable={!!keyUnreadable}
					setForm={setForm}
				/>
			)}
			<ModelPicker form={form} selectedModelIds={selectedModelIds} catalog={catalog} setForm={setForm} />
			<CostRates form={form} models={catalog.models} selectedModelIds={selectedModelIds} setForm={setForm} />
			{isNew && (
				<label className="flex items-center gap-2 text-sm text-neutral-700">
					<Checkbox checked={activate} onChange={(event) => setActivate(event.target.checked)} />
					Use this provider now
				</label>
			)}
			{error && (
				<p role="status" className="text-sm text-neutral-700">
					{error}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					type="submit"
					disabled={saving || agentProviderFormBlocked(form, { selectedModelIds, cloudflareAvailable, canUseSavedKey })}
				>
					{saving ? "Saving…" : agentProviderSubmitLabel(target, providersReady)}
				</Button>
				{onCancel && (
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancel
					</Button>
				)}
			</div>
		</form>
	);
}
