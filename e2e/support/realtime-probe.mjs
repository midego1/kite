import { randomBytes } from "node:crypto";
import { request } from "node:http";

/**
 * Sends a WebSocket upgrade and reports how the server answered: `upgraded` (101), `status` (a plain
 * HTTP answer) or `reset` (the socket closed before any answer). Other errors are rethrown.
 */
export function probeUpgrade(url, headers) {
	return new Promise((resolve, reject) => {
		const req = request(url, {
			headers: {
				...headers,
				Upgrade: "websocket",
				Connection: "Upgrade",
				"Sec-WebSocket-Key": randomBytes(16).toString("base64"),
				"Sec-WebSocket-Version": "13",
			},
		});
		req.on("upgrade", (_res, socket) => {
			socket.destroy();
			resolve({ kind: "upgraded" });
		});
		req.on("response", (res) => {
			res.resume();
			resolve({ kind: "status", status: res.statusCode });
		});
		req.on("error", (error) => {
			if (error.code === "ECONNRESET" || /socket hang up/.test(error.message)) resolve({ kind: "reset" });
			else reject(error);
		});
		req.end();
	});
}

/**
 * The Vite dev server destroys the socket whenever the Worker answers an upgrade with anything but 101,
 * so a rejection can only be read off a hang-up. That is trusted solely when the same request with a
 * valid session is upgraded: the session is then the only difference between the two outcomes.
 * Returns null when the endpoint behaves, otherwise a description of the problem.
 */
export function realtimeVerdict({ plain, anonymous, authenticated }) {
	if (plain !== 426) return `a plain request answered ${plain}, expected 426`;
	if (authenticated.kind !== "upgraded") {
		return `the authenticated upgrade was not accepted (${JSON.stringify(authenticated)}), so a hang-up proves nothing`;
	}
	if (anonymous.kind === "reset") return null;
	if (anonymous.kind === "status" && anonymous.status === 401) return null;
	return `the anonymous upgrade was not rejected (${JSON.stringify(anonymous)})`;
}
