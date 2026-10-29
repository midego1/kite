"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { CalendarClock, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import type { Message } from "@/hooks/types";
import { formatSendTime, getMessageSendLabel } from "./send-state-utils";

/** Takes the queued or failed message back into the author's Drafts; null when the server refused. */
async function takeBackSend(messageId: string): Promise<string | null> {
	const response = await authFetch("/api/send/undo", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ messageId }),
	});
	const data = (await response.json().catch(() => ({}))) as { draftId?: string; error?: string };
	if (!response.ok || !data.draftId) {
		toast.error(data.error ?? "Could not cancel the send");
		return null;
	}
	window.dispatchEvent(new Event("kite:messages-changed"));
	return data.draftId;
}

/**
 * Reader banner for a message that is still waiting to go out or failed to: when it goes out and, for its author,
 * Cancel send (back into Drafts, private again) and Edit (the same, opened in the composer).
 */
export function SendStateBanner({
	message,
	alignWide,
}: {
	message: Pick<Message, "id" | "sendState" | "createdAt">;
	alignWide: boolean;
}) {
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const state = message.sendState;
	const label = getMessageSendLabel(message);
	if (!state || !label) return null;
	const failed = state.status === "failed";

	async function takeBack(openDraft: boolean) {
		setPending(true);
		const draftId = await takeBackSend(message.id);
		setPending(false);
		if (!draftId) return;
		if (openDraft) {
			router.push(`/drafts/${draftId}`);
			return;
		}
		toast.success(failed ? "Moved to Drafts" : "Send cancelled. The message is back in Drafts.");
		router.push("/sent");
	}

	const Icon = failed ? CircleAlert : CalendarClock;
	let text: string;
	if (failed) text = state.error ? `This message was not sent: ${state.error}` : "This message was not sent.";
	else if (label.kind === "sending") text = "This message is being sent.";
	else text = `This message is scheduled to be sent on ${formatSendTime(state.scheduledAt!)}.`;

	return (
		<div className={alignWide ? "px-3 sm:px-6 sm:pl-16" : "px-3 sm:px-6 sm:pl-10"}>
			<div
				role="region"
				aria-label={failed ? "Send failed" : label.kind === "sending" ? "Sending" : "Scheduled send"}
				className={
					failed
						? "my-2 flex flex-wrap items-center gap-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-neutral-800"
						: "my-2 flex flex-wrap items-center gap-3 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-neutral-800"
				}
			>
				<Icon
					className={failed ? "h-4 w-4 shrink-0 text-red-700" : "h-4 w-4 shrink-0 text-blue-700"}
					aria-hidden="true"
				/>
				<p className="min-w-0 flex-1">{text}</p>
				{state.own && (
					<div className="flex gap-2">
						<Button type="button" size="sm" disabled={pending} onClick={() => void takeBack(true)}>
							{failed ? "Edit and resend" : "Edit"}
						</Button>
						<Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void takeBack(false)}>
							{failed ? "Move to Drafts" : "Cancel send"}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
