import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireAwsConfig } from "@/lib/aws/config";
import { deleteObject, getObject } from "@/lib/aws/s3";
import { getSesReceivingState, SES_OBJECT_PREFIX } from "@/lib/aws/ses-receiving";
import { intakeProviderMail } from "@/lib/email/provider-intake";
import { parseSesNotification, safeEqual, type SesNotification, type SnsEnvelope } from "@/lib/aws/ses-notification";
import { verifySnsSignature } from "@/lib/aws/sns-signature";
import { createLogger } from "@/lib/logger.mjs";

const logger = createLogger("inbound");
const LOG_INTERVAL_MS = 10 * 60_000;
let unsignedLoggedAt = -Infinity;

export const dynamic = "force-dynamic";

/**
 * Amazon SNS endpoint for SES inbound mail. SNS posts JSON as text/plain.
 *
 * Delivery is guarded by the secret token in the URL that only the subscription we created knows,
 * the topic ARN matching ours, and the message itself being read from our own S3 bucket with our
 * credentials, so a forged notification cannot inject content. SES's SPF, DKIM and DMARC verdicts
 * travel in the notification itself, so they count only when SNS's signature verifies
 * (`verifySnsSignature`, certificate pinned to `sns.<region>.amazonaws.com`) and the object key is
 * the one SES derives from that notification's message id. Otherwise the mail is still delivered,
 * with the sender's authentication unknown, and the failure is logged.
 */
/** SES's verdicts when SNS signed the notification and it names the object SES stored for it; else null. */
async function trustedVerdicts(envelope: SnsEnvelope, notification: SesNotification, region: string) {
	const signed = await verifySnsSignature(envelope, region);
	if (!signed && Date.now() - unsignedLoggedAt >= LOG_INTERVAL_MS) {
		unsignedLoggedAt = Date.now();
		logger.error("ses.notification_signature_invalid", { effect: "authentication_unknown" });
	}
	const ownKey = !!notification.messageId && notification.key === `${SES_OBJECT_PREFIX}${notification.messageId}`;
	return signed && ownKey ? notification.authenticationResults : null;
}

export async function POST(request: Request) {
	const env = getEnv();
	const state = await getSesReceivingState(env);
	const token = new URL(request.url).searchParams.get("token") ?? "";
	if (!state || !safeEqual(token, state.token)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

	let envelope: SnsEnvelope;
	try {
		envelope = JSON.parse(await request.text()) as SnsEnvelope;
	} catch {
		return NextResponse.json({ error: "Invalid body" }, { status: 400 });
	}
	if (envelope.TopicArn !== state.topicArn) return NextResponse.json({ error: "Unknown topic" }, { status: 403 });

	if (envelope.Type === "SubscriptionConfirmation") {
		const url = envelope.SubscribeURL ? new URL(envelope.SubscribeURL) : null;
		if (!url || url.protocol !== "https:" || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
			return NextResponse.json({ error: "Invalid subscription URL" }, { status: 400 });
		}
		const confirmed = await fetch(url);
		return NextResponse.json({ confirmed: confirmed.ok }, { status: confirmed.ok ? 200 : 502 });
	}
	if (envelope.Type !== "Notification") return NextResponse.json({ ignored: true });

	const notification = parseSesNotification(envelope.Message ?? "");
	if (!notification) return NextResponse.json({ ignored: true });
	if (notification.bucket !== state.bucket || !notification.key.startsWith(SES_OBJECT_PREFIX)) {
		return NextResponse.json({ error: "Unexpected object" }, { status: 400 });
	}

	const config = await requireAwsConfig(env);
	if (notification.virusFailed) {
		await deleteObject(config, state.bucket, notification.key);
		return NextResponse.json({ dropped: "Message failed the virus scan" });
	}
	const raw = await getObject(config, state.bucket, notification.key);
	const result = await intakeProviderMail(env, {
		from: notification.from,
		recipients: notification.recipients,
		raw,
		headers: notification.headers,
		authenticationResults: await trustedVerdicts(envelope, notification, state.region),
	});
	// Only after intake succeeded: a failure above returns 500 so SNS retries with the object intact.
	await deleteObject(config, state.bucket, notification.key);
	return NextResponse.json(result);
}
