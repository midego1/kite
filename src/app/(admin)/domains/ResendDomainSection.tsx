"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import type { ResendDomainView } from "@/lib/domains/resend-domain-types";
import ResendKeyRow from "./ResendKeyRow";
import { StatusRow } from "./status-row";

type ResendResponse = {
	keyConfigured?: boolean;
	canManageDomains?: boolean;
	resend?: ResendDomainView | null;
	error?: string;
};

async function postJson<T>(url: string, method: string, body: unknown): Promise<T> {
	const response = await authFetch(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Request failed");
	return data;
}

export default function ResendDomainSection({
	domainId,
	onStatus,
}: {
	domainId: string;
	onStatus?: (status: string | null) => void;
}) {
	const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
	const [view, setView] = useState<ResendDomainView | null>(null);
	const [canManage, setCanManage] = useState(true);
	const [loading, setLoading] = useState(true);
	const [reload, setReload] = useState(0);
	const [busy, setBusy] = useState<"setup" | "verify" | "test" | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	useEffect(() => {
		let active = true;
		authFetch(`/api/domains/${domainId}/resend`, { cache: "no-store" })
			.then(async (response) => ({ response, data: (await response.json()) as ResendResponse }))
			.then(({ response, data }) => {
				if (!active) return;
				if (!response.ok && data.keyConfigured === undefined) throw new Error(data.error ?? "Could not reach Resend");
				setKeyConfigured(data.keyConfigured ?? true);
				setCanManage(data.canManageDomains ?? true);
				setView(data.resend ?? null);
				setError(response.ok ? "" : (data.error ?? ""));
			})
			.catch((err) => {
				if (active) {
					setKeyConfigured(true);
					setError(err instanceof Error ? err.message : "Could not reach Resend");
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [domainId, reload]);

	useEffect(() => {
		if (loading) return;
		onStatus?.(keyConfigured === false ? "no_key" : canManage ? (view?.status ?? null) : null);
	}, [loading, keyConfigured, canManage, view, onStatus]);

	async function run(kind: "setup" | "verify" | "test", action: () => Promise<void>) {
		setBusy(kind);
		setError("");
		setNotice("");
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Request failed");
		} finally {
			setBusy(null);
		}
	}

	const domainAction = (action: "setup" | "verify") =>
		run(action, async () => {
			const data = await postJson<ResendResponse>(`/api/domains/${domainId}/resend`, "POST", { action });
			setView(data.resend ?? null);
		});
	const sendTest = () =>
		run("test", async () => {
			const data = await postJson<{ to: string }>(`/api/domains/${domainId}/resend`, "POST", { action: "test" });
			setNotice(`Test email sent to ${data.to}`);
		});

	const verified = view?.status === "verified";
	const needsFullKey = "Needs a full-access Resend API key";
	const domainLabel = loading
		? "Checking Resend…"
		: !canManage
			? "Cannot check: this key can only send mail"
			: !view
				? "Could not read the domain from Resend"
				: verified
					? "Domain verified in Resend"
					: view.registered
						? view.missingDns === 0
							? `DNS records added, waiting for Resend to verify (${view.status.replace(/_/g, " ")})`
							: view.missingDns
								? `${view.missingDns} DNS record${view.missingDns === 1 ? "" : "s"} missing in Cloudflare`
								: `DNS check: ${view.status.replace(/_/g, " ")}`
						: "Domain is not added to Resend yet";
	const domainButton = !canManage
		? "Setup domain"
		: !view
			? null
			: view.registered && !view.dnsManaged
				? "Verify"
				: !view.registered
					? view.dnsManaged
						? "Setup domain and DNS"
						: "Setup domain"
					: view.dnsManaged && view.missingDns !== 0
						? "Create missing DNS and verify"
						: "Check status";

	return (
		<div className="space-y-2">
			<ul className="space-y-2">
				<ResendKeyRow
					configured={keyConfigured}
					onChanged={(configured) => {
						setKeyConfigured(configured);
						if (!configured) setView(null);
						setLoading(true);
						setReload((value) => value + 1);
					}}
					onError={setError}
				/>

				{keyConfigured && (
					<StatusRow
						ok={verified}
						title="Domain"
						hint="Verified sender domain in Resend"
						action={
							verified ? (
								<Button
									size="sm"
									variant="outline"
									className="bg-white"
									disabled={busy !== null}
									onClick={() => void sendTest()}
								>
									{busy === "test" ? "Sending…" : "Send test email"}
								</Button>
							) : domainButton && !loading ? (
								<Button
									size="sm"
									variant="outline"
									className="bg-white"
									disabled={!canManage || busy !== null}
									title={canManage ? undefined : needsFullKey}
									onClick={() =>
										void domainAction(
											view?.registered && (!view.dnsManaged || view.missingDns === 0) ? "verify" : "setup",
										)
									}
								>
									{busy === "verify" ? "Checking…" : busy === "setup" ? "Working…" : domainButton}
								</Button>
							) : undefined
						}
					>
						{domainLabel}
					</StatusRow>
				)}
			</ul>

			{!loading && !canManage && keyConfigured && (
				<p className="text-xs text-neutral-500">
					Add this domain at resend.com/domains and create the DNS records it shows, then send a test email. Or replace
					the key with a full-access one so Kite can set it up.
				</p>
			)}
			{view && view.registered && !verified && !view.dnsManaged && (
				<p className="text-xs text-neutral-500">
					Add these records where this domain&apos;s DNS is hosted, then verify.
				</p>
			)}
			{view && view.registered && !verified && view.dnsManaged && view.missingDns === 0 && (
				<p className="text-xs text-neutral-500">
					DNS changes can take a few minutes to propagate. Check again shortly.
				</p>
			)}

			{view && view.records.length > 0 && !verified && (
				<ul className="space-y-1 text-xs text-neutral-600">
					{view.records.map((record) => (
						<li
							key={`${record.type}-${record.name}-${record.value}`}
							className="grid gap-1 rounded-lg bg-white px-3 py-2 sm:grid-cols-[4rem_minmax(8rem,14rem)_minmax(0,1fr)_auto]"
						>
							<span className="font-medium">{record.type}</span>
							<span className="break-all">{record.name}</span>
							<span className="break-all">
								{record.priority !== null ? `${record.priority} ` : ""}
								{record.value}
							</span>
							<span className="uppercase text-neutral-400">{record.status.replace(/_/g, " ")}</span>
						</li>
					))}
				</ul>
			)}
			{notice && (
				<p role="status" className="text-xs text-green-700">
					{notice}
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}
