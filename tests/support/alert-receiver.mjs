import { createServer } from "node:http";

/**
 * A local webhook receiver on an ephemeral 127.0.0.1 port that records every
 * request. `setMode` sets the answer for all later requests; `setModes` answers
 * with each entry in turn and then keeps repeating the last one.
 */
export async function receiver(t) {
	const requests = [];
	let modes = [{ status: 200, body: "ok" }];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
			const mode = modes.length > 1 ? modes.shift() : modes[0];
			if (mode.hang) return;
			res.writeHead(mode.status, mode.location ? { Location: mode.location } : {});
			res.end(mode.body ?? "");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const { port } = server.address();
	return {
		requests,
		port,
		base: `http://127.0.0.1:${port}`,
		setMode: (next) => (modes = [next]),
		setModes: (next) => (modes = [...next]),
	};
}
