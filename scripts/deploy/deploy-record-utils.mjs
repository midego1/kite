const APP_SLUG = "cloudflare-workers-and-pages";
const NAME_PREFIX = "Workers Builds: ";
const MAIN_SCRIPT = "kite";

const STATES = {
	success: "success",
	failure: "failure",
	timed_out: "failure",
	cancelled: "error",
};

export function planDeployment(event) {
	const check = event?.check_run;
	if (!check) return { skip: true, reason: "no check_run in event" };
	if (check.app?.slug !== APP_SLUG) {
		return { skip: true, reason: "check run is not from Cloudflare Workers and Pages" };
	}
	if (typeof check.name !== "string" || !check.name.startsWith(NAME_PREFIX)) {
		return { skip: true, reason: "check name does not start with 'Workers Builds: '" };
	}
	const state = STATES[check.conclusion];
	if (!state) {
		return { skip: true, reason: `conclusion '${check.conclusion}' is not recorded` };
	}

	const script = check.name.slice(NAME_PREFIX.length).trim();
	const production = String(check.details_url ?? "").includes("/production/builds/");
	let environment = `preview/${script}`;
	if (production) {
		environment = script === MAIN_SCRIPT ? "production" : `production/${script}`;
	}
	const versionId = /Version ID: ([0-9a-f-]{36})/.exec(check.output?.summary ?? "")?.[1] ?? null;

	return {
		sha: check.head_sha,
		script,
		buildId: check.external_id,
		versionId,
		environment,
		state,
		logUrl: check.details_url,
		description: `Workers Builds: ${script} ${state}`,
	};
}

export async function recordDeployment(plan, { fetch: doFetch = fetch, token, repo }) {
	const base = `https://api.github.com/repos/${repo}`;
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const call = async (path, init) => {
		const response = await doFetch(`${base}${path}`, { ...init, headers });
		if (!response.ok) {
			throw new Error(`GitHub API ${init?.method ?? "GET"} ${path.split("?")[0]} failed with ${response.status}`);
		}
		return response.json();
	};

	const PER_PAGE = 100;
	const MAX_PAGES = 50;
	let deployment;
	let exhausted = false;
	for (let page = 1; page <= MAX_PAGES && !deployment; page++) {
		const query = new URLSearchParams({
			sha: plan.sha,
			environment: plan.environment,
			per_page: String(PER_PAGE),
			page: String(page),
		});
		const items = await call(`/deployments?${query}`);
		if (!Array.isArray(items)) {
			exhausted = true;
			break;
		}
		deployment = items.find((item) => item?.payload?.buildId === plan.buildId);
		if (items.length < PER_PAGE) {
			exhausted = true;
			break;
		}
	}

	if (!deployment && !exhausted) {
		throw new Error(
			`Deployment history pagination cap (${MAX_PAGES} pages) reached without finding build ${plan.buildId}; not creating a possibly duplicate deployment`,
		);
	}

	if (!deployment) {
		deployment = await call("/deployments", {
			method: "POST",
			body: JSON.stringify({
				ref: plan.sha,
				environment: plan.environment,
				auto_merge: false,
				required_contexts: [],
				production_environment: plan.environment.startsWith("production"),
				transient_environment: false,
				description: plan.description,
				payload: {
					buildId: plan.buildId,
					versionId: plan.versionId,
					script: plan.script,
				},
			}),
		});
	}

	await call(`/deployments/${deployment.id}/statuses`, {
		method: "POST",
		body: JSON.stringify({
			state: plan.state,
			log_url: plan.logUrl,
			description: plan.description,
		}),
	});
	return { deploymentId: deployment.id };
}
