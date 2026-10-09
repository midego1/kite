"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AlertWebhookKindSetting } from "@/lib/alerts/alerts-types";
import type { AlertWebhookStatus } from "./types";
import {
	describeTestFailure,
	KIND_OPTIONS,
	kindLabel,
	loadAlertWebhook,
	removeAlertWebhook,
	saveAlertWebhook,
	sendTestAlert,
} from "./utils";

type Notice = { tone: "ok" | "error"; text: string };

function errorText(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export default function AlertsSettingsPage() {
	const [saved, setSaved] = useState<AlertWebhookStatus | null>(null);
	const [url, setUrl] = useState("");
	const [kind, setKind] = useState<AlertWebhookKindSetting>("auto");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<Notice | null>(null);

	useEffect(() => {
		let active = true;
		void loadAlertWebhook()
			.then((status) => {
				if (!active) return;
				setSaved(status);
				setKind(status.kind);
			})
			.catch((error) => {
				if (active) setNotice({ tone: "error", text: errorText(error, "Could not load the alert webhook") });
			});
		return () => {
			active = false;
		};
	}, []);

	async function run(action: () => Promise<Notice>) {
		setBusy(true);
		setNotice(null);
		try {
			setNotice(await action());
		} catch (error) {
			setNotice({ tone: "error", text: errorText(error, "Something went wrong") });
		} finally {
			setBusy(false);
		}
	}

	function save(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = url.trim();
		if (!trimmed && !saved?.configured) {
			setNotice({ tone: "error", text: "Enter a webhook URL first." });
			return;
		}
		void run(async () => {
			const status = await saveAlertWebhook(trimmed ? { url: trimmed, kind } : { kind });
			setSaved(status);
			setKind(status.kind);
			setUrl("");
			return { tone: "ok", text: "Webhook saved." };
		});
	}

	function remove() {
		void run(async () => {
			const status = await removeAlertWebhook();
			setSaved(status);
			setKind(status.kind);
			setUrl("");
			return { tone: "ok", text: "Webhook removed." };
		});
	}

	function test() {
		void run(async () => {
			const result = await sendTestAlert();
			if (result.ok) return { tone: "ok", text: "Test alert delivered." };
			return { tone: "error", text: describeTestFailure(result) };
		});
	}

	const loaded = saved !== null;
	const configured = saved?.configured ?? false;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">Alerts</h1>
				<p className="mt-2 text-sm text-neutral-500">
					Kite checks for failed backups, failed or stuck outbound mail and exhausted webhook retries every five
					minutes.
				</p>
			</div>
			<Card className="rounded-3xl border-0 bg-white p-6">
				<CardHeader className="py-0">
					<CardTitle>Email</CardTitle>
				</CardHeader>
				<CardContent className="pt-4">
					<p className="text-sm text-neutral-700">
						Email alerts go to the primary admin&apos;s recovery address, or to the sign-in address when none is set.
						Change it in{" "}
						<Link href="/settings/account" className="text-blue-700 underline underline-offset-2 hover:text-blue-800">
							account settings
						</Link>
						.
					</p>
				</CardContent>
			</Card>
			<Card className="rounded-3xl border-0 bg-white p-6">
				<CardHeader className="py-0">
					<CardTitle>Webhook</CardTitle>
				</CardHeader>
				<CardContent className="pt-4">
					<form onSubmit={save} className="space-y-5">
						<p className="text-sm text-neutral-500">
							Also send alerts to Slack, Discord, ntfy or any endpoint that accepts JSON. Both channels are tried
							independently.
						</p>
						<div className="space-y-2">
							<Label htmlFor="alert-webhook-url">Webhook URL</Label>
							<Input
								id="alert-webhook-url"
								type="url"
								inputMode="url"
								autoComplete="off"
								spellCheck={false}
								placeholder={configured ? "Enter a new URL to replace the saved one" : "https://…"}
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								disabled={!loaded || busy}
							/>
							{configured && saved?.maskedUrl && (
								<p className="text-sm text-neutral-700" data-testid="alert-webhook-mask">
									Saved: <span className="font-mono text-neutral-900">{saved.maskedUrl}</span>
								</p>
							)}
							{configured && !saved?.maskedUrl && (
								<p className="text-sm text-neutral-700">A webhook is saved but cannot be read. Save the URL again.</p>
							)}
						</div>
						<div className="space-y-2">
							<Label htmlFor="alert-webhook-kind">Format</Label>
							<select
								id="alert-webhook-kind"
								className="flex h-10 w-full max-w-60 rounded-md border border-neutral-200 bg-transparent px-3 text-sm text-neutral-900 shadow-sm shadow-neutral-200/50 focus-visible:border-blue-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
								value={kind}
								disabled={!loaded || busy}
								onChange={(event) => setKind(event.target.value as AlertWebhookKindSetting)}
							>
								{KIND_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
							{saved?.kind === "auto" && saved.effectiveKind && (
								<p className="text-sm text-neutral-500">Detected format: {kindLabel(saved.effectiveKind)}</p>
							)}
						</div>
						{notice && (
							<p
								role="status"
								className={
									notice.tone === "ok"
										? "rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800"
										: "rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700"
								}
							>
								{notice.text}
							</p>
						)}
						<div className="flex flex-wrap gap-2">
							<Button type="submit" disabled={!loaded || busy}>
								Save
							</Button>
							<Button type="button" variant="outline" onClick={test} disabled={!configured || busy}>
								Send test alert
							</Button>
							<Button type="button" variant="ghost" onClick={remove} disabled={!configured || busy}>
								Remove
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
