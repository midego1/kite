import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Read-only: the URLhaus key is a deployment secret, so nothing here can change it. */
export function ThreatLookupsCard({ configured }: { configured: boolean | null }) {
	return (
		<Card data-threat-lookups className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<CardTitle>Threat lookups</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 pt-6 text-sm text-neutral-700">
				<p data-urlhaus-status className="font-medium text-neutral-900">
					{configured === null ? "Checking…" : configured ? "URLhaus lookups are on" : "URLhaus lookups are off"}
				</p>
				<p>
					With a free abuse.ch Auth-Key in the <code>URLHAUS_AUTH_KEY</code> secret, Kite checks incoming mail from
					people you have not saved or written to against URLhaus, a public list of sites and files that spread malware.
					A match adds to the spam score and shows a phishing warning.
				</p>
				<p>
					Kite asks only about mail that already looks risky, such as mail with an attached web page or program, a
					misleading link or failed sender checks. Attachments are sent as SHA-256 hashes, never as files; links are
					sent as they are, so they may carry personal details. A lookup that fails or takes longer than 3 seconds is
					skipped.
				</p>
			</CardContent>
		</Card>
	);
}
