import { splitLinkedText } from "@/lib/email/linkify-utils";

/** Plain message text with its web and email addresses as links that open in a new tab. */
export function LinkifiedText({ text }: { text: string }) {
	return (
		<>
			{splitLinkedText(text).map((part, index) =>
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
