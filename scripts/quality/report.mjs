import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const directory = "test-results/quality";
await fs.mkdir(directory, { recursive: true });
async function sizes(root) {
	const files = [];
	async function walk(dir) {
		for (const item of await fs.readdir(dir, { withFileTypes: true })) {
			const file = path.join(dir, item.name);
			if (item.isDirectory()) await walk(file);
			else if (/\.[cm]?js$/.test(file)) {
				const data = await fs.readFile(file);
				files.push({ file, bytes: data.length, gzipBytes: gzipSync(data).length });
			}
		}
	}
	await walk(root);
	if (!files.length) throw new Error(`No JavaScript build output in ${root}; run npm run build first`);
	return {
		files: files.length,
		bytes: files.reduce((total, item) => total + item.bytes, 0),
		gzipBytes: files.reduce((total, item) => total + item.gzipBytes, 0),
		largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 15),
	};
}
const results = {
	generatedAt: new Date().toISOString(),
	client: await sizes("dist/client"),
	worker: await sizes("dist/server"),
};
const budgets = JSON.parse(await fs.readFile("scripts/quality/bundle-budgets.json"));
let failed = false;
for (const kind of ["client", "worker"]) {
	console.log(
		`${kind}: ${results[kind].files} JavaScript files, ${results[kind].bytes} raw bytes, ${results[kind].gzipBytes} gzip bytes`,
	);
	for (const metric of ["bytes", "gzipBytes"])
		if (results[kind][metric] > budgets[kind][metric]) {
			console.error(`${kind} ${metric} exceeds ${budgets[kind][metric]} budget`);
			failed = true;
		}
}
await fs.writeFile(`${directory}/bundle.json`, JSON.stringify(results, null, 2));
if (failed) process.exitCode = 1;
