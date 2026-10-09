"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SesSendingView } from "@/lib/aws/ses-sending-types";
import AwsCredentialsPanel from "./AwsCredentialsPanel";
import { requestJson } from "./api";
import { StatusRow } from "./status-row";

type SesResponse = { credentials?: boolean; ses?: SesSendingView | null; error?: string };

export default function SesSendingConfig({
	domainId,
	onStatus,
}: {
	domainId: string;
	onStatus?: (status: string | null) => void;
}) {
	const [credentials, setCredentials] = useState<boolean | null>(null);
	const [view, setView] = useState<SesSendingView | null>(null);
	const [loading, setLoading] = useState(true);
	const [reload, setReload] = useState(0);
	const [busy, setBusy] = useState<"setup" | "verify" | "test" | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	useEffect(() => {
		let active = true;
		requestJson<SesResponse>(`/api/domains/${domainId}/ses`, "GET")
			.then((data) => {
				if (active) {
					setCredentials(data.credentials ?? true);
					setView(data.ses ?? null);
					setError(data.error ?? "");
				}
			})
			.catch((err) => {
				if (active) setError(err instanceof Error ? err.message : "Could not reach AWS");
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
		onStatus?.(
			credentials === false
				? "no_credentials"
				: view
					? view.verified
						? "verified"
						: view.registered
							? "pending"
							: "not_registered"
					: null,
		);
	}, [loading, credentials, view, onStatus]);

	const run = useCallback(async (kind: "setup" | "verify" | "test", action: () => Promise<void>) => {
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
	}, []);

	const domainAction = (action: "setup" | "verify") =>
		run(action, async () => {
			const data = await requestJson<SesResponse>(`/api/domains/${domainId}/ses`, "POST", { action });
			setView(data.ses ?? null);
		});
	const sendTest = () =>
		run("test", async () => {
			const data = await requestJson<{ to: string }>(`/api/domains/${domainId}/ses`, "POST", { action: "test" });
			setNotice(`Test email sent to ${data.to}`);
		});

	const onCredentials = useCallback((configured: boolean) => {
		setCredentials(configured);
		setLoading(true);
		setReload((value) => value + 1);
	}, []);

	const label = loading
		? "Checking Amazon SES…"
		: !view
			? "Could not read the domain from SES"
			: view.verified
				? "Domain verified in SES"
				: !view.registered
					? "Domain is not added to SES yet"
					: view.missingDns === 0
						? `DNS records added, waiting for SES to verify (DKIM ${view.dkimStatus.toLowerCase()})`
						: view.missingDns
							? `${view.missingDns} DKIM record${view.missingDns === 1 ? "" : "s"} missing in Cloudflare`
							: `DKIM ${view.dkimStatus.toLowerCase()}`;
	const buttonLabel = !view
		? null
		: !view.registered
			? view.dnsManaged
				? "Setup domain and DNS"
				: "Setup domain"
			: view.dnsManaged && view.missingDns !== 0
				? "Create missing DNS and verify"
				: "Check status";

	return (
		<div className="space-y-2">
			<AwsCredentialsPanel need="sending" onChanged={onCredentials} />
			{credentials && (
				<ul className="space-y-2">
					<StatusRow
						ok={!!view?.verified}
						title="Domain"
						hint="Verified sender identity in SES"
						action={
							view?.verified ? (
								<Button
									size="sm"
									variant="outline"
									className="bg-white"
									disabled={busy !== null}
									onClick={() => void sendTest()}
								>
									{busy === "test" ? "Sending…" : "Send test email"}
								</Button>
							) : buttonLabel && !loading ? (
								<Button
									size="sm"
									variant="outline"
									className="bg-white"
									disabled={busy !== null}
									onClick={() =>
										void domainAction(
											view?.registered && (!view.dnsManaged || view.missingDns === 0) ? "verify" : "setup",
										)
									}
								>
									{busy === "verify" ? "Checking…" : busy === "setup" ? "Working…" : buttonLabel}
								</Button>
							) : undefined
						}
					>
						{label}
					</StatusRow>
					{view?.productionAccess === false && (
						<StatusRow ok={false} title="SES sandbox" hint="Account-wide restriction">
							In the sandbox SES delivers only to verified addresses. Request production access in the SES console
							before sending to anyone else.
						</StatusRow>
					)}
				</ul>
			)}
			{view && view.registered && !view.verified && !view.dnsManaged && (
				<p className="text-xs text-neutral-500">
					Add these CNAME records where this domain&apos;s DNS is hosted, then check status.
				</p>
			)}
			{view && view.registered && !view.verified && view.dnsManaged && view.missingDns === 0 && (
				<p className="text-xs text-neutral-500">
					DNS changes can take a few minutes to propagate. Check again shortly.
				</p>
			)}
			{view && view.registered && !view.verified && view.records.length > 0 && (
				<ul className="space-y-1 text-xs text-neutral-600">
					{view.records.map((record) => (
						<li
							key={record.name}
							className="grid gap-1 rounded-lg bg-white px-3 py-2 sm:grid-cols-[4rem_minmax(8rem,18rem)_minmax(0,1fr)]"
						>
							<span className="font-medium">{record.type}</span>
							<span className="break-all">{record.name}</span>
							<span className="break-all">{record.value}</span>
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
