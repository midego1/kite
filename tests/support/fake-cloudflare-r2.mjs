import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** Invented values; the token value's SHA-256 is the S3 secret the fake S3 must accept. */
export const FAKE_R2 = {
	accountId: "0123456789abcdef0123456789abcdef",
	tokenId: "e2efaker2tokenid00000000000000ab",
	tokenValue: "e2e-fake-r2-token-value-not-a-secret",
	itemWriteGroupId: "pg-r2-bucket-item-write",
};

/** The S3 secret Kite derives from the fake token: the SHA-256 of its value, in hex. */
export const FAKE_R2_SECRET = createHash("sha256").update(FAKE_R2.tokenValue).digest("hex");

const json = (response, status, body) => {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
};

const ok = (response, result, extra = {}) => json(response, 200, { success: true, errors: [], result, ...extra });

const refuse = (response, status, code, message) =>
	json(response, status, { success: false, errors: [{ code, message }], result: null });

/**
 * Stands in for the Cloudflare API calls the automatic R2 setup makes (accounts, R2 buckets and CORS, account API
 * tokens). `denied` names operations answered with a permission error; `onCreateBucket` and `onCors` let a test
 * mirror buckets and CORS rules into a fake S3 so the checks that follow can pass.
 *
 * Operations: listAccounts, listBuckets, createBucket, getCors, putCors, deleteCors, permissionGroups, createToken,
 * deleteToken.
 */
export async function startFakeCloudflareR2(options = {}) {
	const state = {
		buckets: new Map((options.buckets ?? []).map((name) => [`:${name}`, { name, jurisdiction: "" }])),
		cors: new Map(),
		tokens: [],
		deletedTokens: [],
		requests: [],
		denied: new Set(),
	};
	const routes = [
		["GET", /^\/client\/v4\/accounts$/, "listAccounts", (response) => ok(response, [{ id: FAKE_R2.accountId }])],
		[
			"GET",
			/^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets$/,
			"listBuckets",
			(response, _match, request) => {
				const jurisdiction = request.headers["cf-r2-jurisdiction"] ?? "";
				const buckets = [...state.buckets.values()].filter((bucket) => bucket.jurisdiction === jurisdiction);
				ok(response, {
					buckets: buckets.map(({ name }) => ({
						name,
						creation_date: "2026-10-30T00:00:00Z",
						location: "WEUR",
						...(jurisdiction ? { jurisdiction } : {}),
					})),
				});
			},
		],
		[
			"POST",
			/^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets$/,
			"createBucket",
			(response, _match, request, body) => {
				const jurisdiction = request.headers["cf-r2-jurisdiction"] ?? "";
				const key = `${jurisdiction}:${body.name}`;
				if (state.buckets.has(key))
					return refuse(response, 409, 10004, "The bucket you tried to create already exists, and you own it.");
				state.buckets.set(key, { name: body.name, jurisdiction, locationHint: body.locationHint });
				options.onCreateBucket?.(body.name);
				ok(response, { name: body.name, jurisdiction: jurisdiction || "default" });
			},
		],
		[
			"PUT",
			/^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets\/([^/]+)\/cors$/,
			"putCors",
			(response, match, _request, body) => {
				const bucket = decodeURIComponent(match[2]);
				state.cors.set(bucket, body);
				options.onCors?.(bucket, body.rules ?? []);
				ok(response, {});
			},
		],
		[
			"GET",
			/^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets\/([^/]+)\/cors$/,
			"getCors",
			(response, match) => {
				const policy = state.cors.get(decodeURIComponent(match[2]));
				if (!policy) return refuse(response, 404, 10059, "The CORS configuration does not exist.");
				ok(response, policy);
			},
		],
		[
			"DELETE",
			/^\/client\/v4\/accounts\/([^/]+)\/r2\/buckets\/([^/]+)\/cors$/,
			"deleteCors",
			(response, match) => {
				const bucket = decodeURIComponent(match[2]);
				state.cors.delete(bucket);
				options.onCors?.(bucket, []);
				ok(response, {});
			},
		],
		[
			"GET",
			/^\/client\/v4\/accounts\/([^/]+)\/tokens\/permission_groups$/,
			"permissionGroups",
			(response) =>
				ok(response, [
					{ id: "pg-r2-read", name: "Workers R2 Storage Bucket Item Read" },
					{ id: FAKE_R2.itemWriteGroupId, name: "Workers R2 Storage Bucket Item Write" },
				]),
		],
		[
			"POST",
			/^\/client\/v4\/accounts\/([^/]+)\/tokens$/,
			"createToken",
			(response, _match, _request, body) => {
				state.tokens.push(body);
				ok(response, { id: FAKE_R2.tokenId, value: FAKE_R2.tokenValue, name: body.name, status: "active" });
			},
		],
		[
			"DELETE",
			/^\/client\/v4\/accounts\/([^/]+)\/tokens\/([^/]+)$/,
			"deleteToken",
			(response, match) => {
				state.deletedTokens.push(decodeURIComponent(match[2]));
				ok(response, { id: match[2] });
			},
		],
	];

	function handle(request, response, raw) {
		const path = new URL(request.url, "http://fake").pathname;
		const body = raw ? JSON.parse(raw) : undefined;
		const route = routes.find(([method, pattern]) => method === request.method && pattern.test(path));
		state.requests.push({
			method: request.method,
			path,
			operation: route?.[2] ?? null,
			authorization: request.headers.authorization ?? null,
			jurisdiction: request.headers["cf-r2-jurisdiction"] ?? null,
			body,
		});
		if (!route) return refuse(response, 404, 7003, "No route for that URI");
		if (state.denied.has(route[2])) return refuse(response, 403, 10000, "Authentication error");
		route[3](response, path.match(route[1]), request, body);
	}

	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => handle(request, response, raw));
	});
	await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		origin: `http://127.0.0.1:${port}`,
		state,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

/** Mirrors an R2 API CORS rule into the fake S3's own rule shape, so the browser checks see it. */
export function corsRulesForFakeS3(rules) {
	return rules.map((rule) => ({
		origins: rule.allowed?.origins ?? [],
		methods: rule.allowed?.methods ?? [],
		headers: (rule.allowed?.headers ?? []).map((header) => header.toLowerCase()),
		expose: rule.exposeHeaders ?? [],
	}));
}
