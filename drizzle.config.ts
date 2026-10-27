import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: [
		"./src/db/schema/index.ts",
		"./src/db/schema/agent-auto-read.ts",
		"./src/db/schema/agent-writing.ts",
		"./src/db/schema/modules.ts",
		"./src/db/schema/finance.ts",
		"./src/db/schema/drive.ts",
		"./src/db/schema/storage.ts",
		"./src/db/schema/screener.ts",
		"./src/db/schema/telemetry.ts",
	],
	out: "./drizzle/migrations",
	dialect: "sqlite",
});
