"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_CLOUDFLARE_MODEL } from "@/lib/agent/provider-constants";
import { toggleAgentModelId } from "@/lib/agent/model-ids";
import type { AgentModelOption } from "@/lib/agent/provider-types";
import type { AgentAdminForm } from "./types";

type ModelPickerProps = {
	form: AgentAdminForm;
	selectedModelIds: string[];
	catalog: {
		models: AgentModelOption[];
		modelSource: "catalog" | "suggested" | null;
		modelsLoading: boolean;
		modelError: string | null;
	};
	setForm: (update: (current: AgentAdminForm) => AgentAdminForm) => void;
};

/** The provider's catalog as checkboxes, and the model ids as text for models the catalog does not list. */
export function ModelPicker({ form, selectedModelIds, catalog, setForm }: ModelPickerProps) {
	const { models, modelSource, modelsLoading, modelError } = catalog;
	return (
		<div className="space-y-2">
			<p className="text-sm font-medium">Models</p>
			<div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-neutral-200 p-3">
				{modelsLoading && <p className="text-sm text-neutral-500">Loading models…</p>}
				{!modelsLoading && !models.length && <p className="text-sm text-neutral-500">Models unavailable</p>}
				{models.map((item) => (
					<label key={item.id} className="flex items-start gap-2 text-sm">
						<Checkbox
							checked={selectedModelIds.includes(item.id)}
							onChange={(event) =>
								setForm((current) => ({
									...current,
									model: toggleAgentModelId(current.model, item.id, event.target.checked),
								}))
							}
						/>
						<span>{item.name === item.id ? item.id : `${item.name} · ${item.id}`}</span>
					</label>
				))}
			</div>
			{modelSource === "suggested" && (
				<p className="text-xs text-neutral-500">
					Showing suggested Cloudflare models because a full catalog is unavailable.
				</p>
			)}
			{modelError && <p className="text-xs text-amber-700">{modelError}</p>}
			<Label htmlFor="agent-model-id" className="block pt-2 text-xs text-neutral-500">
				Or enter model IDs (comma-separated)
			</Label>
			<Input
				id="agent-model-id"
				value={form.model}
				onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
				placeholder={
					form.provider === "cloudflare" ? DEFAULT_CLOUDFLARE_MODEL : "provider/model-id, provider/another-model"
				}
				required
			/>
			<p className="text-xs text-neutral-500">
				Choose models that support tool calling so the assistant can read mail and create drafts. The first model is the
				default.
			</p>
		</div>
	);
}
