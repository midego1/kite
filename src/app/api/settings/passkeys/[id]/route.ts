import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { recordAuthActivity } from "@/lib/auth/activity";
import { removePasskey } from "@/lib/auth/passkeys";
import { noStoreJson, requirePasskeyReauthentication, withPasskeys } from "@/lib/auth/passkey-http";

/** Removes one of the user's passkeys after re-checking the password (or an authenticator code). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const auth = await requirePasskeyReauthentication(env, request);
	if (auth.error) return auth.error;
	const { id } = await params;
	return withPasskeys(async () => {
		const name = await removePasskey(env, auth.user.id, id);
		if (name === null) return NextResponse.json({ error: "Passkey not found" }, { status: 404 });
		await recordAuthActivity(env, {
			action: "auth.passkey_removed",
			userId: auth.user.id,
			request,
			details: { passkeyName: name },
		});
		return noStoreJson({ ok: true });
	});
}
