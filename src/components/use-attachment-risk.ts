import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { AttachmentRisk } from "@/lib/email/attachment-risk-types";

/**
 * The server's risk assessment of a stored attachment (`?risk=1` on its route), which also reads the names inside a
 * ZIP. Null while loading, for a file that is not stored yet (`url` null) and when the check fails; the server still
 * refuses an unacknowledged download of a flagged file then.
 */
export function useAttachmentRisk(url: string | null): AttachmentRisk | null {
	const [result, setResult] = useState<{ url: string; risk: AttachmentRisk } | null>(null);

	useEffect(() => {
		if (!url) return;
		let cancelled = false;
		const separator = url.includes("?") ? "&" : "?";
		authFetch(`${url}${separator}risk=1`)
			.then(async (response) => (response.ok ? ((await response.json()) as AttachmentRisk) : null))
			.then((risk) => {
				if (!cancelled && risk) setResult({ url, risk });
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [url]);

	return result && result.url === url ? result.risk : null;
}

/** `url` with `acknowledge=1`, for a download the user confirmed after seeing the warning. */
export function acknowledgedUrl(url: string): string {
	return `${url}${url.includes("?") ? "&" : "?"}acknowledge=1`;
}
