import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { AttachmentRisk } from "@/lib/email/attachment-risk-types";

/** What the viewer shows when the check itself fails: the download still waits for the box to be ticked. */
const UNCHECKED: AttachmentRisk = {
	level: "warning",
	reasons: ["Kite could not check this file. Download it only if you expected it."],
};

/**
 * The server's risk assessment of a stored attachment (`?risk=1` on its route), which also reads the names inside a
 * ZIP. `loading` is true until it answers; a download waits for it. A failed check counts as a warning rather than a
 * clean file. `url` null (a file that is not stored yet) means nothing to check.
 */
export function useAttachmentRisk(url: string | null): { risk: AttachmentRisk | null; loading: boolean } {
	const [result, setResult] = useState<{ url: string; risk: AttachmentRisk } | null>(null);

	useEffect(() => {
		if (!url) return;
		let cancelled = false;
		const separator = url.includes("?") ? "&" : "?";
		authFetch(`${url}${separator}risk=1`)
			.then(async (response) => (response.ok ? ((await response.json()) as AttachmentRisk) : UNCHECKED))
			.catch(() => UNCHECKED)
			.then((risk) => {
				if (!cancelled) setResult({ url, risk });
			});
		return () => {
			cancelled = true;
		};
	}, [url]);

	if (!url) return { risk: null, loading: false };
	const current = result && result.url === url ? result.risk : null;
	return { risk: current, loading: current === null };
}

/** `url` with `acknowledge=1`, for a download the user confirmed after seeing the warning. */
export function acknowledgedUrl(url: string): string {
	return `${url}${url.includes("?") ? "&" : "?"}acknowledge=1`;
}
