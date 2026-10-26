import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { intakeIncomingMail } from "@/lib/email/intake";
import { readRelayHeader, verifyInboundSignature } from "@/lib/email/intake-signature";
import { inboundAttachmentLimitReasonFromRaw } from "@/lib/email/inbound-attachments";
import { readRelayHeaders } from "@/lib/email/relay-headers";
import { recordRelaySignatureProblem } from "@/lib/alerts/relay-signature";

export const dynamic = "force-dynamic";

/**
 * Inbound mail from the Cloudflare email relay Worker (deploy/cloudflare-email-relay).
 * The body is the raw RFC 5322 message; envelope addresses travel in headers and
 * the request is HMAC-signed with INBOUND_WEBHOOK_SECRET. The response tells the
 * relay whether to reject or forward, since only it can act on the live message.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const secret = env.INBOUND_WEBHOOK_SECRET?.trim();
	if (!secret) return NextResponse.json({ error: "INBOUND_WEBHOOK_SECRET is not configured" }, { status: 503 });

	const raw = await request.arrayBuffer();
	if (raw.byteLength > 25 * 1024 * 1024)
		return NextResponse.json({ error: "Message exceeds the 25 MiB receiving limit" }, { status: 413 });
	const from = readRelayHeader(request.headers, "from") ?? "";
	const to = readRelayHeader(request.headers, "to") ?? "";
	const signature = readRelayHeader(request.headers, "signature") ?? "";
	if (!from || !to || !(await verifyInboundSignature(secret, signature, raw, from, to))) {
		return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
	}
	const attachmentLimitReason = await inboundAttachmentLimitReasonFromRaw(raw);
	if (attachmentLimitReason) return NextResponse.json({ action: "reject", reason: attachmentLimitReason });

	const {
		headers,
		authenticationResults,
		signature: headersSignature,
	} = await readRelayHeaders(secret, request.headers, raw, from, to);
	if (headersSignature === "missing" || headersSignature === "invalid")
		await recordRelaySignatureProblem(env, headersSignature).catch((error) =>
			console.error("Recording the relay headers signature problem failed", error),
		);

	let forwardTo: string | null = null;
	let forwardHeaders: Record<string, string> = {};
	const result = await intakeIncomingMail(
		env,
		{ from, to, raw, headers, authenticationResults },
		{
			// The relay performs the forward on the live message; report it as done so keep-copy applies.
			forward: async (destination, extra) => {
				forwardTo = destination;
				forwardHeaders = extra;
				return true;
			},
		},
	);
	return NextResponse.json({ ...result, forwardTo, forwardHeaders });
}
