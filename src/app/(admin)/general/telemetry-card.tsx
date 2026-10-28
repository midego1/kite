"use client";

import { Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useTelemetryStatus } from "@/components/telemetry/use-telemetry-status";
import { TELEMETRY_DOCS_URL, telemetrySwitchOn } from "@/lib/telemetry/notice-utils";
import {
	DEFAULT_TELEMETRY_URL,
	TELEMETRY_FIELDS,
	TELEMETRY_PRIVACY_CONTACT,
	TELEMETRY_SUMMARY_URL,
} from "@/lib/telemetry/telemetry-utils";
import type { TelemetryErasure } from "@/lib/telemetry/types";
import { telemetryErasureText, telemetryStatusText } from "./utils";
const LINK = "text-blue-600 underline underline-offset-2";

function InstallId({ id }: { id: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="inline-flex flex-wrap items-center gap-2">
			<code data-telemetry-install-id>{id}</code>
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => void navigator.clipboard.writeText(id).then(() => setCopied(true))}
			>
				<Copy className="h-4 w-4" />
				{copied ? "Copied" : "Copy ID"}
			</Button>
		</span>
	);
}

/**
 * The owner's switch for the daily pseudonymous heartbeat. On by default once decided at setup, or from the
 * notice's start day; an explicit off stays off. `KITE_TELEMETRY=0` keeps it off.
 */
export function TelemetryCard() {
	const { query, save } = useTelemetryStatus();
	const status = query.data ?? null;
	const [erasure, setErasure] = useState<TelemetryErasure | null>(null);
	const [saveError, setSaveError] = useState("");
	const saving = save.isPending;
	const error = saveError || (query.error ? query.error.message : "");

	function change(enabled: boolean) {
		setSaveError("");
		save.mutate(
			{ enabled },
			{
				onSuccess: (result) => setErasure(result.erasure ?? null),
				onError: (failure) => setSaveError(failure.message || "Could not save usage statistics"),
			},
		);
	}

	// KITE_TELEMETRY=0 keeps statistics from being turned on, never from being turned off.
	const locked = !status || !status.available || (status.forcedOff && !status.enabled);
	const erasureText = telemetryErasureText(erasure);
	return (
		<Card data-telemetry>
			<CardHeader>
				<CardTitle>Usage statistics</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 pt-4 text-sm text-neutral-700">
				<div className="flex items-center gap-3">
					<Switch
						id="telemetry-enabled"
						checked={telemetrySwitchOn(status)}
						onCheckedChange={change}
						disabled={locked || saving}
					/>
					<label htmlFor="telemetry-enabled" className="font-medium text-neutral-900">
						Share pseudonymous usage statistics with the Kite project
					</label>
				</div>
				<p data-telemetry-status>{telemetryStatusText(status)}</p>
				{erasureText && (
					<p data-telemetry-erasure={erasure?.outcome}>
						{erasureText}
						{erasure?.outcome === "failed" && erasure.installId && (
							<>
								{" "}
								<InstallId id={erasure.installId} />
							</>
						)}
					</p>
				)}
				<p>
					On by default, and never turned back on automatically once you turn it off: a new install asks at setup, and
					an install that existed before starts only 14 days after a notice told its owner. Once a day, around 02:00
					UTC, Kite sends one small report with the fields below. The only purpose is to see how many active Kite
					installs there are, out of interest, and nothing else. Counts are sent as ranges, never exact numbers. The
					report is pseudonymous, not anonymous: a random install ID links one install’s daily reports. It never
					contains names, email addresses, domains, message content or anything else that identifies you or your users.
				</p>
				<p>
					The request itself can say more than the report. On Cloudflare Workers, Cloudflare adds a{" "}
					<code>CF-Worker</code> header naming this Worker’s zone (your domain or workers.dev subdomain), which Kite
					cannot remove; on Node/Docker the collector sees your server’s IP address. The collector does not log or store
					either, but Cloudflare’s own analytics for the collector’s zone may record a sample of IP addresses.
				</p>
				<div className="space-y-2 rounded-lg bg-neutral-50 p-4">
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
							Sent to <code>{status.endpoint}</code>.{" "}
							{status.endpoint === DEFAULT_TELEMETRY_URL ? (
								<>
									Run by the Kite project on Cloudflare (its processor), on the basis of the project’s legitimate
									interest in knowing how Kite is used, with notice and an easy opt-out. Daily reports are kept for 90
									days, then only totals without the install ID. Questions and data requests:{" "}
									<a href={`mailto:${TELEMETRY_PRIVACY_CONTACT}`} className={LINK}>
										{TELEMETRY_PRIVACY_CONTACT}
									</a>
									. The totals are public at{" "}
									<a href={TELEMETRY_SUMMARY_URL} target="_blank" rel="noreferrer" className={LINK}>
										{TELEMETRY_SUMMARY_URL}
									</a>
									.
								</>
							) : (
								"Set by KITE_TELEMETRY_URL on this deployment."
							)}
						</p>
					)}
					{status?.installId && (
						<p>
							This install’s ID is <InstallId id={status.installId} />. Turning statistics off deletes it here and asks
							the collector to erase this install’s reports; turning them on again makes a new one.
						</p>
					)}
					<p>
						Set <code>KITE_TELEMETRY=0</code> on the deployment to keep statistics from being turned on or sent; they
						can still be turned off here. Set <code>KITE_TELEMETRY_URL</code> to an empty value to send nothing.{" "}
						<a href={TELEMETRY_DOCS_URL} target="_blank" rel="noreferrer" className={LINK}>
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
