import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

type TauriConfig = {
	plugins?: {
		updater?: {
			endpoints?: string[];
		};
	};
};

function readTauriConfig() {
	const configPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
	return JSON.parse(readFileSync(configPath, "utf8")) as TauriConfig;
}

test("updater endpoint reads the committed manifest instead of the generated release asset manifest", () => {
	const config = readTauriConfig();
	const endpoints = config.plugins?.updater?.endpoints || [];

	assert.deepEqual(endpoints, ["https://raw.githubusercontent.com/cyc20050130/integrated-mod-manager/main/latest.json"]);
});
