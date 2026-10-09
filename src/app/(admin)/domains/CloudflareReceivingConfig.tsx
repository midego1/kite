"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { runReceivingSetup } from "./api";
import { StatusRow } from "./status-row";

type Props = {
	domainId: string;
	routingOk: boolean;
	routingLabel: string;
	manual: boolean;
	onChanged?: () => void;
};

/** Email Routing status for the zone, with a setup that also deals with conflicting MX records. */
export default function CloudflareReceivingConfig({ domainId, routingOk, routingLabel, manual, onChanged }: Props) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function setup() {
		setBusy(true);
		setError("");
		try {
			if (await runReceivingSetup(domainId, "cloudflare")) onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Setup failed");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-2">
			<ul className="space-y-2">
				<StatusRow
					ok={routingOk}
					title="Email Routing"
					hint="Routes incoming email to Kite"
					action={
						!routingOk ? (
							<Button
								size="sm"
								variant="outline"
								className="bg-white"
								disabled={busy || manual}
								title={manual ? "DNS for this domain is managed manually" : undefined}
								onClick={() => void setup()}
							>
								{busy ? "Setting up…" : "Setup"}
							</Button>
						) : undefined
					}
				>
					{routingLabel}
				</StatusRow>
			</ul>
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}
