import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";

type TextPreview = { url: string; content: string; error: string };

/**
 * The text of an attachment shown in the viewer, loaded once `enabled`. A file that is not stored yet is read
 * directly, because the page's connect-src does not allow fetching `blob:` URLs. `url` identifies the source, so a
 * result from an earlier attachment is never shown for a new one.
 */
export function useAttachmentText({ enabled, file, url }: { enabled: boolean; file: File | null; url: string }) {
	const [preview, setPreview] = useState<TextPreview | null>(null);

	useEffect(() => {
		if (!enabled || !url) return;
		let cancelled = false;
		const read = file
			? file.text()
			: authFetch(url).then((response) => {
					if (!response.ok) throw new Error("Could not load this attachment");
					return response.text();
				});

		read
			.then((content) => {
				if (!cancelled) setPreview({ url, content, error: "" });
			})
			.catch((error) => {
				if (cancelled) return;
				const message = error instanceof Error ? error.message : "Could not load this attachment";
				setPreview({ url, content: "", error: message });
			});

		return () => {
			cancelled = true;
		};
	}, [enabled, file, url]);

	const current = preview?.url === url ? preview : null;
	return { content: current?.content ?? "", error: current?.error ?? "" };
}
