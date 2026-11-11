"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";

/** What both providers' status answers have in common. */
export type OAuthClientStatusBase = {
	source: "env" | "settings" | null;
	clientId: string | null;
	redirectUri: string;
	appUrlSet: boolean;
	unreadable: boolean;
	keyConfigured: boolean;
	migrationPending: boolean;
};

type TextField<Status> = { id: string; label: string; placeholder: (status: Status) => string };

export type OAuthClientFormConfig<Status extends OAuthClientStatusBase> = {
	/** `microsoft` or `google`: the API path, the query key and the `data-<provider>-sign-in-*` attributes. */
	provider: "microsoft" | "google";
	title: string;
	intro: ReactNode;
	statusText: (status: Status) => string;
	redirect: { id: string; label: string; appUrlHint: string };
	clientId: TextField<Status>;
	/** The provider's second field (Microsoft's tenant, Google's Workspace domain), sent as `extra.key`. */
	extra: TextField<Status> & { key: string };
	secret: { id: string; label: string; help: string };
	saved: string;
	remove: { title: string; description: string; done: string };
};

/**
 * A provider's OAuth client in Admin → General (spec §15.1): the redirect URI to register, the client ID, the
 * provider's second field and the secret. The secret is checked with the provider, saved sealed and never shown
 * again. Steps are in docs/providers.md.
 */
export function OAuthClientForm<Status extends OAuthClientStatusBase>({
	config,
}: {
	config: OAuthClientFormConfig<Status>;
}) {
	const endpoint = `/api/admin/external-accounts/${config.provider}`;
	const queryKey = ["admin", "external-accounts", config.provider];
	const name = `${config.provider}-sign-in`;
	const queryClient = useQueryClient();
	const { data } = useQuery({
		queryKey,
		queryFn: async () => (await readStatus<Status>(await authFetch(endpoint, { cache: "no-store" }), config)).status,
		refetchOnWindowFocus: false,
	});
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [extra, setExtra] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

	async function run(action: () => Promise<string>) {
		setBusy(true);
		setMessage("");
		setError("");
		try {
			setMessage(await action());
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not save");
		} finally {
			setBusy(false);
		}
	}

	const save = () =>
		run(async () => {
			const result = await readStatus<Status>(
				await authFetch(endpoint, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ clientId, clientSecret, [config.extra.key]: extra }),
				}),
				config,
			);
			setClientSecret("");
			queryClient.setQueryData(queryKey, result.status);
			return result.warning ?? config.saved;
		});

	const remove = () =>
		run(async () => {
			const confirmed = await requestConfirmation({
				title: config.remove.title,
				description: config.remove.description,
				confirmLabel: "Remove",
			});
			if (!confirmed) return "";
			const result = await readStatus<Status>(await authFetch(endpoint, { method: "DELETE" }), config);
			queryClient.setQueryData(queryKey, result.status);
			return config.remove.done;
		});

	if (!data) return null;
	const editable = data.source !== "env" && !data.migrationPending && data.keyConfigured;
	return (
		<section className="space-y-3 border-t border-neutral-200 pt-4" {...{ [`data-${name}-settings`]: "" }}>
			<h3 className="font-medium text-neutral-900">{config.title}</h3>
			<p {...{ [`data-${name}-status`]: "" }}>{config.statusText(data)}</p>
			<p>{config.intro}</p>
			<div className="space-y-1">
				<Label htmlFor={config.redirect.id}>{config.redirect.label}</Label>
				<Input
					id={config.redirect.id}
					readOnly
					value={data.redirectUri}
					onFocus={(event) => event.currentTarget.select()}
				/>
				{!data.appUrlSet && <p className="text-xs text-neutral-500">{config.redirect.appUrlHint}</p>}
			</div>
			{!data.keyConfigured && data.source !== "env" && (
				<p className="text-neutral-500">Set APP_ENCRYPTION_KEY first: Kite only saves the client secret encrypted.</p>
			)}
			{editable && (
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div className="grid gap-3 md:grid-cols-2">
						<ClientTextField field={config.clientId} status={data} value={clientId} onChange={setClientId} />
						<ClientTextField field={config.extra} status={data} value={extra} onChange={setExtra} />
					</div>
					<div className="space-y-1">
						<Label htmlFor={config.secret.id}>{config.secret.label}</Label>
						<Input
							id={config.secret.id}
							type="password"
							value={clientSecret}
							onChange={(event) => setClientSecret(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
						<p className="text-xs text-neutral-500">{config.secret.help}</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button type="submit" size="sm" disabled={busy || !clientId.trim() || !clientSecret.trim()}>
							{busy ? "Checking…" : data.source === "settings" ? "Replace" : "Save"}
						</Button>
						{data.source === "settings" && (
							<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
								Remove
							</Button>
						)}
					</div>
				</form>
			)}
			{message && (
				<p role="status" {...{ [`data-${name}-message`]: "" }}>
					{message}
				</p>
			)}
			{error && (
				<p role="alert" className="text-red-600">
					{error}
				</p>
			)}
		</section>
	);
}

function ClientTextField<Status>({
	field,
	status,
	value,
	onChange,
}: {
	field: TextField<Status>;
	status: Status;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-1">
			<Label htmlFor={field.id}>{field.label}</Label>
			<Input
				id={field.id}
				value={value}
				placeholder={field.placeholder(status)}
				onChange={(event) => onChange(event.target.value)}
				autoComplete="off"
				spellCheck={false}
			/>
		</div>
	);
}

async function readStatus<Status>(
	response: Response,
	config: { title: string },
): Promise<{ status: Status; warning?: string }> {
	const data = (await response.json().catch(() => ({}))) as {
		status?: Status;
		warning?: string;
		error?: string;
	};
	if (!response.ok) throw new Error(data.error ?? `Could not load ${config.title}`);
	// GET answers the status itself; PUT and DELETE wrap it.
	return { status: data.status ?? (data as Status), warning: data.warning };
}
