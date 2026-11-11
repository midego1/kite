import { createServer } from "node:http";

/**
 * An in-process WebDAV server for tests: a `node:http` server with Basic auth and an in-memory tree below
 * `prefix` (Nextcloud's `/remote.php/dav/files/<user>/` shape by default). It speaks what Kite's client uses:
 * PROPFIND (Depth 0 and 1, `d:`-prefixed multistatus with percent-encoded hrefs), GET with Range, PUT with
 * `If-None-Match: *`, MKCOL, MOVE with `Overwrite: F`, and DELETE. `routes` lets a test answer a path itself
 * (a redirect, a hostile body). Never point it at, or copy it from, a real server.
 */

const escapeXml = (value) =>
	String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const encodePath = (path) =>
	path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");

function parentOf(path) {
	const at = path.lastIndexOf("/");
	return at <= 0 ? "/" : path.slice(0, at);
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return Buffer.concat(chunks);
}

export async function startFakeWebdav(options = {}) {
	const username = options.username ?? "alice";
	let password = options.password ?? "app-password-1";
	const prefix = options.prefix ?? `/remote.php/dav/files/${username}/`;
	const routes = options.routes ?? {};
	/** path ("/" is the linked folder) → { kind, data, contentType, mtime } */
	const items = new Map([["/", { kind: "folder", mtime: new Date("2026-01-01T00:00:00Z") }]]);
	const requests = [];

	const put = (path, data, contentType = "application/octet-stream") => {
		items.set(path, { kind: "file", data: Buffer.from(data), contentType, mtime: new Date("2026-02-03T04:05:06Z") });
	};
	const mkdir = (path) => items.set(path, { kind: "folder", mtime: new Date("2026-02-03T04:05:06Z") });
	for (const [path, value] of Object.entries(options.files ?? {}))
		if (value === null) mkdir(path);
		else put(path, value);

	/** The decoded path below the prefix, or null outside it. */
	function pathOf(pathname) {
		let decoded;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			return null;
		}
		const base = decodeURIComponent(prefix);
		if (decoded === base.slice(0, -1)) return "/";
		if (!decoded.startsWith(base)) return null;
		const rest = decoded.slice(base.length).replace(/\/+$/, "");
		return rest ? `/${rest}` : "/";
	}

	const hrefOf = (path, item) =>
		`${encodePath(prefix.slice(0, -1))}${path === "/" ? "/" : `${encodePath(path)}${item.kind === "folder" ? "/" : ""}`}`;

	function propEntry(path, item) {
		const props =
			item.kind === "folder"
				? "<d:resourcetype><d:collection/></d:resourcetype>"
				: `<d:resourcetype/><d:getcontentlength>${item.data.length}</d:getcontentlength><d:getcontenttype>${escapeXml(item.contentType)}</d:getcontenttype><d:getetag>"${item.data.length}-${item.mtime.getTime()}"</d:getetag>`;
		return `<d:response><d:href>${escapeXml(hrefOf(path, item))}</d:href><d:propstat><d:prop>${props}<d:getlastmodified>${item.mtime.toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`;
	}

	const childrenOf = (path) => [...items.keys()].filter((key) => key !== path && parentOf(key) === path);
	const subtree = (path) => [...items.keys()].filter((key) => key === path || key.startsWith(`${path}/`));

	function propfind(request, response, path) {
		const depth = request.headers.depth ?? "infinity";
		if (depth !== "0" && depth !== "1") return send(response, 403);
		const item = items.get(path);
		if (!item) return send(response, 404);
		const paths = depth === "1" && item.kind === "folder" ? [path, ...childrenOf(path)] : [path];
		const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${paths.map((key) => propEntry(key, items.get(key))).join("")}</d:multistatus>`;
		response.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
		response.end(body);
	}

	function get(request, response, path) {
		const item = items.get(path);
		if (!item) return send(response, 404);
		if (item.kind === "folder") return send(response, 405);
		const headers = {
			"Content-Type": item.contentType,
			"Accept-Ranges": "bytes",
			ETag: `"${item.data.length}-${item.mtime.getTime()}"`,
		};
		const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
		if (range) {
			const start = Number(range[1]);
			const end = range[2] ? Math.min(Number(range[2]), item.data.length - 1) : item.data.length - 1;
			response.writeHead(206, {
				...headers,
				"Content-Range": `bytes ${start}-${end}/${item.data.length}`,
				"Content-Length": end - start + 1,
			});
			return response.end(request.method === "HEAD" ? undefined : item.data.subarray(start, end + 1));
		}
		response.writeHead(200, { ...headers, "Content-Length": item.data.length });
		response.end(request.method === "HEAD" ? undefined : item.data);
	}

	async function putFile(request, response, path) {
		const body = await readBody(request);
		if (path === "/" || items.get(path)?.kind === "folder") return send(response, 405);
		if (items.get(parentOf(path))?.kind !== "folder") return send(response, 409);
		if (request.headers["if-none-match"] === "*" && items.has(path)) return send(response, 412);
		const created = !items.has(path);
		put(path, body, request.headers["content-type"] ?? "application/octet-stream");
		send(response, created ? 201 : 204);
	}

	function mkcol(response, path) {
		if (items.has(path)) return send(response, 405);
		if (items.get(parentOf(path))?.kind !== "folder") return send(response, 409);
		mkdir(path);
		send(response, 201);
	}

	function move(request, response, path) {
		if (!items.has(path) || path === "/") return send(response, 404);
		let target;
		try {
			target = pathOf(new URL(request.headers.destination ?? "").pathname);
		} catch {
			target = null;
		}
		if (!target || target === "/") return send(response, 400);
		if (items.get(parentOf(target))?.kind !== "folder") return send(response, 409);
		if (items.has(target) && request.headers.overwrite === "F") return send(response, 412);
		for (const key of subtree(path)) {
			const item = items.get(key);
			items.delete(key);
			items.set(`${target}${key.slice(path.length)}`, item);
		}
		send(response, 201);
	}

	function remove(response, path) {
		if (!items.has(path)) return send(response, 404);
		for (const key of subtree(path)) items.delete(key);
		send(response, 204);
	}

	function send(response, status, headers = {}) {
		response.writeHead(status, headers);
		response.end();
	}

	const authorized = (request) =>
		request.headers.authorization === `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

	const server = createServer(async (request, response) => {
		const url = new URL(request.url, "http://localhost");
		requests.push({ method: request.method, path: url.pathname, headers: { ...request.headers } });
		try {
			const route = routes[url.pathname];
			if (route) return await route(request, response);
			if (!authorized(request))
				return send(response, 401, { "WWW-Authenticate": 'Basic realm="fake-webdav", charset="UTF-8"' });
			const path = pathOf(url.pathname);
			if (path === null) return send(response, 404);
			if (request.method === "PROPFIND") return propfind(request, response, path);
			if (request.method === "GET" || request.method === "HEAD") return get(request, response, path);
			if (request.method === "PUT") return await putFile(request, response, path);
			if (request.method === "MKCOL") return mkcol(response, path);
			if (request.method === "MOVE") return move(request, response, path);
			if (request.method === "DELETE") return remove(response, path);
			send(response, 405);
		} catch {
			if (!response.headersSent) send(response, 500);
		}
	});
	await new Promise((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
	const { port } = server.address();
	const origin = `http://${options.hostname ?? "localhost"}:${port}`;
	return {
		origin,
		url: `${origin}${prefix}`,
		username,
		get password() {
			return password;
		},
		/** A new app password, as when the user revokes the old one on the server. */
		setPassword: (next) => {
			password = next;
		},
		items,
		requests,
		put,
		mkdir,
		file: (path) => items.get(path)?.data?.toString("utf8") ?? null,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
