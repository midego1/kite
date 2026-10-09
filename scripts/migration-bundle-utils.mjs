import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The order Wrangler's `d1 migrations apply` uses: the leading number first,
 * then the full file name by code unit. The Worker bundle and the Node
 * runtime both apply migrations in this order, and a database migrated with
 * `wrangler d1 migrations apply` must see the same sequence.
 */
export function compareMigrationNames(a, b) {
	const aNumber = leadingMigrationNumber(a);
	const bNumber = leadingMigrationNumber(b);
	if (aNumber !== bNumber) {
		if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
		if (Number.isFinite(aNumber)) return -1;
		if (Number.isFinite(bNumber)) return 1;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

function leadingMigrationNumber(name) {
	const match = /^(\d+)/.exec(name);
	return match ? Number(match[1]) : Number.NaN;
}

export function sortMigrationNames(names) {
	return [...names].sort(compareMigrationNames);
}

/**
 * Splits a migration file into statements D1 accepts one at a time. Comments
 * are dropped and trigger bodies stay whole.
 */
export function splitSql(sql) {
	const tokens =
		sql.match(
			/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_]+|;|[^\S\n]+|\n|./g,
		) ?? [];
	const statements = [];
	let current = "";
	let triggerDepth = 0;
	let insideTrigger = false;

	for (const token of tokens) {
		if (token.startsWith("--") || token.startsWith("/*")) {
			current += " ";
			continue;
		}

		const word = token.toUpperCase();
		if (word === "TRIGGER") insideTrigger = true;
		if (insideTrigger && (word === "BEGIN" || word === "CASE")) triggerDepth += 1;
		if (insideTrigger && word === "END") triggerDepth -= 1;
		current += token;

		if (token === ";" && triggerDepth === 0) {
			if (current.trim()) statements.push(current.trim());
			current = "";
			insideTrigger = false;
		}
	}

	if (current.trim()) statements.push(current.trim());
	return statements;
}

/** Every `.sql` file in the directory, in apply order, split into statements. */
export function readMigrationBundle(directory) {
	return sortMigrationNames(readdirSync(directory).filter((name) => name.endsWith(".sql"))).map((name) => ({
		name,
		statements: splitSql(readFileSync(join(directory, name), "utf8")),
	}));
}
