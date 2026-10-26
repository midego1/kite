"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import { TELEMETRY_FIELDS } from "@/lib/telemetry/telemetry-utils";
import type { TelemetryStatus } from "@/lib/telemetry/types";
import { loadTelemetryStatus, saveTelemetryEnabled, telemetryStatusText } from "./utils";

const DOCS_URL = `${SOURCE_CODE_URL}/blob/main/docs/privacy.md#usage-statistics-opt-in`;

/** The owner's opt-in for the daily anonymous heartbeat. Off by default; `KITE_TELEMETRY=0` locks it off. */
export function TelemetryCard() {
	const [status, setStatus] = useState<TelemetryStatus | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		void loadTelemetryStatus()
			.then((next) => {
				if (active) setStatus(next);
			})
			.catch((failure) => {
				if (active) setError(failure instanceof Error ? failure.message : "Could not load usage statistics");
			});
		return () => {
			active = false;
		};
	}, []);

	async function change(enabled: boolean) {
		setSaving(true);
		setError("");
		try {
			setStatus(await saveTelemetryEnabled(enabled));
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not save usage statistics");
		} finally {
			setSaving(false);
		}
	}

	const locked = !status || !status.available || status.forcedOff;
	return (
		<Card data-telemetry className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<CardTitle>Anonymous usage statistics</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 pt-6 text-sm text-neutral-700">
				<div className="flex items-center gap-3">
					<Switch
						id="telemetry-enabled"
						checked={Boolean(status?.enabled) && !status?.forcedOff}
						onCheckedChange={(enabled) => void change(enabled)}
						disabled={locked || saving}
					/>
					<label htmlFor="telemetry-enabled" className="font-medium text-neutral-900">
						Share anonymous usage statistics with the Kite project
					</label>
				</div>
				<p data-telemetry-status>{telemetryStatusText(status)}</p>
				<p>
					Off unless you turn it on. Once a day, around 02:00 UTC, Kite then sends one small report with the counts
					below, so the project can see how many installs are in use. It never contains names, email addresses, domains,
					message content or anything else that identifies you or your users. On Cloudflare Workers, Cloudflare adds a{" "}
					<code>CF-Worker</code> header naming this Worker’s zone (your domain or workers.dev subdomain) to the request;
					the collector does not read, log or store it, nor the IP address the report comes from.
				</p>
				<div className="space-y-2 rounded-xl bg-neutral-50 p-4">
					<p className="font-medium text-neutral-900">Exactly what is sent</p>
					<ul className="space-y-1">
						{TELEMETRY_FIELDS.map(({ key, description }) => (
							<li key={key}>
								<code>{key}</code>: {description}
							</li>
						))}
					</ul>
					{status?.endpoint && (
						<p>
							Sent to <code>{status.endpoint}</code>.
						</p>
					)}
					{status?.installId && (
						<p>
							This install’s ID is <code>{status.installId}</code>. Turning statistics off deletes it; turning them on
							again makes a new one.
						</p>
					)}
					<p>
						Set <code>KITE_TELEMETRY=0</code> on the deployment to keep statistics off whatever is chosen here.{" "}
						<a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-blue-600 underline underline-offset-2">
							Read more about usage statistics
						</a>
					</p>
				</div>
				{error && (
					<p role="alert" className="text-red-600">
						{error}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
