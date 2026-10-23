"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AbuseChKeyStatus, KeyTestResults } from "@/lib/spam/providers/abuse-ch-types";
import { ThreatLookupsKeyForm } from "./threat-lookups-key-form";
import { KEY_TEST_TEXT, keyStatusText, lookupStatusText, testThreatLookupKey, THREAT_LOOKUP_SERVICES } from "./utils";

type Props = {
	status: AbuseChKeyStatus | null;
	onStatusChange: (status: AbuseChKeyStatus) => void;
};

/** The owner saves the key here, unless a deployment secret sets it; either way it can be tested. */
export function ThreatLookupsCard({ status, onStatusChange }: Props) {
	const [testing, setTesting] = useState(false);
	const [results, setResults] = useState<KeyTestResults | null>(null);
	const [error, setError] = useState("");
	const configured = status ? status.source !== null : null;

	async function test() {
		setTesting(true);
		setError("");
		setResults(null);
		try {
			setResults(await testThreatLookupKey());
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not test the key");
		} finally {
			setTesting(false);
		}
	}

	function changeStatus(next: AbuseChKeyStatus) {
		setResults(null);
		setError("");
		onStatusChange(next);
	}

	return (
		<Card data-threat-lookups className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<CardTitle>Threat lookups</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 pt-6 text-sm text-neutral-700">
				<ul className="space-y-1">
					{THREAT_LOOKUP_SERVICES.map(({ service, name }) => (
						<li key={service} className="font-medium text-neutral-900" data-lookup-status={service}>
							{lookupStatusText(name, configured)}
						</li>
					))}
				</ul>
				<p>
					With a free abuse.ch Auth-Key, Kite checks incoming mail from people you have not saved or written to against
					URLhaus and ThreatFox, public lists of sites, servers and files that spread malware. A match adds to the spam
					score and shows a phishing warning.
				</p>
				<p>
					Kite asks only about mail that already looks risky, such as mail with an attached web page or program, a
					misleading link or failed sender checks. Attachments are sent as SHA-256 hashes, never as files. URLhaus gets
					links as they are, so they may carry personal details; ThreatFox gets only the names of the sites they lead
					to. A lookup that fails or takes longer than 3 seconds is skipped.
				</p>
				<div className="space-y-2 rounded-xl bg-neutral-50 p-4">
					<p className="font-medium text-neutral-900" data-key-source={status?.source ?? "none"}>
						{keyStatusText(status)}
					</p>
					{status?.source === "secret" ? (
						<p>
							The <code>{status.secretName}</code> secret takes precedence over a key saved in Kite. To manage the key
							here, remove the secret.
						</p>
					) : (
						<p>
							Enter the key here, or set it as the <code>URLHAUS_AUTH_KEY</code> secret (or{" "}
							<code>ABUSE_CH_AUTH_KEY</code>), which takes precedence. A saved key is never shown again, and is
							encrypted when APP_ENCRYPTION_KEY is set.
						</p>
					)}
					{status && status.source !== "secret" && (
						<ThreatLookupsKeyForm status={status} onStatusChange={changeStatus} />
					)}
					<p>
						Get a free key at{" "}
						<a
							href="https://auth.abuse.ch/"
							target="_blank"
							rel="noreferrer"
							className="text-blue-600 underline underline-offset-2"
						>
							https://auth.abuse.ch/
						</a>
						. The free abuse.ch API is for non-commercial use; commercial use needs a Spamhaus subscription.
					</p>
				</div>
				{configured && (
					<div className="space-y-2">
						<Button type="button" size="sm" variant="outline" disabled={testing} onClick={() => void test()}>
							{testing ? "Testing…" : "Test key"}
						</Button>
						{results && (
							<ul role="status" className="space-y-1" data-key-test>
								{THREAT_LOOKUP_SERVICES.map(({ service, name }) => (
									<li key={service} data-service={service} data-result={results[service]}>
										{name}: {KEY_TEST_TEXT[results[service]]}
									</li>
								))}
							</ul>
						)}
						{error && (
							<p role="alert" className="text-red-600">
								{error}
							</p>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
