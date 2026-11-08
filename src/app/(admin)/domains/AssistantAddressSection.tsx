"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { ApiError, requestJson } from "./api";
import type { Domain } from "./types";

type AssistantAddress = { id: string; domainId: string; localPart: string; address: string; enabled: boolean };

const NOT_READY =
	"Needs an active domain receiving through Cloudflare Email Routing or Amazon SES, with a sending provider set up.";

/**
 * Domains → domain details (docs/specs/assistant-by-email.md §14): create, enable, disable or delete this
 * domain's assistant address. Only the Cloudflare and SES receiving paths authenticate a request strongly
 * enough to trust (§5.1); Resend-received domains and the direct SMTP listener are not supported yet.
 */
export default function AssistantAddressSection({ domain }: { domain: Domain }) {
	const [address, setAddress] = useState<AssistantAddress | null | undefined>(undefined);
	const [localPart, setLocalPart] = useState("assistant");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		requestJson<{ assistantAddresses: AssistantAddress[] }>("/api/admin/assistant-addresses", "GET")
			.then((data) => {
				if (active) setAddress(data.assistantAddresses.find((row) => row.domainId === domain.id) ?? null);
			})
			.catch(() => {
				if (active) setAddress(null);
			});
		return () => {
			active = false;
		};
	}, [domain.id]);

	const canHost =
		domain.status === "active" &&
		(domain.receivingProvider === "cloudflare" || domain.receivingProvider === "ses") &&
		domain.sendingProvider !== "none";

	async function create() {
		setBusy(true);
		setError(null);
		try {
			const data = await requestJson<{ assistantAddress: AssistantAddress }>("/api/admin/assistant-addresses", "POST", {
				domainId: domain.id,
				localPart,
			});
			setAddress(data.assistantAddress);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "Could not create the assistant address");
		} finally {
			setBusy(false);
		}
	}

	async function toggle(enabled: boolean) {
		if (!address) return;
		setBusy(true);
		setError(null);
		try {
			const data = await requestJson<{ assistantAddress: AssistantAddress }>(
				`/api/admin/assistant-addresses/${address.id}`,
				"PATCH",
				{ enabled },
			);
			setAddress(data.assistantAddress);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "Could not update the assistant address");
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		if (!address) return;
		if (
			!(await requestConfirmation({
				title: `Remove ${address.address}?`,
				description: "Users who opted in will no longer be able to email the assistant on this domain.",
				confirmLabel: "Remove address",
			}))
		)
			return;
		setBusy(true);
		setError(null);
		try {
			await requestJson(`/api/admin/assistant-addresses/${address.id}`, "DELETE");
			setAddress(null);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "Could not remove the assistant address");
		} finally {
			setBusy(false);
		}
	}

	if (address === undefined) return null;

	return (
		<section className="mt-6">
			<h2 className="text-base font-semibold text-neutral-900">Assistant address</h2>
			<p className="mt-0.5 text-sm text-neutral-500">
				An address on this domain, such as <span className="font-mono">assistant@{domain.hostname}</span>, that users
				who opt in under Settings → Assistant can email requests to. The assistant never sends or changes anything
				without a confirmation in Kite; replies carry only a link, never the answer itself.
			</p>
			{!canHost && <p className="mt-2 text-xs text-[#8a4b0a] dark:text-[#d4a35a]">{NOT_READY}</p>}
			{address ? (
				<div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2">
					<span className="flex-1 truncate font-mono text-sm text-neutral-900">{address.address}</span>
					<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => toggle(!address.enabled)}>
						{address.enabled ? "Disable" : "Enable"}
					</Button>
					<Button type="button" variant="outline" size="sm" disabled={busy} onClick={remove}>
						Remove
					</Button>
				</div>
			) : (
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<Input
						value={localPart}
						onChange={(event) => setLocalPart(event.target.value)}
						disabled={busy || !canHost}
						className="max-w-40"
						aria-label="Assistant address local part"
					/>
					<span className="text-sm text-neutral-500">@{domain.hostname}</span>
					<Button type="button" size="sm" disabled={busy || !canHost || !localPart.trim()} onClick={create}>
						Create
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="mt-2 text-xs text-red-600">
					{error}
				</p>
			)}
			<p className="mt-2 text-xs text-neutral-500">
				Resend-receiving domains and the direct SMTP listener cannot host an assistant address yet.
			</p>
		</section>
	);
}
