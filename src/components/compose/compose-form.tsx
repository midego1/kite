"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ChevronUp, FileText, Forward, Maximize2, Minimize2, Minus, Paperclip, Reply, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { authFetch } from "@/lib/auth/client";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import { cn } from "@/lib/utils";
import { SendReview } from "@/components/agent/send-review";
import type { ReviewSnapshot } from "@/components/agent/send-review-types";
import { buildSendFormData, fetchDraft, formatAttachmentSize } from "./utils";
import { SendPreview } from "./send-preview";
import { composeFrameAria, composeFrameClass, useComposerBesideAssistant, useDraftBodyFocus } from "./compose-frame";
import { ComposeToast, type ComposeToastState } from "./compose-toast";
import { SendingBar, UndoSendBar } from "./undo-send-bar";
import { useSendingSettings } from "./use-sending-settings";
import type { PendingUndoSend, PendingUndoSnapshot } from "./undo-send-types";
import { RecipientInput } from "./recipient-input";
import { RichTextEditor } from "./rich-text-editor";
import { ScheduleSendMenu } from "./schedule-send-menu";
import {
	applyMailboxSignatureHtml,
	hasMeaningfulHtml,
	htmlToPlainText,
	joinQuotedHtml,
	splitStoredDraftHtml,
} from "./rich-text-utils";
import { headerToRecipients, isValidRecipient, recipientsToHeader } from "./recipient-utils";
import { hasDraftContent, withoutAttachmentIds } from "./draft-autosave-utils";
import { useDraftAutosave } from "./use-draft-autosave";
import { PAST_SCHEDULE_MESSAGE, isPastScheduledSend } from "@/lib/email/undo-send-utils";
import type { ComposeAttachment, ComposeDraftSnapshot, ComposeStoredAttachment, ComposeThreading } from "./types";
import type { ComposeAttachmentPolicy } from "./attachment-policy-types";

export function ComposeForm({
	mode = "page",
	draftIdToLoad,
	onClose,
}: {
	mode?: "page" | "popup";
	draftIdToLoad?: string | null;
	onClose?: () => void;
}) {
	const router = useRouter();
	const { selectedMailbox, setSelectedMailbox, mailboxes } = useSelectedMailbox();
	const [draftId, setDraftId] = useState<string | null>(null);
	const [agentRevision, setAgentRevision] = useState<number | null>(null);
	const [agentReview, setAgentReview] = useState<{ approvalId: string; snapshot: ReviewSnapshot } | null>(null);
	const [to, setTo] = useState<string[]>([]);
	const [cc, setCc] = useState<string[]>([]);
	const [bcc, setBcc] = useState<string[]>([]);
	const [showCc, setShowCc] = useState(false);
	const [showBcc, setShowBcc] = useState(false);
	const [threading, setThreading] = useState<ComposeThreading | null>(null);
	const [subject, setSubject] = useState("");
	// The body is HTML; quoted/forwarded content is kept aside and folded.
	const [html, setHtml] = useState("");
	const [quotedHtml, setQuotedHtml] = useState<string | null>(null);
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	// Attachments the draft holds server-side: a forwarded message's files and those the autosave stored.
	const [storedAttachments, setStoredAttachments] = useState<ComposeStoredAttachment[]>([]);
	const [attachmentPolicy, setAttachmentPolicy] = useState<ComposeAttachmentPolicy>({
		maxMb: 25,
		cloudThresholdBytes: 3_000_000,
	});
	const [draggingFiles, setDraggingFiles] = useState(false);
	const [modalMode, setModalMode] = useState(false);
	const [minimized, setMinimized] = useState(false);
	const besideAssistant = useComposerBesideAssistant({ mode, minimized, modalMode }, setMinimized);
	const [toast, setToast] = useState<ComposeToastState>(null);
	const [loading, setLoading] = useState(false);
	const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
	const loadingDraft = !!draftIdToLoad && loadedDraftId !== draftIdToLoad;
	const formRef = useDraftBodyFocus(draftIdToLoad, loadingDraft);
	const [deletingDraft, setDeletingDraft] = useState(false);
	const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
	const [scheduleInvalid, setScheduleInvalid] = useState(false);
	const [loadedDraftMailboxId, setLoadedDraftMailboxId] = useState<string | null>(null);
	const [loadedDraftFrom, setLoadedDraftFrom] = useState<string | null>(null);
	const [chosenFrom, setSelectedFrom] = useState("");
	const { settings: sendingSettings } = useSendingSettings();
	const [previewOpen, setPreviewOpen] = useState(false);
	const [pendingUndo, setPendingUndo] = useState<PendingUndoSend | null>(null);
	const [sending, setSending] = useState<{ undoable: boolean } | null>(null);
	const [undoRequestedWhileSending, setUndoRequestedWhileSending] = useState(false);
	const undoRequested = useRef(false);
	const attachmentInput = useRef<HTMLInputElement | null>(null);
	const fileDragDepth = useRef(0);
	const previousSignature = useRef("");

	useEffect(() => {
		if (!selectedMailbox && mailboxes.length === 1) setSelectedMailbox(mailboxes[0]);
	}, [mailboxes, selectedMailbox, setSelectedMailbox]);

	useEffect(() => {
		let active = true;
		void authFetch("/api/attachment-policy", { cache: "no-store" })
			.then(async (response) => {
				if (response.ok && active) setAttachmentPolicy((await response.json()) as ComposeAttachmentPolicy);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, []);

	const senderAddresses = useMemo(() => {
		if (!selectedMailbox) return [];
		return selectedMailbox.senderAddresses?.length
			? selectedMailbox.senderAddresses
			: [`${selectedMailbox.localPart}@${selectedMailbox.hostname}`];
	}, [selectedMailbox]);
	const senderOptions = useMemo(
		() =>
			mailboxes.flatMap((mailbox) => {
				const addresses = mailbox.senderAddresses?.length
					? mailbox.senderAddresses
					: [`${mailbox.localPart}@${mailbox.hostname}`];
				return addresses.map((address) => ({ mailbox, address }));
			}),
		[mailboxes],
	);
	// A loaded draft's From wins whenever it or the available addresses change.
	const loadedDraftFromChanged = useKeyChanged(loadedDraftFrom);
	const senderAddressesChanged = useKeyChanged(senderAddresses);
	if (
		(loadedDraftFromChanged || senderAddressesChanged) &&
		loadedDraftFrom &&
		senderAddresses.includes(loadedDraftFrom) &&
		chosenFrom !== loadedDraftFrom
	) {
		setSelectedFrom(loadedDraftFrom);
	}
	const selectedFrom = senderAddresses.includes(chosenFrom) ? chosenFrom : (senderAddresses[0] ?? "");
	const fromAddr = selectedMailbox && selectedFrom ? formatEmailAddress(selectedFrom, selectedMailbox.displayName) : "";

	const draftSnapshot = useMemo((): ComposeDraftSnapshot | null => {
		const content = {
			recipients: to.length + cc.length + bcc.length,
			subject,
			quotedHtml,
			attachments: attachments.length,
			bodyText: htmlToPlainText(html),
			signature: selectedMailbox?.signature,
		};
		if (!fromAddr || loadingDraft || !hasDraftContent(content)) return null;
		const fullHtml = joinQuotedHtml(html, quotedHtml);
		return {
			payload: {
				mailboxId: selectedMailbox?.id,
				from: fromAddr,
				to: recipientsToHeader(to),
				cc: recipientsToHeader(cc),
				bcc: recipientsToHeader(bcc),
				subject,
				html: fullHtml,
				text: htmlToPlainText(fullHtml),
				inReplyTo: threading?.inReplyTo ?? null,
				references: threading?.references ?? null,
				threadId: threading?.threadId ?? null,
			},
			attachments,
			storeAttachments: agentRevision === null,
		};
	}, [
		agentRevision,
		attachments,
		bcc,
		cc,
		fromAddr,
		html,
		loadingDraft,
		quotedHtml,
		selectedMailbox?.id,
		selectedMailbox?.signature,
		subject,
		threading,
		to,
	]);
	const { draftSaves, storedUploads, cancelPendingSave } = useDraftAutosave(draftSnapshot, {
		setDraftId,
		setAttachments,
		setStoredAttachments,
		reportError: setToast,
	});

	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), 3200);
		return () => clearTimeout(timer);
	}, [toast]);

	useEffect(() => {
		if (!draftIdToLoad) return;

		let cancelled = false;
		fetchDraft(draftIdToLoad)
			.then((draft) => {
				if (cancelled) return;

				draftSaves.reset(draft.id);
				setDraftId(draft.id);
				setAgentRevision(draft.agent?.revision ?? null);
				setScheduledAt(draft.agent?.scheduledAt ? new Date(draft.agent.scheduledAt) : null);
				setTo(headerToRecipients(draft.toAddr));
				const draftCc = headerToRecipients(draft.ccAddr);
				const draftBcc = headerToRecipients(draft.bccAddr);
				setCc(draftCc);
				setBcc(draftBcc);
				setShowCc(draftCc.length > 0);
				setShowBcc(draftBcc.length > 0);
				setThreading(
					draft.inReplyTo || draft.threadId
						? {
								inReplyTo: draft.inReplyTo ?? null,
								references: draft.references ?? null,
								threadId: draft.threadId ?? null,
							}
						: null,
				);
				setSubject(draft.subject ?? "");
				const stored = splitStoredDraftHtml(draft.htmlBody, draft.textBody);
				setHtml(stored.body);
				setQuotedHtml(stored.quoted);
				setStoredAttachments(draft.attachments?.filter((item) => item.disposition === "attachment") ?? []);
				setLoadedDraftMailboxId(draft.mailboxId);
				setLoadedDraftFrom(getEmailAddress(draft.fromAddr).toLowerCase());
			})
			.catch((err) => {
				if (cancelled) return;
				const message = err instanceof Error ? err.message : "Failed to load draft";
				setToast({ type: "error", message });
			})
			.finally(() => {
				if (!cancelled) setLoadedDraftId(draftIdToLoad);
			});

		return () => {
			cancelled = true;
		};
	}, [draftIdToLoad, draftSaves]);

	useEffect(() => {
		if (!loadedDraftMailboxId) return;
		if (selectedMailbox?.id === loadedDraftMailboxId) return;

		const draftMailbox = mailboxes.find((mailbox) => mailbox.id === loadedDraftMailboxId);
		if (draftMailbox) setSelectedMailbox(draftMailbox);
	}, [loadedDraftMailboxId, mailboxes, selectedMailbox?.id, setSelectedMailbox]);

	useEffect(() => {
		if (loadingDraft) return;
		const nextSignature = selectedMailbox?.signature ?? "";
		setHtml((current) => applyMailboxSignatureHtml(current, previousSignature.current, nextSignature));
		previousSignature.current = nextSignature;
	}, [loadingDraft, selectedMailbox?.id, selectedMailbox?.signature]);

	function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void submitMessage();
	}

	async function submitMessage({ skipPreview = false }: { skipPreview?: boolean } = {}) {
		if (to.length === 0) {
			setToast({ type: "error", message: "Add at least one recipient" });
			return;
		}
		const invalid = [...to, ...cc, ...bcc].find((entry) => !isValidRecipient(entry));
		if (invalid) {
			setToast({ type: "error", message: `"${invalid}" is not a valid email address` });
			return;
		}
		if (!hasMeaningfulHtml(html) && !quotedHtml) {
			setToast({ type: "error", message: "Write a message before sending" });
			return;
		}
		if (scheduleInvalid || isPastScheduledSend(scheduledAt)) {
			setPreviewOpen(false);
			setToast({ type: "error", message: PAST_SCHEDULE_MESSAGE });
			return;
		}
		const isAgentDraft = !!draftId && agentRevision !== null;
		if (!isAgentDraft && !skipPreview && sendingSettings.previewEnabled) {
			setPreviewOpen(true);
			return;
		}
		setLoading(true);
		// A save still running may be the POST that creates the draft, or may be storing its files.
		cancelPendingSave();
		draftSaves.skip();
		await draftSaves.idle();
		const currentDraftId = draftSaves.draftId;
		const unsent = withoutAttachmentIds(attachments, storedUploads);
		const fullHtml = joinQuotedHtml(html, quotedHtml);
		if (draftId && agentRevision !== null) {
			try {
				if (attachments.length > 0) {
					const form = new FormData();
					for (const attachment of attachments) form.append("attachments", attachment.file);
					const uploaded = await authFetch(`/api/drafts/${draftId}/attachments`, { method: "POST", body: form });
					const result = (await uploaded.json()) as { attachments?: ComposeStoredAttachment[]; error?: string };
					if (!uploaded.ok) throw new Error(result.error || "Could not add attachments to the draft");
					setStoredAttachments((current) => [...current, ...(result.attachments ?? [])]);
					setAttachments([]);
				}
				const updated = await authFetch(`/api/drafts/${draftId}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mailboxId: selectedMailbox?.id,
						from: fromAddr,
						to: recipientsToHeader(to),
						cc: recipientsToHeader(cc),
						bcc: recipientsToHeader(bcc),
						subject,
						html: fullHtml,
						text: htmlToPlainText(fullHtml),
						inReplyTo: threading?.inReplyTo ?? null,
						references: threading?.references ?? null,
						threadId: threading?.threadId ?? null,
						scheduledAt: scheduledAt?.toISOString() ?? null,
					}),
				});
				if (!updated.ok) throw new Error("Could not save the draft for review");
				const current = await fetchDraft(draftId);
				if (!current.agent) throw new Error("AI draft metadata is missing");
				setAgentRevision(current.agent.revision);
				const response = await authFetch("/api/agent/approvals", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ draftId, expectedRevision: current.agent.revision }),
				});
				const result = (await response.json()) as { approvalId?: string; snapshot?: ReviewSnapshot; error?: string };
				if (!response.ok || !result.approvalId || !result.snapshot)
					throw new Error(result.error || "Could not create review");
				setAgentReview({ approvalId: result.approvalId, snapshot: result.snapshot });
			} catch (cause) {
				setToast({ type: "error", message: cause instanceof Error ? cause.message : "Could not review draft" });
			} finally {
				setLoading(false);
			}
			return;
		}
		// The composer clears and the preview closes straight away; the request
		// finishes behind the sending bar, and a failure puts everything back.
		const snapshot: PendingUndoSnapshot = { to, cc, bcc, showCc, showBcc, threading, subject, html, quotedHtml };
		const sent = { draftId: currentDraftId, attachments: unsent, scheduledAt };
		const body = buildSendFormData({
			attachments: unsent,
			from: fromAddr,
			to: recipientsToHeader(to),
			cc: recipientsToHeader(cc),
			bcc: recipientsToHeader(bcc),
			subject,
			text: htmlToPlainText(fullHtml),
			html: fullHtml,
			mailboxId: selectedMailbox?.id,
			threading: threading ?? undefined,
			draftId: currentDraftId,
			scheduledAt,
		});
		undoRequested.current = false;
		setUndoRequestedWhileSending(false);
		setPreviewOpen(false);
		setSending({ undoable: !scheduledAt && sendingSettings.undoSeconds > 0 });
		resetComposer();

		let data: { messageId?: string; scheduled?: boolean; undoUntil?: string; error?: string };
		let ok = false;
		try {
			const res = await authFetch("/api/send", { method: "POST", body });
			data = (await res.json()) as typeof data;
			ok = res.ok;
		} catch (cause) {
			data = { error: cause instanceof Error ? cause.message : "Send failed" };
		}
		setSending(null);
		setLoading(false);

		if (!ok) {
			restoreComposer(snapshot, sent.draftId);
			setAttachments(sent.attachments);
			void loadStoredAttachments(sent.draftId);
			setScheduledAt(sent.scheduledAt);
			setToast({ type: "error", message: data.error ?? "Send failed" });
			return;
		}

		if (sent.draftId) {
			void authFetch(`/api/drafts/${sent.draftId}`, { method: "DELETE" }).finally(() => {
				window.dispatchEvent(new Event("kite:messages-changed"));
			});
		}
		window.dispatchEvent(new Event("kite:messages-changed"));

		if (data.undoUntil && data.messageId) {
			const pending = { messageId: data.messageId, until: new Date(data.undoUntil).getTime(), snapshot };
			if (undoRequested.current) void undoSend(pending);
			else setPendingUndo(pending);
			return;
		}
		setToast({ type: "success", message: data.scheduled ? "Message scheduled" : "Message sent" });
	}

	function resetComposer() {
		cancelPendingSave();
		draftSaves.reset(null);
		setDraftId(null);
		setTo([]);
		setCc([]);
		setBcc([]);
		setShowCc(false);
		setShowBcc(false);
		setThreading(null);
		setStoredAttachments([]);
		setSubject("");
		setHtml(applyMailboxSignatureHtml("", "", selectedMailbox?.signature));
		setQuotedHtml(null);
		setAttachments([]);
		setScheduledAt(null);
		setScheduleInvalid(false);
	}

	function restoreComposer(snapshot: PendingUndoSnapshot, nextDraftId: string | null) {
		cancelPendingSave();
		draftSaves.reset(nextDraftId);
		setDraftId(nextDraftId);
		setTo(snapshot.to);
		setCc(snapshot.cc);
		setBcc(snapshot.bcc);
		setShowCc(snapshot.showCc);
		setShowBcc(snapshot.showBcc);
		setThreading(snapshot.threading);
		setSubject(snapshot.subject);
		setHtml(snapshot.html);
		setQuotedHtml(snapshot.quotedHtml);
	}

	async function undoSend(pending: PendingUndoSend) {
		setPendingUndo(null);
		const res = await authFetch("/api/send/undo", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: pending.messageId }),
		});
		const data = (await res.json()) as { draftId?: string; error?: string };
		if (!res.ok || !data.draftId) {
			setToast({ type: "error", message: data.error ?? "Could not undo send" });
			return;
		}

		// The held message is a draft again; restore the composer onto it so
		// further edits and a later send use its stored attachments.
		restoreComposer(pending.snapshot, data.draftId);
		setAttachments([]);
		await loadStoredAttachments(data.draftId);
		setToast({ type: "success", message: "Sending undone" });
		window.dispatchEvent(new Event("kite:messages-changed"));
	}

	async function loadStoredAttachments(id: string | null) {
		if (!id) {
			setStoredAttachments([]);
			return;
		}
		try {
			const draft = await fetchDraft(id);
			setStoredAttachments(draft.attachments?.filter((item) => item.disposition === "attachment") ?? []);
		} catch {
			setStoredAttachments([]);
		}
	}

	async function deleteDraftAndClose() {
		cancelPendingSave();
		setDeletingDraft(true);
		// Waits for a save in flight, so a draft it is still creating is not left behind.
		const id = await draftSaves.cancel();

		if (id) {
			let deleted = false;
			try {
				const res = await authFetch(`/api/drafts/${id}`, { method: "DELETE" });
				// Already gone (deleted in another tab, or sent) is what the user asked for.
				deleted = res.ok || res.status === 404;
			} catch {
				deleted = false;
			}
			if (!deleted) {
				setDeletingDraft(false);
				setToast({ type: "error", message: "Could not delete draft" });
				return;
			}
		}

		resetComposer();
		window.dispatchEvent(new Event("kite:messages-changed"));

		if (onClose) {
			onClose();
			return;
		}
		setDeletingDraft(false);
		router.push("/inbox");
	}

	async function removeStoredAttachment(attachmentId: string) {
		const id = draftSaves.draftId;
		if (!id) return;
		const res = await authFetch(`/api/drafts/${id}/attachments/${attachmentId}`, { method: "DELETE" });
		if (!res.ok) {
			setToast({ type: "error", message: "Could not remove attachment" });
			return;
		}
		setStoredAttachments((current) => current.filter((item) => item.id !== attachmentId));
	}

	function addAttachments(files: FileList | null) {
		if (!files) return;
		const nextFiles = Array.from(files);
		const nextCount = storedAttachments.length + attachments.length + nextFiles.length;
		const totalSize =
			storedAttachments.reduce((total, item) => total + item.size, 0) +
			[...attachments.map((attachment) => attachment.file), ...nextFiles].reduce((total, file) => total + file.size, 0);

		if (nextCount > 10) {
			setToast({ type: "error", message: "A message can include at most 10 attachments" });
			return;
		}
		if (nextFiles.some((file) => file.size > attachmentPolicy.maxMb * 1_000_000)) {
			setToast({ type: "error", message: `Each attachment must be ${attachmentPolicy.maxMb} MB or smaller` });
			return;
		}
		if (totalSize > attachmentPolicy.maxMb * 1_000_000) {
			setToast({ type: "error", message: `Attachments must total ${attachmentPolicy.maxMb} MB or less` });
			return;
		}

		setAttachments((current) => [...current, ...nextFiles.map((file) => ({ id: crypto.randomUUID(), file }))]);
		if (attachmentInput.current) attachmentInput.current.value = "";
	}

	function onFileDragEnter(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		fileDragDepth.current += 1;
		if (!loading && !loadingDraft) setDraggingFiles(true);
	}

	function onFileDragOver(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = loading || loadingDraft ? "none" : "copy";
	}

	function onFileDragLeave(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
		if (fileDragDepth.current === 0) setDraggingFiles(false);
	}

	function onFileDrop(event: DragEvent<HTMLFormElement>) {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		fileDragDepth.current = 0;
		setDraggingFiles(false);
		if (!loading && !loadingDraft) addAttachments(event.dataTransfer.files);
	}

	function selectSender(value: string) {
		const option = senderOptions.find((item) => `${item.mailbox.id}|${item.address}` === value);
		if (!option) return;
		setSelectedFrom(option.address);
		if (selectedMailbox?.id !== option.mailbox.id) setSelectedMailbox(option.mailbox);
	}

	const attachmentContent = (attachments.length > 0 || storedAttachments.length > 0) && (
		<div>
			<div className="flex min-w-0 flex-nowrap gap-2 overflow-x-auto overflow-y-hidden px-3 py-2">
				{storedAttachments.map((attachment) => (
					<div
						key={attachment.id}
						className="flex max-w-full shrink-0 items-center gap-2 rounded-lg bg-neutral-100 px-2 py-1 text-xs"
						title="Saved with the draft"
					>
						<FileText className="h-4 w-4 shrink-0 text-neutral-500" />
						<span className="max-w-48 truncate">{attachment.filename}</span>
						<span className="text-xs text-neutral-500">{formatAttachmentSize(attachment.size)}</span>
						<button
							type="button"
							onClick={() => void removeStoredAttachment(attachment.id)}
							className="rounded-full p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700"
						>
							<X className="h-3.5 w-3.5" />
							<span className="sr-only">Remove attachment</span>
						</button>
					</div>
				))}
				{attachments.map((attachment) => (
					<div
						key={attachment.id}
						className="flex max-w-full shrink-0 items-center gap-2 rounded-lg bg-neutral-100 px-2 py-1 text-xs"
					>
						<FileText className="h-4 w-4 shrink-0 text-neutral-500" />
						<span className="max-w-48 truncate font-medium">{attachment.file.name}</span>
						<span className="text-xs text-neutral-500">{formatAttachmentSize(attachment.file.size)}</span>
						<button
							type="button"
							onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
							className="rounded-full p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700"
						>
							<X className="h-3.5 w-3.5" />
							<span className="sr-only">Remove attachment</span>
						</button>
					</div>
				))}
			</div>
			<p className="px-3 pb-2 text-xs text-amber-700">
				Cloudflare limits general email messages to 5 MiB including encoding. Files over 3 MB
				{[...attachments.map((item) => item.file.size), ...storedAttachments.map((item) => item.size)].some(
					(size) => size > attachmentPolicy.cloudThresholdBytes,
				)
					? " here will"
					: " or files that exceed the message budget may"}{" "}
				be sent as 30-day R2 download links.
			</p>
		</div>
	);

	const frameClass = composeFrameClass({ mode, minimized, modalMode }, besideAssistant);

	return (
		<>
			{agentReview && (
				<SendReview
					approvalId={agentReview.approvalId}
					snapshot={agentReview.snapshot}
					onClose={() => setAgentReview(null)}
					onSent={() => {
						setAgentReview(null);
						if (onClose) onClose();
						else router.push("/sent");
					}}
				/>
			)}
			{previewOpen && (
				<SendPreview
					from={fromAddr}
					to={recipientsToHeader(to)}
					cc={recipientsToHeader(cc) || undefined}
					bcc={recipientsToHeader(bcc) || undefined}
					subject={subject}
					html={joinQuotedHtml(html, quotedHtml)}
					attachmentNames={[
						...storedAttachments.map((item) => item.filename),
						...attachments.map((item) => item.file.name),
					]}
					scheduledAt={scheduledAt}
					busy={loading}
					onCancel={() => setPreviewOpen(false)}
					onConfirm={() => {
						void submitMessage({ skipPreview: true }).finally(() => setPreviewOpen(false));
					}}
				/>
			)}
			{sending && (
				<SendingBar
					undoRequested={undoRequestedWhileSending}
					onUndo={
						sending.undoable
							? () => {
									undoRequested.current = true;
									setUndoRequestedWhileSending(true);
								}
							: undefined
					}
				/>
			)}
			{pendingUndo && (
				<UndoSendBar
					until={pendingUndo.until}
					onUndo={() => {
						void undoSend(pendingUndo);
					}}
					onExpire={() => {
						setPendingUndo(null);
						setToast({ type: "success", message: "Message sent" });
					}}
				/>
			)}
			{mode === "popup" && modalMode && !minimized && (
				<div className="fixed inset-0 z-40 bg-neutral-950/65" aria-hidden="true" />
			)}
			<ComposeToast toast={toast} />
			<form
				onSubmit={onSubmit}
				ref={formRef}
				// Mail shortcuts stay out of the composer, also when a button in it has the focus.
				data-shortcuts-off=""
				className={frameClass}
				{...composeFrameAria({ mode, minimized, modalMode })}
				onKeyDown={(event) => {
					if (modalMode && !minimized && event.key === "Escape") {
						event.preventDefault();
						setModalMode(false);
					}
				}}
				onDragEnterCapture={minimized ? undefined : onFileDragEnter}
				onDragOverCapture={minimized ? undefined : onFileDragOver}
				onDragLeaveCapture={minimized ? undefined : onFileDragLeave}
				onDropCapture={minimized ? undefined : onFileDrop}
			>
				{draggingFiles && !minimized && (
					<div
						className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/90 text-sm font-medium text-blue-700"
						aria-hidden="true"
					>
						Drop files to attach
					</div>
				)}
				<div className="flex h-9 shrink-0 items-center justify-between bg-neutral-800 text-white dark:bg-neutral-100 px-4 text-sm font-medium">
					<span className="flex min-w-0 items-center gap-2 truncate  dark:text-neutral-900">
						{threading?.inReplyTo && <Reply className="h-3.5 w-3.5 text-neutral-300" />}
						{!threading?.inReplyTo && /^fwd?:/i.test(subject) && <Forward className="h-3.5 w-3.5 text-neutral-300" />}
						{loadingDraft
							? "Loading draft"
							: threading?.inReplyTo
								? "Reply"
								: /^fwd?:/i.test(subject)
									? "Forward"
									: draftId
										? "Draft saved"
										: "New Message"}
					</span>
					{mode === "popup" && (
						<div className="flex shrink-0 items-center gap-3 text-neutral-300">
							<button
								type="button"
								onClick={() => {
									setMinimized((current) => !current);
									setDraggingFiles(false);
								}}
								aria-label={minimized ? "Restore composer" : "Minimize composer"}
								title={minimized ? "Restore composer" : "Minimize composer"}
								className="rounded p-1 hover:bg-neutral-700 dark:hover:bg-neutral-200 hover:text-white"
							>
								{minimized ? <ChevronUp className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
							</button>
							<button
								type="button"
								onClick={() => {
									if (minimized) setMinimized(false);
									setModalMode((current) => !current);
								}}
								aria-label={modalMode ? "Restore floating composer" : "Open composer as modal"}
								title={modalMode ? "Restore floating composer" : "Open composer as modal"}
								className="rounded p-1 dark:hover:bg-neutral-200 hover:bg-neutral-700 hover:text-white"
							>
								{modalMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
							</button>
							<button
								type="button"
								onClick={onClose}
								aria-label="Close composer"
								className="rounded p-1 hover:bg-neutral-700 dark:hover:bg-neutral-200 hover:text-white"
							>
								<X className="h-4 w-4" />
							</button>
						</div>
					)}
				</div>
				<div className={cn("flex min-h-0 flex-1 flex-col", minimized && "hidden")}>
					<div className="border-b border-neutral-100 px-4 py-1 flex flex-row items-center">
						<Label htmlFor={`${mode}-from`} className="text-sm text-neutral-500">
							From
						</Label>
						<Select
							id={`${mode}-from`}
							value={selectedMailbox && selectedFrom ? `${selectedMailbox.id}|${selectedFrom}` : ""}
							onChange={(event) => selectSender(event.target.value)}
							// placeholder="Select a mailbox first"
							required
							disabled={loadingDraft || senderOptions.length === 0}
							className="h-8 px-0 py-1 text-sm shadow-none focus-visible:ring-0"
							containerClassName="border-0 flex-1"
						>
							{senderOptions.length === 0 && <option value="">Select a mailbox first</option>}
							{senderOptions.map(({ mailbox, address }) => (
								<option key={`${mailbox.id}|${address}`} value={`${mailbox.id}|${address}`}>
									{address}
								</option>
							))}
						</Select>
					</div>
					<RecipientInput
						id={`${mode}-to`}
						label="To"
						value={to}
						onChange={setTo}
						placeholder='Recipients, or "Maya Chen" <maya@example.com>'
						required
						autoFocus={!draftIdToLoad}
						disabled={loadingDraft}
						trailing={
							<>
								{!showCc && (
									<button type="button" className="rounded px-1 hover:text-neutral-800" onClick={() => setShowCc(true)}>
										Cc
									</button>
								)}
								{!showBcc && (
									<button
										type="button"
										className="rounded px-1 hover:text-neutral-800"
										onClick={() => setShowBcc(true)}
									>
										Bcc
									</button>
								)}
							</>
						}
					/>
					{showCc && (
						<RecipientInput
							id={`${mode}-cc`}
							label="Cc"
							value={cc}
							onChange={setCc}
							placeholder="Carbon copy"
							disabled={loadingDraft}
							autoFocus={!loadingDraft && cc.length === 0}
						/>
					)}
					{showBcc && (
						<RecipientInput
							id={`${mode}-bcc`}
							label="Bcc"
							value={bcc}
							onChange={setBcc}
							placeholder="Blind carbon copy, hidden from other recipients"
							disabled={loadingDraft}
							autoFocus={!loadingDraft && bcc.length === 0}
						/>
					)}
					<div className="border-b border-neutral-100 px-4 py-1">
						<Label htmlFor={`${mode}-subject`} className="sr-only">
							Subject
						</Label>
						<Input
							id={`${mode}-subject`}
							value={subject}
							onChange={(event) => setSubject(event.target.value)}
							placeholder="Subject"
							required
							disabled={loadingDraft}
							className="h-8 border-0 px-0 py-1 shadow-none focus-visible:ring-0"
						/>
					</div>
					<Label htmlFor={`${mode}-text`} className="sr-only">
						Body
					</Label>
					<RichTextEditor
						id={`${mode}-text`}
						value={html}
						onChange={setHtml}
						quotedHtml={quotedHtml}
						disabled={loadingDraft}
						placeholder="Write your message"
						footerContent={attachmentContent}
						toolbarStart={
							<div className="flex items-center">
								<Button
									type="submit"
									size="sm"
									disabled={loading || loadingDraft || !fromAddr}
									className="rounded-r-none px-4"
								>
									{loading
										? "Preparing…"
										: scheduledAt
											? "Schedule"
											: agentRevision !== null || sendingSettings.previewEnabled
												? "Review send"
												: "Send"}
								</Button>
								<ScheduleSendMenu
									disabled={loading || loadingDraft || !fromAddr}
									value={scheduledAt}
									onChange={setScheduledAt}
									onInvalidChange={setScheduleInvalid}
									mailboxId={selectedMailbox?.id}
									from={fromAddr}
									applyContent={({ subject: contentSubject, html: contentHtml }) => {
										setSubject((current) => (current.trim() ? current : contentSubject));
										setHtml((current) => (hasMeaningfulHtml(current) ? `${current}${contentHtml}` : contentHtml));
									}}
								/>
							</div>
						}
						toolbarEnd={
							<>
								<Input
									ref={attachmentInput}
									type="file"
									multiple
									className="hidden"
									onChange={(event) => addAttachments(event.target.files)}
								/>
								<Tooltip
									label={`Attach files (up to ${attachmentPolicy.maxMb} MB total). Files over 3 MB are sent as 30-day R2 download links.`}
								>
									<button
										type="button"
										aria-label="Attach files"
										onClick={() => attachmentInput.current?.click()}
										disabled={loading || loadingDraft}
										className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-50"
									>
										<Paperclip className="h-4 w-4" />
									</button>
								</Tooltip>
								<span className="flex-1" />
								<Tooltip label="Delete draft">
									<button
										type="button"
										aria-label="Delete draft"
										onClick={() => void deleteDraftAndClose()}
										disabled={loading || loadingDraft || deletingDraft}
										className="rounded-md p-1.5 text-neutral-500 hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-50"
									>
										<Trash2 className="h-4 w-4" />
									</button>
								</Tooltip>
							</>
						}
					/>
				</div>
			</form>
		</>
	);
}
