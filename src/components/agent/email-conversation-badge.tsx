import { Mail } from "lucide-react";

/** The small icon a conversation that came from an assistant-by-email request carries (spec §14). */
export function EmailConversationBadge({ from }: { from: string }) {
	return (
		<span className="inline-flex shrink-0 text-neutral-400" title={`Request by email from ${from}`}>
			<Mail size={13} aria-label={`Request by email from ${from}`} />
		</span>
	);
}
