import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { DEFAULT_DRIVE_SETTINGS } from "@/lib/drive/settings-utils";
import { getSettingsView, updateSettings } from "@/lib/drive/settings";
import { withModule } from "@/lib/modules/route-guard";

export const GET = withModule("drive", async (request, { checkAuth }) => {
	const { env, error } = await checkAuth(requireDriveUser(request, { admin: true }));
	if (error) return error;
	return driveJson(env, () => getSettingsView(env), { settings: DEFAULT_DRIVE_SETTINGS });
});

export const PATCH = withModule("drive", async (request, { checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request, { admin: true }));
	if (error) return error;
	const body = await readJson(request);
	return driveJson(env, () => updateSettings(env, user, body));
});
