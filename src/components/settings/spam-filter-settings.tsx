"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { Switch } from "@/components/ui/switch";
import { FormError, SettingRow } from "@/components/ui/page";

export function SpamFilterSettings() {
	const [enabled, setEnabled] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void authFetch("/api/settings/spam")
			.then(async (response) => {
				const data = (await response.json()) as { enabled?: boolean; error?: string };
				if (!response.ok) throw new Error(data.error ?? "Failed to load spam filter settings");
				setEnabled(data.enabled !== false);
			})
			.catch((nextError) =>
				setError(nextError instanceof Error ? nextError.message : "Failed to load spam filter settings"),
			)
			.finally(() => setLoading(false));
	}, []);

	async function updateEnabled(nextEnabled: boolean) {
		const previous = enabled;
		setEnabled(nextEnabled);
		setLoading(true);
		setError(null);
		try {
			const response = await authFetch("/api/settings/spam", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: nextEnabled }),
			});
			const data = (await response.json()) as { enabled?: boolean; error?: string };
			if (!response.ok) throw new Error(data.error ?? "Failed to update spam filter settings");
			setEnabled(data.enabled !== false);
		} catch (nextError) {
			setEnabled(previous);
			setError(nextError instanceof Error ? nextError.message : "Failed to update spam filter settings");
		} finally {
			setLoading(false);
		}
	}

	return (
		<SettingRow
			label="Spam filter"
			description="Analyze incoming messages locally and move high-confidence spam out of the inbox."
			control={
				<Switch
					checked={enabled}
					disabled={loading}
					onCheckedChange={(value) => void updateEnabled(value)}
					aria-label="Enable spam filter"
				/>
			}
		>
			{error && <FormError className="mt-2 px-4">{error}</FormError>}
		</SettingRow>
	);
}
