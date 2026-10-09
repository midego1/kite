import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import type { Branding } from "./types";

export const APP_SETTINGS_ID = "default";
export const DEFAULT_APP_NAME = "Kite";
export const BRANDING_ICON_KEY = "branding/app-icon";
// Migration 0012 seeded this name, so a stored value equal to it was never chosen by an admin.
const LEGACY_DEFAULT_APP_NAME = "Mailflare";

export async function getBranding(env: CloudflareEnv): Promise<Branding> {
	try {
		const [settings] = await getDb(env).select().from(appSettings).where(eq(appSettings.id, APP_SETTINGS_ID)).limit(1);
		return {
			appName: settings?.appName && settings.appName !== LEGACY_DEFAULT_APP_NAME ? settings.appName : DEFAULT_APP_NAME,
			hasCustomIcon: !!settings?.iconKey,
		};
	} catch {
		return { appName: DEFAULT_APP_NAME, hasCustomIcon: false };
	}
}

export async function updateBranding(
	env: CloudflareEnv,
	input: { appName: string; icon?: File | null },
): Promise<Branding> {
	let iconKey: string | undefined;
	if (input.icon) {
		iconKey = BRANDING_ICON_KEY;
		await env.BUCKET.put(iconKey, await input.icon.arrayBuffer(), {
			httpMetadata: { contentType: input.icon.type },
		});
	}

	await getDb(env)
		.insert(appSettings)
		.values({
			id: APP_SETTINGS_ID,
			appName: input.appName,
			iconKey: iconKey ?? null,
		})
		.onConflictDoUpdate({
			target: appSettings.id,
			set: {
				appName: input.appName,
				...(iconKey ? { iconKey } : {}),
				updatedAt: new Date(),
			},
		});
	return getBranding(env);
}
