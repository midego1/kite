"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/auth/client";

type SpamPolicy = { strictDmarc: boolean; migrationPending: boolean };

const QUERY_KEY = ["admin", "spam-policy"];

async function readPolicy(response: Response): Promise<SpamPolicy> {
	const data = (await response.json().catch(() => ({}))) as SpamPolicy & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not load the sender authentication setting");
	return data;
}

/** **Treat every DMARC failure as spam**: the owner's switch for how strictly failed sender checks count. */
export function SenderAuthenticationCard() {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const { data } = useQuery({
		queryKey: QUERY_KEY,
		queryFn: async () => readPolicy(await authFetch("/api/admin/spam-policy", { cache: "no-store" })),
		refetchOnWindowFocus: false,
	});

	async function change(strictDmarc: boolean) {
		setSaving(true);
		setError(null);
		try {
			const response = await authFetch("/api/admin/spam-policy", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ strictDmarc }),
			});
			queryClient.setQueryData(QUERY_KEY, await readPolicy(response));
		} catch (changeError) {
			setError(changeError instanceof Error ? changeError.message : "Could not save");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card data-sender-authentication>
			<CardHeader>
				<CardTitle>Sender authentication</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3 pt-4 text-sm text-neutral-700">
				<div className="flex items-center gap-3">
					<Switch
						id="strict-dmarc"
						checked={!!data?.strictDmarc}
						onCheckedChange={(strictDmarc) => void change(strictDmarc)}
						disabled={!data || saving || data.migrationPending}
					/>
					<label htmlFor="strict-dmarc" className="font-medium text-neutral-900">
						Treat every DMARC failure as spam
					</label>
				</div>
				{data?.migrationPending && <p>Apply the pending database update to change this setting.</p>}
				<p>
					Mail that fails DMARC from a domain asking receivers to reject or quarantine such mail always goes to Spam,
					even from people you know, and so does mail failing both SPF and DKIM. A failure from a domain that only
					monitors (<code>p=none</code>) adds to the spam score instead, because forwarding and mailing lists often
					break DMARC for genuine mail.
				</p>
				<p>Turn this on to send every DMARC failure to Spam, whatever the sender’s domain asks for.</p>
				{error && (
					<p role="alert" className="text-red-600">
						{error}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
