"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TELEMETRY_DOCS_URL, TELEMETRY_PURPOSE, usageStatisticsSetupHint } from "@/lib/telemetry/notice-utils";
import { DEFAULT_TELEMETRY_URL, TELEMETRY_FIELDS, TELEMETRY_PRIVACY_CONTACT } from "@/lib/telemetry/telemetry-utils";
import type { SetupTelemetryStatus } from "@/lib/telemetry/types";

const LINK = "text-blue-600 underline underline-offset-2";

/**
 * The first-run setup's "Usage statistics" section: what is sent, how often, to whom and for how long, with the
 * switch on by default. Nothing is recorded or sent until the account is created with it.
 */
export function UsageStatisticsSetup({
	status,
	checked,
	onCheckedChange,
	disabled,
}: {
	status: SetupTelemetryStatus | undefined;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
}) {
	const forcedOff = Boolean(status?.forcedOff);
	const endpoint = status?.endpoint ?? null;
	return (
		<section
			aria-labelledby="setup-usage-statistics-title"
			data-setup-telemetry
			className="space-y-3 rounded-2xl bg-neutral-50 px-4 py-4 text-xs leading-5 text-neutral-600"
		>
			<h2 id="setup-usage-statistics-title" className="text-sm font-medium text-neutral-900">
				Usage statistics
			</h2>
			<p>
				Kite sends one small pseudonymous report a day, around 02:00 UTC, {TELEMETRY_PURPOSE}. It is on unless you turn
				it off here, and you can change it later under Admin → General. Nothing is sent before you finish setup.
			</p>
			<p>
				The report holds rough counts only (ranges, never exact numbers) and no names, email addresses, domains or
				message content. It is pseudonymous, not anonymous: a random install ID links one install’s daily reports. On
				Cloudflare Workers, Cloudflare adds a <code>CF-Worker</code> header naming this Worker’s domain; on Node/Docker
				the collector sees your server’s IP address. The collector does not store IP addresses.
			</p>
			<details>
				<summary className="cursor-pointer font-medium text-neutral-800">Exactly what is sent</summary>
				<ul className="mt-2 space-y-1">
					{TELEMETRY_FIELDS.map(({ key, description }) => (
						<li key={key}>
							<code>{key}</code>: {description}
						</li>
					))}
				</ul>
			</details>
			<p>
				{endpoint === null || endpoint === DEFAULT_TELEMETRY_URL ? (
					<>
						Reports go to <code>kite-telemetry.midego.net</code>, run by the Kite project. Daily reports are kept for 90
						days, then only totals without the install ID. Questions and data requests:{" "}
						<a href={`mailto:${TELEMETRY_PRIVACY_CONTACT}`} className={LINK}>
							{TELEMETRY_PRIVACY_CONTACT}
						</a>
						.{" "}
					</>
				) : (
					<>
						Reports go to <code>{endpoint}</code>, set by <code>KITE_TELEMETRY_URL</code> on this deployment.{" "}
					</>
				)}
				<a href={TELEMETRY_DOCS_URL} target="_blank" rel="noreferrer" className={LINK}>
					Read the privacy page
				</a>
			</p>
			<div className="flex items-center justify-between gap-4">
				<div>
					<Label htmlFor="setup-usage-statistics">Send usage statistics</Label>
					<p data-setup-telemetry-hint className="mt-1">
						{usageStatisticsSetupHint({ forcedOff, endpoint, checked })}
					</p>
				</div>
				<Switch
					id="setup-usage-statistics"
					checked={checked && !forcedOff}
					onCheckedChange={onCheckedChange}
					disabled={disabled || forcedOff}
				/>
			</div>
		</section>
	);
}
