import { authorizeStorage, storageJson } from "@/lib/storage/admin-api";
import { r2AutoSetupAvailability, r2BucketChoices } from "@/lib/storage/auto-setup";
import { allowR2Listing } from "@/lib/storage/auto-setup-api";
import { DEFAULT_BINDING_BUCKET } from "@/lib/storage/cloudflare-r2-utils";

/** Whether the one-click R2 setup can run here, and the account's buckets for the picker (rate limited). */
export async function GET(request: Request) {
	const access = await authorizeStorage(request, false);
	if (access.error) return access.error;
	const availability = await r2AutoSetupAvailability(access.env);
	if (!availability.available) return storageJson({ ...availability, defaultBucket: DEFAULT_BINDING_BUCKET });
	if (!(await allowR2Listing(access.env, access.actor.id)))
		return storageJson({ error: "Too many bucket lookups; wait a minute and try again" }, 429);
	return storageJson({
		available: true,
		defaultBucket: DEFAULT_BINDING_BUCKET,
		...(await r2BucketChoices(access.env)),
	});
}
