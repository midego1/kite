"use client";

import { useState } from "react";
import { ChevronLeft, Wrench } from "lucide-react";
import type { AgentEmailReference, AgentMessage, AgentTurnProps } from "./types";
import { agentActionProposal, agentToolLabel, draftFromToolContent, parseAgentToolContent } from "./utils";
import { AgentEmailLink } from "./email-link";
import type { AssistantDetailPreference } from "@/components/appearance-preferences";

function emailReferences(value: Record<string, unknown>): AgentEmailReference[] {
	if (Array.isArray(value.emails))
		return value.emails.filter(
			(item): item is AgentEmailReference => !!item && typeof item === "object" && typeof item.id === "string",
		);
	if (typeof value.id === "string" && typeof value.subject === "string") return [value as AgentEmailReference];
	return [];
}

const HIDDEN_RESULT_FIELDS = new Set([
	"emails",
	"text",
	"attachments",
	"result",
	"id",
	"subject",
	"from",
	"snippet",
	"url",
	"reviewUrl",
	"action",
	"status",
]);

function AgentToolResult({ result, detail }: { result: Record<string, unknown>; detail: AssistantDetailPreference }) {
	const emails = detail !== "minimal" ? emailReferences(result) : [];
	const full = detail === "full";
	return (
		<>
			{emails.length > 0 && (
				<ul className="space-y-1.5">
					{emails.map((email) => (
						<li key={email.id} className="break-words">
							<AgentEmailLink email={email} className="font-medium text-blue-700 hover:underline" />
							{email.from && <span className="text-neutral-500"> · {email.from}</span>}
							{email.snippet && <p className="line-clamp-2 text-neutral-500">{email.snippet}</p>}
						</li>
					))}
				</ul>
			)}
			{emails.length > 0 && typeof result.omittedEmails === "number" && result.omittedEmails > 0 && (
				<p className="text-neutral-500">And {result.omittedEmails} more not kept in the chat history.</p>
			)}
			{full &&
				Object.entries(result)
					.filter(([key, value]) => !HIDDEN_RESULT_FIELDS.has(key) && value !== null && typeof value !== "object")
					.map(([key, value]) => (
						<p key={key} className="break-words">
							<span className="text-neutral-400">{key.replace(/([A-Z])/g, " $1")}: </span>
							{String(value)}
						</p>
					))}
			{full && typeof result.text === "string" && (
				<p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words">{result.text}</p>
			)}
			{detail !== "minimal" && Array.isArray(result.attachments) && result.attachments.length > 0 && (
				<p>
					Attachments:{" "}
					{result.attachments.map((file: { filename?: string }) => file.filename || "attachment").join(", ")}
				</p>
			)}
		</>
	);
}

export function AgentToolActivity({
	item,
	forceOpen,
	detail = "emails",
}: {
	item: AgentMessage;
	forceOpen: boolean;
	detail?: AssistantDetailPreference;
}) {
	const [open, setOpen] = useState(forceOpen);
	const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
	if (forceOpen !== prevForceOpen) {
		setPrevForceOpen(forceOpen);
		setOpen(forceOpen);
	}
	const display = agentToolLabel(item.toolName, item.toolState, item.content);
	const result = parseAgentToolContent(item.content);
	return (
		<details
			className="group/tool text-xs text-neutral-600"
			open={forceOpen || open}
			onToggle={(event) => {
				if (!forceOpen) setOpen(event.currentTarget.open);
			}}
		>
			<summary className="flex w-full max-w-full cursor-pointer list-none items-center gap-1.5 text-sm text-neutral-500 [&::-webkit-details-marker]:hidden">
				<Wrench size={13} className="shrink-0 text-neutral-400" aria-hidden="true" />
				<span className="truncate flex-1 min-w-0">{display.label}</span>
				<ChevronLeft
					size={13}
					className="shrink-0 text-neutral-400 transition-transform group-open/tool:-rotate-90"
					aria-hidden="true"
				/>
			</summary>
			<div className="mt-1.5 space-y-2 pl-[18px] text-neutral-600">
				<p>{display.description}</p>
				{result && <AgentToolResult result={result} detail={detail} />}
				{!result && item.content && <p className="whitespace-pre-wrap break-words">{item.content}</p>}
			</div>
		</details>
	);
}

export function AgentPendingActions({
	item,
	onApproveAction,
	approvingId,
}: Pick<AgentTurnProps, "onApproveAction" | "approvingId"> & { item: AgentMessage }) {
	const proposal = agentActionProposal(item.content);
	if (proposal?.status !== "pending_approval" || draftFromToolContent(item.content)) return null;
	return (
		<div className="space-y-2 text-xs">
			{proposal.emails && (
				<ul className="space-y-1">
					{proposal.emails.map((email) => (
						<li key={email.id}>
							<AgentEmailLink email={email} className="text-blue-700 hover:underline" />
						</li>
					))}
				</ul>
			)}
			<div className="flex flex-wrap items-center justify-end gap-3">
				<button
					type="button"
					className="rounded-lg bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-50"
					disabled={!item.recordId || approvingId === item.id}
					onClick={() => onApproveAction(item)}
				>
					{approvingId === item.id
						? "Approving…"
						: proposal.action === "discard_draft"
							? "Approve discard"
							: proposal.action === "mark_email_read"
								? "Approve status change"
								: `Approve move to ${proposal.destination}`}
				</button>
			</div>
		</div>
	);
}
