import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import {
	CLOUD_ATTACHMENT_THRESHOLD_BYTES,
	getOutboundAttachmentMaxMb,
	sendsThroughCloudflare,
} from "@/lib/email/attachment-policy";

/** `?from=<address>` tells the composer whether that From domain's provider turns big files into links. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const from = new URL(request.url).searchParams.get("from");
	return Response.json(
		{
			maxMb: await getOutboundAttachmentMaxMb(env),
			cloudThresholdBytes: CLOUD_ATTACHMENT_THRESHOLD_BYTES,
			cloudLinks: from ? await sendsThroughCloudflare(env, from) : true,
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
