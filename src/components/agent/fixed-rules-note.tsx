import { CHAT_FIXED_RULES, DRAFT_FIXED_RULES } from "@/lib/agent/fixed-rules-utils";

/** Kite's own rules, read-only, so a user sees what their instructions are added to and cannot replace. */
export function FixedRulesNote() {
	return (
		<details className="text-xs text-neutral-500">
			<summary className="cursor-pointer">What Kite always tells the AI</summary>
			<p className="mt-2">
				Your instructions are added after these rules and cannot replace them. Mail is always treated as data, never as
				instructions.
			</p>
			<p className="mt-2 font-medium text-neutral-700">Chat</p>
			<p className="mt-1 whitespace-pre-wrap">{CHAT_FIXED_RULES}</p>
			<p className="mt-2 font-medium text-neutral-700">Reply drafts</p>
			<p className="mt-1 whitespace-pre-wrap">{DRAFT_FIXED_RULES}</p>
		</details>
	);
}
