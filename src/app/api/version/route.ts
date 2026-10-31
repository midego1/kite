import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { BUILD_VERSION, BUILD_VERSION_LABEL } from "@/lib/build-version";
import { loadRecentChangelogReleases } from "@/lib/changelog/changelog-recent";
import { firstUpdateNoteLine, pickUpdateNotes } from "@/lib/changelog/update-notes-utils";
import { getDeploymentVersion } from "@/lib/deployment-version";

const NO_STORE = { "Cache-Control": "no-store" };

/** What this build adds for a tab that runs build `have` (its version and commit), or nothing for the same build. */
function updateDetails(have: string | null) {
	if (!have || have === BUILD_VERSION_LABEL) return {};
	const notes = pickUpdateNotes(loadRecentChangelogReleases(), have.split(" (")[0]);
	return { release: BUILD_VERSION, notes, summary: firstUpdateNoteLine(notes) };
}

/**
 * The deployment this server runs, for the "Kite was updated" notice. Only
 * signed-in users may read it, so the deployment id is not public. It is never
 * compared with anything outside the install. A tab that names its own build
 * (`?have=`) also gets this build's release and the release notes it has not
 * had yet, from the newest releases of the changelog this server was built
 * with, and the first of them as plain text for the row's preview, but only
 * once the builds differ, so the regular checks stay small.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) {
		auth.error.headers.set("Cache-Control", "no-store");
		return auth.error;
	}
	const have = new URL(request.url).searchParams.get("have");
	return Response.json({ version: getDeploymentVersion(env), ...updateDetails(have) }, { headers: NO_STORE });
}
