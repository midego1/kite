import { DurableObject } from "cloudflare:workers";
import { getUserMailRevision } from "./revision";
import type { NewMessageNotification, AgentDraftNotification, RevisionPing, RevisionNotification } from "./types";

/** Several devices of one user checking within this window share a single D1 read. */
const REVISION_CACHE_MS = 5_000;

export class RealtimeHub extends DurableObject<CloudflareEnv> {
	private cachedRevision: { value: string; at: number } | null = null;

	constructor(ctx: DurableObjectState, env: CloudflareEnv) {
		super(ctx, env);
		// Keep-alive pings are answered by the runtime without waking a hibernated object.
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	private async getRevision(userId: string): Promise<string> {
		const cached = this.cachedRevision;
		if (cached && Date.now() - cached.at < REVISION_CACHE_MS) return cached.value;
		const value = await getUserMailRevision(this.env, userId);
		this.cachedRevision = { value, at: Date.now() };
		return value;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/connect") {
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}

			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			const userId = request.headers.get("X-Kite-Realtime-User");
			if (!userId) return new Response("Unauthorized", { status: 401 });
			this.ctx.acceptWebSocket(server);
			server.serializeAttachment({ userId });

			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === "/notify" && request.method === "POST") {
			const payload = (await request.json()) as NewMessageNotification | AgentDraftNotification;
			const message = JSON.stringify(payload);
			this.cachedRevision = null;

			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.send(message);
				} catch {
					socket.close(1011, "Delivery failed");
				}
			}

			return new Response(null, { status: 204 });
		}

		return new Response("Not found", { status: 404 });
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (message === "ping") {
			socket.send("pong");
			return;
		}
		if (typeof message !== "string") return;
		let ping: RevisionPing;
		try {
			ping = JSON.parse(message) as RevisionPing;
		} catch {
			return;
		}
		if (ping.type !== "ping") return;
		const userId = socket.deserializeAttachment() as { userId?: string } | null;
		if (!userId?.userId) return;
		try {
			const revision = await this.getRevision(userId.userId);
			const notification: RevisionNotification = {
				type: "revision",
				revision,
				changed: ping.revision !== null && ping.revision !== revision,
			};
			socket.send(JSON.stringify(notification));
		} catch {
			socket.close(1011, "Revision lookup failed");
		}
	}
}
