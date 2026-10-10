import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: ["./src/db/schema/index.ts", "./src/db/schema/agent-auto-read.ts"],
	out: "./drizzle/migrations",
	dialect: "sqlite",
});
