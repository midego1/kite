"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { KeyTestResults } from "@/lib/spam/providers/abuse-ch-types";
import { KEY_TEST_TEXT, lookupStatusText, testThreatLookupKey, THREAT_LOOKUP_SERVICES } from "./utils";

/** The key is a deployment secret, so nothing here can change it; the owner can only test it. */
export function ThreatLookupsCard({ configured }: { configured: boolean | null }) {
	const [testing, setTesting] = useState(false);
	const [results, setResults] = useState<KeyTestResults | null>(null);
	const [error, setError] = useState("");

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
					With a free abuse.ch Auth-Key in the <code>URLHAUS_AUTH_KEY</code> secret (or <code>ABUSE_CH_AUTH_KEY</code>),
					Kite checks incoming mail from people you have not saved or written to against URLhaus and ThreatFox, public
					lists of sites, servers and files that spread malware. A match adds to the spam score and shows a phishing
					warning.
				</p>
				<p>
					Kite asks only about mail that already looks risky, such as mail with an attached web page or program, a
					misleading link or failed sender checks. Attachments are sent as SHA-256 hashes, never as files. URLhaus gets
					links as they are, so they may carry personal details; ThreatFox gets only the names of the sites they lead
					to. A lookup that fails or takes longer than 3 seconds is skipped.
				</p>
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
