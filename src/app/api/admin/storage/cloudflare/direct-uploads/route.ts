import { authorizeStorage, readBody, storageJson } from "@/lib/storage/admin-api";
import { setUpDirectUploads } from "@/lib/storage/auto-setup";
import { autoSetupAttempt, autoSetupResponse } from "@/lib/storage/auto-setup-api";
import { parseR2SetupInput } from "@/lib/storage/cloudflare-r2-utils";

/** Set up automatically: R2 S3 keys for the default bucket, created with CF_TOKEN, so Drive uploads go direct. */
export async function POST(request: Request) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const parsed = parseR2SetupInput(await readBody(request), { requireBucket: false });
	if (!parsed.ok) return storageJson({ error: parsed.error, field: parsed.field }, 400);
	const { bucket, jurisdiction } = parsed.value;
	const attempt = await autoSetupAttempt(access.env, access.actor.id, { kind: "direct_uploads", bucket });
	if ("error" in attempt) return attempt.error;
	return autoSetupResponse(
		await setUpDirectUploads(
			access.env,
			access.actor,
			access.origin,
			{ bucket, jurisdiction },
			{ attemptId: attempt.id },
		),
	);
}
