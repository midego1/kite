import { driveJson, requireDriveUser } from "@/lib/drive/auth";
import { listUsage } from "@/lib/drive/settings";
import { withModule } from "@/lib/modules/route-guard";

export const GET = withModule("drive", async (request, { checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request, { admin: true }));
	if (error) return error;
	const cursor = new URL(request.url).searchParams.get("cursor");
	return driveJson(env, () => listUsage(env, user, cursor), {
		accounts: [],
		nextCursor: null,
		defaultQuotaBytes: null,
	});
});
