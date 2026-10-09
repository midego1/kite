"use client";

import "./style.scss";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
	ArrowLeft,
	FileText,
	History,
	ListChecks,
	LoaderCircle,
	Maximize2,
	Minimize2,
	Pause,
	PenLine,
	ArrowUp,
	Settings2,
	Minus,
	SquarePen,
	Trash2,
} from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { getUserTimeZone } from "@/lib/time/utils";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { useCompose } from "@/components/compose/compose-context";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AgentTurnView } from "./agent-turn";
import { KiteAvatar } from "./kite-avatar";
import { ChatContext, ChatWelcome } from "./chat-welcome";
import { useChatContentResize } from "./use-chat-content-resize";
import { ConversationSkeleton } from "./conversation-skeleton";
import { QueuedAgentMessages } from "./queued-messages";
import { SendReview } from "./send-review";
import { AgentStepLimitSetting } from "./step-limit-setting";
import type { ReviewSnapshot } from "./send-review-types";
import { approveAgentAction, requestDraftReview } from "./client-actions";
import type {
	AgentConversation,
	AgentConversationsResponse,
	AgentErrorResponse,
	AgentEvent,
	AgentHistoryResponse,
	AgentJob,
	AgentJobsResponse,
	AgentMessage,
	AgentPanelProps,
	AgentPanelView,
	AgentSettings,
	AgentSettingsResponse,
	QueuedAgentMessage,
} from "./types";
import {
	activeAgentTool,
	activeAgentToolLabel,
	appendAgentReasoning,
	consumeAgentStream,
	editQueuedAgentMessage,
	enqueueAgentMessage,
	groupAgentMessages,
	isAgentScrollAtBottom,
	markAgentDraftSent,
	normalizeAgentHistory,
	readAgentConversationId,
	removeQueuedAgentMessage,
	resizeAgentInput,
	saveAgentConversationId,
	shouldSubmitAgentInput,
	steerQueuedAgentMessage,
	uniqueAgentDraftActions,
} from "./utils";

export function AgentPanel({ open, fullSize, onClose, onToggleFullSize }: AgentPanelProps) {
	const { selectedMailbox } = useSelectedMailbox();
	const pathname = usePathname();
	const { openDraftComposer } = useCompose();
	const [view, setView] = useState<AgentPanelView>("chat");
	const [settings, setSettings] = useState<AgentSettings | null>(null);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [reviewers, setReviewers] = useState<{ id: string; name: string; email: string }[]>([]);
	const [canManage, setCanManage] = useState(false);
	const [providerConfigured, setProviderConfigured] = useState(false);
	const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
	const [conversations, setConversations] = useState<AgentConversation[]>([]);
	const [messages, setMessages] = useState<AgentMessage[]>([]);
	const [loadingConversation, setLoadingConversation] = useState(
		() => open && !!selectedMailbox && Boolean(readAgentConversationId(selectedMailbox.id)),
	);
	const [jobs, setJobs] = useState<AgentJob[]>([]);
	const [input, setInput] = useState("");
	const [queuedMessages, setQueuedMessages] = useState<QueuedAgentMessage[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [approvingId, setApprovingId] = useState<string | null>(null);
	const [draftReview, setDraftReview] = useState<{
		approvalId: string;
		snapshot: ReviewSnapshot;
		draftId: string;
	} | null>(null);
	const abort = useRef<AbortController | null>(null);
	const queuedMessagesRef = useRef<QueuedAgentMessage[]>([]);
	const runningRef = useRef(false);
	const queueGenerationRef = useRef(0);
	const menuRef = useRef<HTMLDetailsElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const chatScrollRef = useRef<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);
	useChatContentResize(chatScrollRef, stickToBottomRef, view === "chat");
	const selectedConversationRef = useRef<string | null>(null);
	const mailboxId = selectedMailbox?.id;
	const selectedMessageId =
		pathname.match(/^\/(?:inbox|sent|archived|spam|trash|starred|snoozed|folders\/[^/]+)\/([^/]+)/)?.[1] ?? null;
	const welcomePrompts = selectedMessageId
		? [
				{
					label: "Summarize this email",
					detail: "Get the key points",
					prompt: `Read the thread containing email ${selectedMessageId} and summarize its key points.`,
					icon: FileText,
				},
				{
					label: "Suggest a reply",
					detail: "Create a draft for review",
					prompt: `Read the thread containing email ${selectedMessageId} and draft a reply.`,
					icon: PenLine,
				},
				{
					label: "List action items",
					detail: "Find next steps in this email",
					prompt: `Read the thread containing email ${selectedMessageId} and list the action items.`,
					icon: ListChecks,
				},
			]
		: [
				{
					label: "Summarize recent mail",
					detail: "Catch up on your inbox",
					prompt: "Summarize my recent email in this mailbox.",
					icon: FileText,
				},
				{
					label: "Suggest a reply",
					detail: "Create a draft for review",
					prompt: "Read my latest email and draft a reply.",
					icon: PenLine,
				},
				{
					label: "Find action items",
					detail: "See what needs attention",
					prompt: "Find action items in my recent email.",
					icon: ListChecks,
				},
			];

	const refresh = useCallback(async () => {
		if (!mailboxId) return;
		const [settingsResponse, conversationsResponse, jobsResponse] = await Promise.all([
			authFetch(`/api/agent/settings?mailboxId=${encodeURIComponent(mailboxId)}`),
			authFetch(`/api/agent/conversations?mailboxId=${encodeURIComponent(mailboxId)}`),
			authFetch(`/api/agent/jobs?mailboxId=${encodeURIComponent(mailboxId)}`),
		]);
		if (!settingsResponse.ok) {
			const data = (await settingsResponse.json().catch(() => ({}))) as AgentErrorResponse;
			setError(data.error || "Could not load assistant settings");
			return;
		}
		if (settingsResponse.ok) {
			const data = (await settingsResponse.json()) as AgentSettingsResponse;
			setSettings(data.settings);
			setAvailableModels(data.models ?? []);
			setCanManage(data.canManage);
			setProviderConfigured(data.providerConfigured);
			setAutoReplyEnabled(data.autoReplyEnabled);
			setReviewers(data.reviewers ?? []);
		}
		if (conversationsResponse.ok)
			setConversations(((await conversationsResponse.json()) as AgentConversationsResponse).conversations ?? []);
		if (jobsResponse.ok) setJobs(((await jobsResponse.json()) as AgentJobsResponse).jobs ?? []);
	}, [mailboxId]);

	// Opening the panel or switching mailbox starts a fresh session; the effect below then
	// cancels the old stream and loads the new one.
	if (useKeyChanged(JSON.stringify([open, mailboxId ?? null]))) {
		setQueuedMessages([]);
		setBusy(false);
		if (open && mailboxId) {
			setConversationId(null);
			setMessages([]);
			setSettings(null);
			setView("chat");
			setError(null);
			setLoadingConversation(Boolean(readAgentConversationId(mailboxId)));
		}
	}

	useEffect(() => {
		abort.current?.abort();
		abort.current = null;
		runningRef.current = false;
		queueGenerationRef.current += 1;
		queuedMessagesRef.current = [];
		if (!open || !mailboxId) return;
		let cancelled = false;
		stickToBottomRef.current = true;
		if (menuRef.current) menuRef.current.open = false;
		// refresh only sets state after its requests resolve.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void refresh().catch(() => {
			if (!cancelled) setError("Could not load assistant settings");
		});
		const savedId = readAgentConversationId(mailboxId);
		selectedConversationRef.current = savedId;
		if (savedId)
			void authFetch(
				`/api/agent/conversations/${encodeURIComponent(savedId)}?mailboxId=${encodeURIComponent(mailboxId)}`,
			)
				.then(async (response) => {
					if (cancelled || selectedConversationRef.current !== savedId) return;
					if (!response.ok) {
						saveAgentConversationId(mailboxId, null);
						selectedConversationRef.current = null;
						setLoadingConversation(false);
						return;
					}
					const history = (await response.json()) as AgentHistoryResponse;
					if (cancelled || selectedConversationRef.current !== savedId) return;
					setConversationId(savedId);
					setMessages(normalizeAgentHistory(history.messages ?? []));
				})
				.catch(() => undefined)
				.finally(() => {
					if (!cancelled && selectedConversationRef.current === savedId) setLoadingConversation(false);
				});
		return () => {
			cancelled = true;
			abort.current?.abort();
		};
	}, [mailboxId, open, refresh]);

	useEffect(() => {
		const closeMenu = (event: PointerEvent) => {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && menuRef.current?.open) menuRef.current.open = false;
		};
		document.addEventListener("pointerdown", closeMenu);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeMenu);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, []);

	useLayoutEffect(() => {
		resizeAgentInput(inputRef.current);
	}, [input, view]);
	useLayoutEffect(() => {
		const container = chatScrollRef.current;
		if (container && stickToBottomRef.current) container.scrollTop = container.scrollHeight;
	}, [messages, busy, loadingConversation, view, fullSize]);

	useEffect(() => {
		function onDraft(event: Event) {
			const data = (event as CustomEvent<{ mailboxId: string }>).detail;
			if (open && data.mailboxId === mailboxId) void refresh();
		}
		window.addEventListener("kite:agent-draft", onDraft);
		return () => window.removeEventListener("kite:agent-draft", onDraft);
	}, [mailboxId, open, refresh]);

	useEffect(() => {
		if (!open) return;
		const timer = window.setInterval(() => void refresh(), 30_000);
		return () => window.clearInterval(timer);
	}, [open, refresh]);

	async function selectConversation(id: string) {
		if (!mailboxId) return;
		abort.current?.abort();
		abort.current = null;
		runningRef.current = false;
		queueGenerationRef.current += 1;
		queuedMessagesRef.current = [];
		setQueuedMessages([]);
		setBusy(false);
		selectedConversationRef.current = id;
		stickToBottomRef.current = true;
		saveAgentConversationId(mailboxId, id);
		setConversationId(id);
		setMessages([]);
		setLoadingConversation(true);
		setView("chat");
		if (menuRef.current) menuRef.current.open = false;
		try {
			const response = await authFetch(`/api/agent/conversations/${id}?mailboxId=${encodeURIComponent(mailboxId)}`);
			if (!response.ok) throw new Error("Could not load conversation");
			const history = (await response.json()) as AgentHistoryResponse;
			if (selectedConversationRef.current === id) setMessages(normalizeAgentHistory(history.messages ?? []));
		} catch (cause) {
			if (selectedConversationRef.current === id)
				setError(cause instanceof Error ? cause.message : "Could not load conversation");
		} finally {
			if (selectedConversationRef.current === id) setLoadingConversation(false);
		}
	}

	async function deleteConversation(id: string) {
		if (deletingConversationId) return;
		setDeletingConversationId(id);
		try {
			const response = await authFetch(`/api/agent/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
			if (!response.ok) throw new Error("Could not delete conversation");
			setConversations((current) => current.filter((item) => item.id !== id));
			if (selectedConversationRef.current === id || conversationId === id) {
				abort.current?.abort();
				abort.current = null;
				runningRef.current = false;
				queueGenerationRef.current += 1;
				queuedMessagesRef.current = [];
				setQueuedMessages([]);
				setBusy(false);
				selectedConversationRef.current = null;
				if (mailboxId) saveAgentConversationId(mailboxId, null);
				setConversationId(null);
				setMessages([]);
				setLoadingConversation(false);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not delete conversation");
		} finally {
			setDeletingConversationId(null);
		}
	}

	async function send(text: string, queued?: QueuedAgentMessage) {
		if (!mailboxId || !text.trim() || runningRef.current || loadingConversation) return;
		const controller = new AbortController();
		const generation = queueGenerationRef.current;
		const userMessageId = crypto.randomUUID();
		const assistantMessageId = crypto.randomUUID();
		// send only runs from event handlers and stream callbacks, never during render.
		// eslint-disable-next-line react-hooks/purity
		const startedAt = Date.now();
		let accepted = false;
		let streamErrored = false;
		abort.current = controller;
		runningRef.current = true;
		setBusy(true);
		setError(null);
		setMessages((current) => [
			...current,
			{ id: userMessageId, role: "user", content: text, createdAt: new Date(startedAt).toISOString() },
			{ id: assistantMessageId, role: "assistant", content: "", pending: true },
		]);
		try {
			const response = await authFetch("/api/agent/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mailboxId,
					...(selectedConversationRef.current ? { conversationId: selectedConversationRef.current } : {}),
					text,
					timeZone: getUserTimeZone(),
				}),
				signal: controller.signal,
			});
			if (!response.ok)
				throw new Error(((await response.json()) as AgentErrorResponse).error || "Assistant unavailable");
			accepted = true;
			const responseConversationId = response.headers.get("X-Conversation-Id");
			if (responseConversationId && generation === queueGenerationRef.current) {
				selectedConversationRef.current = responseConversationId;
				saveAgentConversationId(mailboxId, responseConversationId);
				setConversationId(responseConversationId);
			}
			await consumeAgentStream(response, (event: AgentEvent) => {
				if (generation !== queueGenerationRef.current) return;
				if (event.type === "conversation") {
					selectedConversationRef.current = event.conversationId;
					saveAgentConversationId(mailboxId, event.conversationId);
					setConversationId(event.conversationId);
				}
				if (event.type === "text")
					setMessages((current) =>
						current.map((item) =>
							item.id === assistantMessageId ? { ...item, content: item.content + event.text } : item,
						),
					);
				if (event.type === "reasoning")
					setMessages((current) => appendAgentReasoning(current, assistantMessageId, event.text));
				if (event.type === "reclassify")
					setMessages((current) => appendAgentReasoning(current, assistantMessageId, event.text, true));
				if (event.type === "tool") {
					const toolId = `${assistantMessageId}:tool:${event.id}`;
					const content =
						event.state === "running"
							? ""
							: typeof event.result === "string"
								? event.result
								: (JSON.stringify(event.result) ?? "");
					const toolState = event.state === "running" ? "running" : event.state === "failed" ? "failed" : "used";
					setMessages((current) =>
						current.some((item) => item.id === toolId)
							? current.map((item) =>
									item.id === toolId ? { ...item, toolState, content, recordId: event.recordId } : item,
								)
							: [
									...current,
									{ id: toolId, role: "tool", toolName: event.name, toolState, content, recordId: event.recordId },
								],
					);
				}
				if (event.type === "error") {
					streamErrored = true;
					setError(event.message);
				}
			});
			if (generation === queueGenerationRef.current) {
				setMessages((current) =>
					current.map((item) =>
						item.id === assistantMessageId
							? { ...item, pending: false, durationMs: Date.now() - startedAt, createdAt: new Date().toISOString() }
							: item,
					),
				);
				void refresh();
			}
		} catch (cause) {
			if (generation !== queueGenerationRef.current) return;
			if (!accepted) {
				setMessages((current) => current.filter((item) => item.id !== userMessageId && item.id !== assistantMessageId));
				if (!controller.signal.aborted && generation === queueGenerationRef.current) {
					if (queued) {
						queuedMessagesRef.current = [queued, ...queuedMessagesRef.current];
						setQueuedMessages(queuedMessagesRef.current);
					} else setInput((current) => current || text);
				}
			} else
				setMessages((current) =>
					current.map((item) =>
						item.id === assistantMessageId
							? { ...item, pending: false, durationMs: Date.now() - startedAt, createdAt: new Date().toISOString() }
							: item,
					),
				);
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Assistant failed");
			streamErrored = !controller.signal.aborted;
		} finally {
			if (abort.current !== controller) return;
			abort.current = null;
			runningRef.current = false;
			setBusy(false);
			if (generation === queueGenerationRef.current && !streamErrored && queuedMessagesRef.current.length) {
				const [next, ...remaining] = queuedMessagesRef.current;
				queuedMessagesRef.current = remaining;
				setQueuedMessages(remaining);
				void send(next.text, next);
			}
		}
	}

	function submitMessage(text: string) {
		if (!mailboxId || !text.trim() || !settings || !providerConfigured || loadingConversation) return;
		setInput("");
		if (runningRef.current || queuedMessagesRef.current.length) {
			queuedMessagesRef.current = enqueueAgentMessage(queuedMessagesRef.current, text);
			setQueuedMessages(queuedMessagesRef.current);
			if (!runningRef.current) {
				const [next, ...remaining] = queuedMessagesRef.current;
				queuedMessagesRef.current = remaining;
				setQueuedMessages(remaining);
				void send(next.text, next);
			}
			return;
		}
		void send(text.trim());
	}

	async function saveSettings() {
		if (!settings) return;
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch("/api/agent/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(settings),
			});
			if (!response.ok)
				throw new Error(((await response.json()) as AgentErrorResponse).error || "Could not save settings");
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save settings");
		} finally {
			setBusy(false);
		}
	}

	async function retryJob(id: string) {
		const response = await authFetch(`/api/agent/jobs/${id}/retry`, { method: "POST" });
		if (response.ok) await refresh();
		else setError(((await response.json()) as AgentErrorResponse).error || "Could not retry draft");
	}

	async function discardJobDraft(draftId: string) {
		const response = await authFetch(`/api/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
		if (response.ok) await refresh();
		else setError(((await response.json()) as AgentErrorResponse).error || "Could not discard draft");
	}

	async function startDraftReview(draftId: string, revision: number) {
		setApprovingId(draftId);
		setError(null);
		try {
			setDraftReview({ ...(await requestDraftReview(draftId, revision)), draftId });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not open draft review");
		} finally {
			setApprovingId(null);
		}
	}

	async function confirmAction(item: AgentMessage) {
		if (!item.recordId) return;
		setApprovingId(item.id);
		setError(null);
		try {
			const result = await approveAgentAction(item.recordId);
			setMessages((current) =>
				current.map((message) => (message.id === item.id ? { ...message, content: JSON.stringify(result) } : message)),
			);
			window.dispatchEvent(new Event("kite:messages-changed"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not approve action");
		} finally {
			setApprovingId(null);
		}
	}

	const startNewChat = () => {
		abort.current?.abort();
		abort.current = null;
		runningRef.current = false;
		queueGenerationRef.current += 1;
		queuedMessagesRef.current = [];
		setQueuedMessages([]);
		setBusy(false);
		selectedConversationRef.current = null;
		stickToBottomRef.current = true;
		if (mailboxId) saveAgentConversationId(mailboxId, null);
		setConversationId(null);
		setMessages([]);
		setLoadingConversation(false);
		setInput("");
		setView("chat");
		if (menuRef.current) menuRef.current.open = false;
	};
	const draftActions = uniqueAgentDraftActions(messages);
	const activeTool = busy ? activeAgentTool(messages) : null;
	return (
		<section
			id="email-assistant-panel"
			className="flex h-full w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-blue-200/70 bg-white text-neutral-900 shadow-xl shadow-blue-900/10 max-md:rounded-b-none max-md:border-0 max-md:shadow-none"
			aria-label="Email assistant"
		>
			<header className="flex h-16 shrink-0 items-center justify-between gap-1 border-b border-blue-100 bg-gradient-to-r from-blue-50 to-blue-100/50 pl-3 pr-2">
				<div className="flex min-w-0 items-center gap-2.5">
					{view === "settings" ? (
						<button
							type="button"
							className="-ml-2 rounded-lg p-1.5 text-blue-700 hover:bg-blue-100 hover:text-blue-900"
							onClick={() => setView("chat")}
							aria-label="Back to assistant"
							title="Back to assistant"
						>
							<ArrowLeft size={18} />
						</button>
					) : (
						<KiteAvatar />
					)}
					<div className="min-w-0">
						<strong className="block truncate text-sm font-semibold">
							{view === "settings" ? "Settings" : "Kite AI"}
						</strong>
						<span className="block text-[11px] text-neutral-500">Your inbox assistant</span>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						className="rounded-lg p-1.5 text-blue-700 hover:bg-blue-100 hover:text-blue-900"
						onClick={startNewChat}
						aria-label="New chat"
						title="New chat"
					>
						<SquarePen size={18} />
					</button>
					<details ref={menuRef} className="relative">
						<summary
							className="list-none cursor-pointer rounded-lg p-1.5 text-blue-700 hover:bg-blue-100 hover:text-blue-900 [&::-webkit-details-marker]:hidden"
							aria-label="Previous chats"
							title="Previous chats"
						>
							<History size={18} />
						</summary>
						<div className="absolute -right-24 top-full z-30 mt-2 flex w-72 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white py-2 text-sm shadow-xl">
							{conversations.length ? (
								<>
									<p className="px-4 pb-1 text-xs font-medium text-neutral-500">Previous chats</p>
									<div className="max-h-64 overflow-y-auto">
										{conversations.map((item) => (
											<div
												key={item.id}
												className={`group flex items-center hover:bg-neutral-50 ${conversationId === item.id ? "bg-blue-50 text-blue-700" : "text-neutral-700"}`}
											>
												<button
													type="button"
													className="min-w-0 flex-1 truncate py-2 pl-4 pr-2 text-left"
													onClick={() => void selectConversation(item.id)}
												>
													{item.title}
												</button>
												<button
													type="button"
													className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
													aria-label={`Delete ${item.title}`}
													title="Delete chat"
													disabled={deletingConversationId !== null}
													onClick={() => void deleteConversation(item.id)}
												>
													<Trash2 size={15} />
												</button>
											</div>
										))}
									</div>
								</>
							) : (
								<p className="px-4 py-3 text-neutral-500">No previous chats</p>
							)}
						</div>
					</details>
					<button
						type="button"
						className={`rounded-full p-2 hover:bg-neutral-100 ${view === "settings" ? "bg-blue-50 text-blue-700" : "text-neutral-600 hover:text-neutral-900"}`}
						onClick={() => setView((current) => (current === "settings" ? "chat" : "settings"))}
						aria-label="Assistant settings"
						aria-pressed={view === "settings"}
						title="Assistant settings"
					>
						<Settings2 size={18} />
					</button>
					<button
						type="button"
						className="rounded-lg p-1.5 text-blue-700 hover:bg-blue-100 hover:text-blue-900"
						onClick={onToggleFullSize}
						aria-label={fullSize ? "Exit full size assistant" : "Expand assistant to full size"}
						aria-pressed={fullSize}
						title={fullSize ? "Exit full size" : "Full size"}
					>
						{fullSize ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
					</button>
					<button
						type="button"
						className="rounded-lg p-1.5 text-blue-700 hover:bg-blue-100 hover:text-blue-900"
						onClick={onClose}
						aria-label="Close assistant"
					>
						<Minus size={18} />
					</button>
				</div>
			</header>
			{error && (
				<p
					role="alert"
					className="mx-4 mt-3 break-words rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700"
				>
					{error}
				</p>
			)}
			{view === "chat" && (
				<>
					<ChatContext selectedMessageId={selectedMessageId} />
					<div
						ref={chatScrollRef}
						onScroll={(event) => {
							stickToBottomRef.current = isAgentScrollAtBottom(event.currentTarget);
						}}
						className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 text-sm sm:px-5"
					>
						<div className="mx-auto max-w-3xl space-y-5">
							{settings && !providerConfigured && (
								<p className="rounded-2xl border border-amber-100 bg-amber-50 p-3 text-amber-800">
									Configure an AI provider to use chat and auto-drafts.
								</p>
							)}
							{loadingConversation && <ConversationSkeleton />}
							{!loadingConversation && messages.length === 0 && settings && (
								<ChatWelcome
									selectedMessageId={selectedMessageId}
									prompts={welcomePrompts}
									disabled={!providerConfigured}
									busy={busy}
									onSubmit={submitMessage}
								/>
							)}
							{groupAgentMessages(messages).map((turn) => (
								<AgentTurnView
									key={turn.id}
									turn={turn}
									draftActions={draftActions}
									onOpenDraft={openDraftComposer}
									onApproveDraft={(draftId, revision) => void startDraftReview(draftId, revision)}
									onApproveAction={(item) => void confirmAction(item)}
									approvingId={approvingId}
								/>
							))}
							{jobs
								.filter((job) => job.status === "completed" && job.draftId)
								.slice(0, 5)
								.map((job) => (
									<div key={job.id} className="rounded-2xl border border-neutral-200 bg-white p-3">
										<p>Auto-draft ready</p>
										<div className="mt-2 flex gap-3 text-blue-700">
											<button type="button" onClick={() => openDraftComposer(job.draftId!)}>
												Open draft
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() =>
													submitMessage(
														`Read the thread containing email ${job.sourceMessageId} and draft another reply. Preserve the existing draft.`,
													)
												}
											>
												Regenerate
											</button>
											<button type="button" className="text-red-600" onClick={() => void discardJobDraft(job.draftId!)}>
												Discard
											</button>
										</div>
									</div>
								))}
						</div>
					</div>
					<QueuedAgentMessages
						messages={queuedMessages}
						running={busy}
						onRemove={(id) => {
							queuedMessagesRef.current = removeQueuedAgentMessage(queuedMessagesRef.current, id);
							setQueuedMessages(queuedMessagesRef.current);
						}}
						onEdit={(id, text) => {
							queuedMessagesRef.current = editQueuedAgentMessage(queuedMessagesRef.current, id, text);
							setQueuedMessages(queuedMessagesRef.current);
						}}
						onSteer={(id) => {
							queuedMessagesRef.current = steerQueuedAgentMessage(queuedMessagesRef.current, id);
							setQueuedMessages(queuedMessagesRef.current);
							if (runningRef.current) abort.current?.abort();
							else {
								const [next, ...remaining] = queuedMessagesRef.current;
								if (next) {
									queuedMessagesRef.current = remaining;
									setQueuedMessages(remaining);
									void send(next.text, next);
								}
							}
						}}
					/>
					{busy && (
						<div
							role="status"
							aria-live="polite"
							className="mx-auto w-full max-w-3xl space-y-1 px-5 py-2 text-sm text-neutral-500"
						>
							{activeTool && (
								<div className="flex items-center gap-2">
									<LoaderCircle size={14} className="shrink-0 animate-spin" aria-hidden="true" />
									<span>{activeAgentToolLabel(activeTool.toolName)}</span>
								</div>
							)}
							<div className="flex items-center gap-2">
								<LoaderCircle size={14} className="shrink-0 animate-spin" aria-hidden="true" />
								<span>Working...</span>
							</div>
						</div>
					)}
					<form
						className="relative mx-auto w-full max-w-3xl px-3 pb-2 pt-1"
						onSubmit={(event) => {
							event.preventDefault();
							submitMessage(input);
						}}
					>
						<textarea
							ref={inputRef}
							rows={1}
							className="block min-h-24 w-full resize-none rounded-xl border border-blue-200 bg-white px-3 py-3 pb-12 text-sm leading-5 text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (!shouldSubmitAgentInput(event)) return;
								event.preventDefault();
								if (input.trim() && settings && providerConfigured && !loadingConversation)
									event.currentTarget.form?.requestSubmit();
							}}
							placeholder="Ask Kite AI…"
							aria-label="Message Kite AI"
							name="message"
							disabled={!settings || !providerConfigured || loadingConversation}
						/>
						<div className="absolute bottom-11 right-5 flex justify-end gap-2">
							{busy ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => abort.current?.abort()}
									className="rounded-lg bg-blue-100 text-blue-700"
									aria-label="Stop response"
									title="Stop response"
								>
									<Pause size={16} />
								</Button>
							) : (
								<Button
									type="submit"
									variant="ghost"
									size="sm"
									disabled={!input.trim() || !settings || !providerConfigured || loadingConversation}
									className="rounded-lg bg-blue-600 text-white hover:bg-blue-700"
									aria-label="Send message"
									title="Send message"
								>
									<ArrowUp size={18} />
								</Button>
							)}
						</div>
						<p className="mt-1.5 px-1 text-[10px] text-neutral-500">Review drafts before sending.</p>
					</form>
				</>
			)}
			{view === "settings" && (
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 text-sm">
					<AgentStepLimitSetting />
					<p className="font-medium text-neutral-800">Mailbox settings</p>
					{!canManage && <p>Mailbox management permission is required to change these settings.</p>}
					{settings && (
						<>
							<label className="block">
								Draft reviewer
								<select
									className="mt-2 w-full rounded-xl border border-neutral-200 bg-white p-2 outline-none focus:border-blue-400"
									value={settings.reviewerUserId ?? ""}
									disabled={!canManage}
									onChange={(event) => setSettings({ ...settings, reviewerUserId: event.target.value })}
								>
									{reviewers.map((reviewer) => (
										<option key={reviewer.id} value={reviewer.id}>
											{reviewer.name} ({reviewer.email})
										</option>
									))}
								</select>
							</label>
							<label className="block">
								Model
								<select
									className="mt-2 w-full rounded-xl border border-neutral-200 bg-white p-2 outline-none focus:border-blue-400"
									value={settings.modelId ?? ""}
									disabled={!canManage || !availableModels.length}
									onChange={(event) => setSettings({ ...settings, modelId: event.target.value })}
								>
									{!availableModels.length && <option value="">No models configured</option>}
									{availableModels.map((model) => (
										<option key={model} value={model}>
											{model}
										</option>
									))}
								</select>
							</label>
							<div className="flex items-center justify-between gap-3">
								<span>Automatically draft replies</span>
								<Switch
									checked={settings.autoDraftEnabled}
									disabled={!canManage || autoReplyEnabled}
									onCheckedChange={(checked) => setSettings({ ...settings, autoDraftEnabled: checked })}
									aria-label="Automatically draft replies"
								/>
							</div>
							{autoReplyEnabled && (
								<p className="text-amber-700">Disable out-of-office auto-replies to enable AI drafts.</p>
							)}
							<label className="block">
								Writing instructions
								<textarea
									className="mt-2 min-h-32 w-full rounded-xl border border-neutral-200 p-2 outline-none focus:border-blue-400"
									value={settings.instructions}
									disabled={!canManage}
									onChange={(event) => setSettings({ ...settings, instructions: event.target.value })}
								/>
							</label>
							<label className="block">
								Daily auto-draft limit
								<input
									className="mt-2 w-full rounded-xl border border-neutral-200 p-2 outline-none focus:border-blue-400"
									type="number"
									min="1"
									max="100"
									value={settings.dailyLimit}
									disabled={!canManage}
									onChange={(event) => setSettings({ ...settings, dailyLimit: Number(event.target.value) })}
								/>
							</label>
							<Button type="button" size="sm" disabled={!canManage || busy} onClick={() => void saveSettings()}>
								Save settings
							</Button>
						</>
					)}
					<p className="text-xs text-neutral-500">
						Selected email and thread content is sent to the configured AI provider when you use chat or auto-drafts.
						Drafts always need your confirmation before sending.
					</p>
					{jobs
						.filter((job) => job.status === "failed" || job.status === "skipped")
						.slice(0, 5)
						.map((job) => (
							<p key={job.id} className="text-xs">
								{job.status}: {job.reason}
								{job.status === "failed" && (
									<button type="button" className="ml-2 text-blue-700 underline" onClick={() => void retryJob(job.id)}>
										Retry
									</button>
								)}
							</p>
						))}
				</div>
			)}
			{draftReview && (
				<SendReview
					approvalId={draftReview.approvalId}
					snapshot={draftReview.snapshot}
					onClose={() => setDraftReview(null)}
					onSent={() => {
						setMessages((current) => markAgentDraftSent(current, draftReview.draftId));
						setDraftReview(null);
						void refresh();
					}}
				/>
			)}
		</section>
	);
}
