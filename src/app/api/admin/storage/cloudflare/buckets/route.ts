import { authorizeStorage, readBody, storageJson } from "@/lib/storage/admin-api";
import { setUpR2 } from "@/lib/storage/auto-setup";
import { autoSetupAttempt, autoSetupResponse } from "@/lib/storage/auto-setup-api";
import { parseR2SetupInput } from "@/lib/storage/cloudflare-r2-utils";

/**
 * Create a new R2 bucket (or connect an existing one) as a store in one click: bucket, bucket-scoped token, CORS
 * rule, checks and save. A taken name answers 409 `bucket_exists`, and the dialog offers to use that bucket.
 */
export async function POST(request: Request) {
	const access = await authorizeStorage(request, true);
	if (access.error) return access.error;
	const parsed = parseR2SetupInput(await readBody(request), { requireBucket: true });
	if (!parsed.ok) return storageJson({ error: parsed.error, field: parsed.field }, 400);
	const input = parsed.value;
	const attempt = await autoSetupAttempt(access.env, access.actor.id, {
		kind: "store",
		bucket: input.bucket,
		created: !!input.create,
	});
	if ("error" in attempt) return attempt.error;
	return autoSetupResponse(
		await setUpR2(
			access.env,
			access.actor,
			access.origin,
			{ sameAsBinding: false, ...input },
			{ attemptId: attempt.id },
		),
	);
}
