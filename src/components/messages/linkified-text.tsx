"use client";

import { useMemo } from "react";
import { splitLinkedText } from "@/lib/email/linkify-utils";

/**
 * Plain message text with its web and email addresses as links that open in a new tab. The split scans the whole
 * body, so it runs again only when the text changes, not on every render of the reader around it.
 */
export function LinkifiedText({ text }: { text: string }) {
	const parts = useMemo(() => splitLinkedText(text), [text]);
	return (
		<>
			{parts.map((part, index) =>
				typeof part === "string" ? (
					part
				) : (
					<a
						key={index}
						href={part.href}
						target="_blank"
						rel="noopener noreferrer nofollow"
						className="text-blue-600 underline hover:text-blue-700"
					>
						{part.text}
					</a>
				),
			)}
		</>
	);
}
