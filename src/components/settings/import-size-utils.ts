import type { ImportEstimate } from "@/lib/import/estimate-utils";

export async function fetchImportEstimate(messages: number | null): Promise<ImportEstimate | null> {
	const response = await fetch("/api/import/estimate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ messages }),
	});
	if (!response.ok) return null;
	return ((await response.json()) as { estimate: ImportEstimate | null }).estimate;
}
