"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HaimakerReferralCard } from "./haimaker-referral-card";
import type { AgentAdminForm } from "./types";

type ProviderEndpointFieldsProps = {
	form: AgentAdminForm;
	canUseSavedKey: boolean;
	keyUnreadable: boolean;
	setForm: (update: (current: AgentAdminForm) => AgentAdminForm) => void;
};

/** Base URL and API key of an OpenAI-compatible provider, with Haimaker's referral card for Haimaker. */
export function ProviderEndpointFields({ form, canUseSavedKey, keyUnreadable, setForm }: ProviderEndpointFieldsProps) {
	return (
		<>
			{form.preset === "haimaker" && <HaimakerReferralCard />}
			<div className="space-y-2">
				<Label htmlFor="agent-url">API base URL</Label>
				<Input
					id="agent-url"
					type="url"
					value={form.baseUrl}
					readOnly={form.preset !== "custom"}
					placeholder="https://provider.example/v1"
					onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value, model: "" }))}
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="agent-key">API key</Label>
				<Input
					id="agent-key"
					type="password"
					value={form.apiKey}
					autoComplete="new-password"
					placeholder={canUseSavedKey ? "Saved key (leave blank to keep)" : "Enter API key"}
					onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
				/>
				{keyUnreadable && (
					<p role="alert" className="text-xs text-amber-700">
						Key unreadable, enter it again: the saved key was encrypted with another APP_ENCRYPTION_KEY.
					</p>
				)}
				<p className="text-xs text-neutral-500">
					{canUseSavedKey
						? "An API key is saved on the server. Enter a new one to replace it."
						: "The API key is stored on the server and is never shown again."}
				</p>
			</div>
		</>
	);
}
