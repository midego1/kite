import { Mail } from "lucide-react";
import { KiteAvatar } from "./kite-avatar";
import type { ChatWelcomeProps } from "./chat-welcome-types";

export function ChatContext({ selectedMessageId }: Pick<ChatWelcomeProps, "selectedMessageId">) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-b border-blue-100/60 px-4 py-2.5 text-xs text-blue-800">
			<Mail size={14} aria-hidden="true" />
			<span>{selectedMessageId ? "Current thread" : "Your mailbox"}</span>
		</div>
	);
}

export function ChatWelcome({ selectedMessageId, prompts, disabled, busy, onSubmit }: ChatWelcomeProps) {
	return (
		<div className="flex items-start gap-2.5">
			<KiteAvatar className="mt-0.5" />
			<div className="min-w-0 flex-1 rounded-xl rounded-tl-sm bg-blue-50/70 p-3">
				<p className="agent-welcome-heading text-sm leading-relaxed text-neutral-800">
					{selectedMessageId ? "I can help with this conversation." : "How can I help with your inbox?"}
				</p>
				<div className="mt-2.5 flex flex-wrap gap-2">
					{prompts.map((item) => (
						<button
							key={item.label}
							type="button"
							className="agent-welcome-prompt rounded-full border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
							disabled={disabled || busy}
							onClick={() => onSubmit(item.prompt)}
							title={item.detail}
						>
							{item.label}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
