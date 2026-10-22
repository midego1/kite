import { renderCommitGroups } from "../release-notes.mjs";
import { changelogSection, compareVersions, isCalendarVersion } from "../version-utils.mjs";
import { planDeployment } from "./deploy-record-utils.mjs";

const MAIN_SCRIPT = "kite";
const PER_PAGE = 100;
const MAX_RELEASE_PAGES = 10;

/** Only a successful production deploy of the main Worker becomes a release. */
export function planRelease(event) {
	const deployment = planDeployment(event);
	if (deployment.skip) return deployment;
	if (deployment.environment !== "production") {
		return { skip: true, reason: `${deployment.environment} is not the production deploy of ${MAIN_SCRIPT}` };
	}
	if (deployment.script !== MAIN_SCRIPT) return { skip: true, reason: `script ${deployment.script} is not released` };
	if (deployment.state !== "success") return { skip: true, reason: `deploy state is ${deployment.state}` };
	if (!/^[0-9a-f]{40}$/.test(String(deployment.sha))) return { skip: true, reason: "head_sha is not a commit SHA" };
	return { sha: deployment.sha, buildId: deployment.buildId };
}

export function releaseTag(version) {
	const trimmed = String(version).trim();
	if (!isCalendarVersion(trimmed)) throw new Error(`VERSION ${trimmed || "(empty)"} is not a calendar version`);
	return `v${trimmed}`;
}

/** The changelog section for `version`, then the commits since `base` grouped like the draft notes. */
export function renderPublishedNotes({ version, changelog, base, subjects }) {
	const section = changelogSection(changelog, version) || `CHANGELOG.md has no notes for ${version}.`;
	return `${section}\n\n## Commits\n\nCompared with ${base}.\n\n${renderCommitGroups(subjects, "###")}\n`;
}

function githubClient({ fetch: doFetch, token, repo }) {
	const base = `https://api.github.com/repos/${repo}`;
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	return async (method, path, { body, allow404 = false } = {}) => {
		const response = await doFetch(`${base}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (allow404 && response.status === 404) return null;
		if (!response.ok) throw new Error(`GitHub API ${method} ${path.split("?")[0]} failed with ${response.status}`);
		return response.json();
	};
}

/** The commit a tag ref names, following annotated tag objects. */
async function tagCommit(call, ref) {
	let object = ref?.object;
	for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
		object = (await call("GET", `/git/tags/${object.sha}`))?.object;
	}
	if (object?.type !== "commit") throw new Error(`Tag ${ref?.ref ?? ""} does not point at a commit`);
	return object.sha;
}

/** Find the draft or release and the highest published calendar version, regardless of list order. */
async function findRelease(call, tag) {
	let release = null;
	let latestVersion = null;
	for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
		const items = await call("GET", `/releases?per_page=${PER_PAGE}&page=${page}`);
		if (!Array.isArray(items)) throw new Error("GitHub API returned an invalid release list");
		for (const item of items) {
			if (item?.tag_name === tag) release = item;
			if (item?.draft || item?.prerelease || typeof item?.tag_name !== "string") continue;
			const version = item.tag_name.startsWith("v") ? item.tag_name.slice(1) : "";
			if (isCalendarVersion(version) && (!latestVersion || compareVersions(version, latestVersion) > 0)) {
				latestVersion = version;
			}
		}
		if (items.length < PER_PAGE) return { release, latestVersion };
	}
	throw new Error(
		`Release history exceeds ${MAX_RELEASE_PAGES * PER_PAGE} entries; not creating a possible duplicate or changing latest without full history`,
	);
}

/**
 * Tags `sha` as `v<version>` and publishes the release "Kite <version>". A tag that already names another
 * commit means this deploy did not bump VERSION, which is reported instead of retagging; a published release is
 * never edited.
 */
export async function publishRelease({ sha, version, notes }, { fetch: doFetch = fetch, token, repo }) {
	const call = githubClient({ fetch: doFetch, token, repo });
	const tag = releaseTag(version);
	const name = `Kite ${tag.slice(1)}`;
	const ref = await call("GET", `/git/ref/tags/${tag}`, { allow404: true });
	let createdTag = false;
	if (ref) {
		const taggedSha = await tagCommit(call, ref);
		if (taggedSha !== sha) return { outcome: "not-bumped", tag, taggedSha };
	} else {
		await call("POST", "/git/refs", { body: { ref: `refs/tags/${tag}`, sha } });
		createdTag = true;
	}

	const { release, latestVersion } = await findRelease(call, tag);
	if (release && !release.draft) return { outcome: "already-published", tag, createdTag, url: release.html_url };
	const body = {
		tag_name: tag,
		target_commitish: sha,
		name,
		body: notes,
		draft: false,
		make_latest: !latestVersion || compareVersions(version, latestVersion) > 0 ? "true" : "false",
	};
	const published = release
		? await call("PATCH", `/releases/${release.id}`, { body })
		: await call("POST", "/releases", { body });
	return { outcome: release ? "published-draft" : "published", tag, createdTag, url: published?.html_url };
}
