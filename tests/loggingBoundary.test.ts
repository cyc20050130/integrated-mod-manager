import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("logging uses the official Tauri plugin through one renderer wrapper", () => {
	const packageJson = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
	const cargoToml = read("src-tauri/Cargo.toml");
	const capability = read("src-tauri/capabilities/default.json");
	const logger = read("src/lib/logger.ts");
	const entry = read("src/main.tsx");

	assert.equal(packageJson.dependencies?.["@tauri-apps/plugin-log"], "^2.9.0");
	assert.equal(packageJson.dependencies?.["@fltsci/tauri-plugin-tracing"], undefined);
	assert.match(cargoToml, /tauri-plugin-log = \{ version = "2\.9\.0", default-features = false \}/);
	assert.doesNotMatch(cargoToml, /tauri-plugin-tracing/);
	assert.match(capability, /"log:default"/);
	assert.doesNotMatch(capability, /"tracing:default"/);
	assert.match(logger, /from "@tauri-apps\/plugin-log"/);
	assert.doesNotMatch(entry, /interceptConsole/);
});
