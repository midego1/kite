import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { MODULE_IDS } from "@/lib/modules/registry";
import { listEnabledModules } from "@/lib/modules/state";
import { hasPrimaryDomain, userHasMailboxes } from "@/lib/user";
import { hasCloudflareCredentials, isNodeRuntime } from "@/lib/runtime";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// A display hint for the client; every server path checks module access again.
	const modules = listEnabledModules(env, {
		userId: user.id,
		role: user.role,
		isPrimaryAdmin: user.isPrimaryAdmin,
	}).catch(() => [...MODULE_IDS]);
	let hasMailboxes = false;
	let isSetup = true;
	try {
		[hasMailboxes, isSetup] = await Promise.all([userHasMailboxes(env, user.id), hasPrimaryDomain(env)]);
	} catch {
		// Authentication remains valid when optional mailbox/setup metadata is unavailable.
	}
	return NextResponse.json({
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			timeZone: user.timeZone,
			resetEmail: user.resetEmail,
			forwardingEmail: user.forwardingEmail,
			role: user.role,
			isPrimaryAdmin: user.isPrimaryAdmin,
			canManageMailboxes: user.canManageMailboxes,
			canManageDomains: user.canManageDomains,
			canManageUsers: user.canManageUsers,
			keyboardShortcutsEnabled: user.keyboardShortcutsEnabled,
			spamProtectionEnabled: user.spamProtectionEnabled,
			showFullRecipientAddresses: user.showFullRecipientAddresses,
			hasAvatar: !!user.avatarKey,
			mfaEnabled: user.totpEnabled,
		},
		runtime: isNodeRuntime(env) ? "node" : "cloudflare",
		managesDns: hasCloudflareCredentials(env),
		hasMailboxes,
		isSetup,
		modules: await modules,
	});
}
