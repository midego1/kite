import { useCallback, useEffect, useState } from "react";
import { AUTH_SESSION_CHANGED_EVENT, getClientSessionKey } from "@/lib/auth/client";
import type { MessageRealtimeState, NewMessageEvent, RealtimeChannelMessage } from "./message-realtime-types";
import {
	getRealtimeWebSocketUrl,
	getReconnectDelay,
	parseNewMessageEvent,
	REALTIME_FALLBACK_INTERVAL_MS,
	REALTIME_FOCUS_CHECK_THROTTLE_MS,
	REALTIME_HEARTBEAT_INTERVAL_MS,
	REALTIME_REVISION_INTERVAL_MS,
	showBrowserNewMessageNotification,
} from "./message-realtime-utils";

export function useMessagePolling(): MessageRealtimeState {
	const [notification, setNotification] = useState<NewMessageEvent | null>(null);
	const dismissNotification = useCallback(() => setNotification(null), []);

	useEffect(() => {
		let socket: WebSocket | null = null;
		let channel: BroadcastChannel | null = null;
		let lockAbort: AbortController | null = null;
		let releaseLeader: (() => void) | null = null;
		let reconnectTimer: number | null = null;
		let heartbeatTimer: number | null = null;
		let revisionTimer: number | null = null;
		let lastRevisionCheck = 0;
		let lastFallbackRefresh = 0;
		let fallbackTimer: number | null = null;
		let reconnectAttempt = 0;
		let revision: string | null = null;
		let connected = false;
		let leader = false;
		let sessionToken = getClientSessionKey();
		let stopped = false;

		function dispatchMessagesChanged() {
			window.dispatchEvent(new CustomEvent("kite:messages-changed", { detail: { realtime: true } }));
		}

		function clearConnectionTimers() {
			if (reconnectTimer) window.clearTimeout(reconnectTimer);
			if (heartbeatTimer) window.clearInterval(heartbeatTimer);
			if (revisionTimer) window.clearInterval(revisionTimer);
			reconnectTimer = null;
			heartbeatTimer = null;
			revisionTimer = null;
		}

		function startFallbackRefresh() {
			if (fallbackTimer) return;
			fallbackTimer = window.setInterval(() => {
				if (!connected && document.visibilityState === "visible") dispatchMessagesChanged();
			}, REALTIME_FALLBACK_INTERVAL_MS);
		}

		function setConnected(value: boolean) {
			connected = value;
			if (value) {
				if (fallbackTimer) window.clearInterval(fallbackTimer);
				fallbackTimer = null;
			} else {
				startFallbackRefresh();
			}
			if (leader) channel?.postMessage({ type: "status", connected: value } satisfies RealtimeChannelMessage);
		}

		function handleNotification(payload: string, fromSocket: boolean) {
			try {
				const parsed = JSON.parse(payload) as {
					type?: string;
					revision?: string;
					changed?: boolean;
					draftId?: string;
					mailboxId?: string;
				};
				if (parsed.type === "revision" && typeof parsed.revision === "string") {
					revision = parsed.revision;
					if (parsed.changed) {
						dispatchMessagesChanged();
						if (fromSocket) channel?.postMessage({ type: "refresh" } satisfies RealtimeChannelMessage);
					}
					return;
				}
				if (parsed.type === "agent_draft" && parsed.draftId && parsed.mailboxId) {
					window.dispatchEvent(new CustomEvent("kite:agent-draft", { detail: parsed }));
					dispatchMessagesChanged();
					if (fromSocket) channel?.postMessage({ type: "notification", payload } satisfies RealtimeChannelMessage);
					return;
				}
			} catch {
				return;
			}
			const event = parseNewMessageEvent(payload);
			if (!event) return;
			dispatchMessagesChanged();
			setNotification(event);
			if (fromSocket) {
				showBrowserNewMessageNotification(event);
				channel?.postMessage({ type: "notification", payload } satisfies RealtimeChannelMessage);
			}
		}

		function sendHeartbeat() {
			if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
		}

		function checkRevision() {
			if (socket?.readyState !== WebSocket.OPEN) return;
			lastRevisionCheck = Date.now();
			socket.send(JSON.stringify({ type: "ping", revision }));
		}

		function checkRevisionIfVisible() {
			if (document.visibilityState === "visible") checkRevision();
		}

		function scheduleReconnect() {
			setConnected(false);
			if (stopped || !leader || !getClientSessionKey()) return;
			const delay = getReconnectDelay(reconnectAttempt);
			reconnectAttempt += 1;
			reconnectTimer = window.setTimeout(connect, delay);
		}

		function connect() {
			clearConnectionTimers();
			if (stopped || !leader || !getClientSessionKey()) return;

			socket = new WebSocket(getRealtimeWebSocketUrl());
			socket.onopen = () => {
				reconnectAttempt = 0;
				revision = null;
				setConnected(true);
				dispatchMessagesChanged();
				checkRevision();
				heartbeatTimer = window.setInterval(sendHeartbeat, REALTIME_HEARTBEAT_INTERVAL_MS);
				revisionTimer = window.setInterval(checkRevisionIfVisible, REALTIME_REVISION_INTERVAL_MS);
			};
			socket.onmessage = (message) => {
				if (message.data === "pong" || typeof message.data !== "string") return;
				handleNotification(message.data, true);
			};
			socket.onerror = () => socket?.close();
			socket.onclose = () => {
				clearConnectionTimers();
				scheduleReconnect();
			};
		}

		function requestLeadership() {
			if (stopped || !getClientSessionKey()) return;
			if (!channel || !navigator.locks) {
				leader = true;
				connect();
				return;
			}
			lockAbort = new AbortController();
			void navigator.locks
				.request("kite:realtime", { signal: lockAbort.signal }, async () => {
					if (stopped || !getClientSessionKey()) return;
					await new Promise<void>((resolve) => {
						releaseLeader = resolve;
						leader = true;
						connect();
					});
					leader = false;
					releaseLeader = null;
				})
				.catch(() => {});
		}

		function restartForSessionChange() {
			sessionToken = getClientSessionKey();
			if (socket) {
				socket.onclose = null;
				socket.close(1000, "Session changed");
				socket = null;
			}
			clearConnectionTimers();
			setConnected(false);
			lockAbort?.abort();
			releaseLeader?.();
			leader = false;
			reconnectAttempt = 0;
			revision = null;
			setNotification(null);
			requestLeadership();
		}

		function onChannelMessage(event: MessageEvent<RealtimeChannelMessage>) {
			const message = event.data;
			if (message?.type === "status_request" && leader) {
				channel?.postMessage({ type: "status", connected } satisfies RealtimeChannelMessage);
			} else if (message?.type === "status" && !leader) {
				setConnected(message.connected);
				if (message.connected) dispatchMessagesChanged();
			} else if (message?.type === "notification" && !leader) {
				handleNotification(message.payload, false);
			} else if (message?.type === "refresh") {
				dispatchMessagesChanged();
			} else if (message?.type === "revision_check" && leader) {
				checkRevision();
			}
		}

		function onLocalMessagesChanged(event: Event) {
			if ((event as CustomEvent<{ realtime?: boolean }>).detail?.realtime) return;
			channel?.postMessage({ type: "refresh" } satisfies RealtimeChannelMessage);
		}

		// With a live socket, new mail is pushed and a revision check catches anything
		// changed elsewhere, so regaining focus no longer refetches every list and count.
		function onVisibilityChange() {
			if (document.visibilityState !== "visible") return;
			const now = Date.now();
			if (connected) {
				if (now - lastRevisionCheck < REALTIME_FOCUS_CHECK_THROTTLE_MS) return;
				lastRevisionCheck = now;
				if (leader) checkRevision();
				else channel?.postMessage({ type: "revision_check" } satisfies RealtimeChannelMessage);
				return;
			}
			if (now - lastFallbackRefresh < REALTIME_FOCUS_CHECK_THROTTLE_MS) return;
			lastFallbackRefresh = now;
			dispatchMessagesChanged();
		}

		function onStorageChange() {
			if (sessionToken !== getClientSessionKey()) restartForSessionChange();
		}

		if (typeof BroadcastChannel !== "undefined") {
			channel = new BroadcastChannel("kite:realtime");
			channel.onmessage = onChannelMessage;
			channel.postMessage({ type: "status_request" } satisfies RealtimeChannelMessage);
		}
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, restartForSessionChange);
		window.addEventListener("storage", onStorageChange);
		window.addEventListener("kite:messages-changed", onLocalMessagesChanged);
		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("focus", onVisibilityChange);
		startFallbackRefresh();
		requestLeadership();

		return () => {
			stopped = true;
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, restartForSessionChange);
			window.removeEventListener("storage", onStorageChange);
			window.removeEventListener("kite:messages-changed", onLocalMessagesChanged);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("focus", onVisibilityChange);
			if (leader) channel?.postMessage({ type: "status", connected: false } satisfies RealtimeChannelMessage);
			lockAbort?.abort();
			releaseLeader?.();
			clearConnectionTimers();
			if (fallbackTimer) window.clearInterval(fallbackTimer);
			channel?.close();
			if (socket) {
				socket.onclose = null;
				socket.close(1000, "Client closed");
			}
		};
	}, []);

	useEffect(() => {
		if (!notification) return;
		const timer = window.setTimeout(() => setNotification(null), 8_000);
		return () => window.clearTimeout(timer);
	}, [notification]);

	return { notification, dismissNotification };
}
