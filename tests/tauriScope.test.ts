import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

type CapabilityPermission =
	| string
	| {
			identifier?: string;
			allow?: string[] | Array<{ path?: string; url?: string }>;
	  };

type CapabilityConfig = {
	permissions?: CapabilityPermission[];
};

type TauriConfig = {
	app?: {
		security?: {
			assetProtocol?: {
				scope?: string[];
			};
		};
	};
};

function readJson<T>(relativePath: string) {
	return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")) as T;
}

test("desktop capability does not expose broad renderer filesystem or path opener access", () => {
	const capability = readJson<CapabilityConfig>("src-tauri/capabilities/default.json");
	const permissions = capability.permissions || [];
	const identifiers = permissions.map((permission) =>
		typeof permission === "string" ? permission : permission.identifier || ""
	);

	assert.equal(identifiers.includes("fs:read-all"), false);
	assert.equal(identifiers.includes("fs:write-all"), false);
	assert.equal(identifiers.includes("fs:scope"), false);
	assert.equal(identifiers.includes("fs:allow-watch"), false);
	assert.equal(identifiers.includes("opener:default"), false);
	assert.equal(identifiers.includes("opener:allow-open-path"), false);
	assert.equal(identifiers.includes("opener:allow-reveal-item-in-dir"), false);
	assert.ok(identifiers.includes("fs:allow-read-text-file"));
	assert.ok(identifiers.includes("fs:allow-write-text-file"));
	assert.ok(identifiers.includes("opener:allow-default-urls"));
});

test("INI state sync uses a native persisted-config watcher instead of renderer fs watch", () => {
	const renderer = readFileSync(new URL("../src/utils/iniStateSync.ts", import.meta.url), "utf8");
	const native = readFileSync(new URL("../src-tauri/src/ini_watcher.rs", import.meta.url), "utf8");

	assert.doesNotMatch(renderer, /@tauri-apps\/plugin-fs/);
	assert.match(renderer, /invoke<string>\("start_ini_state_watch", \{ game \}\)/);
	assert.match(renderer, /listen<\{ path\?: string \}>\("ini-state-changed"/);
	assert.match(native, /config_dir\.join\(format!\("config\{game\}\.json"\)\)/);
	assert.match(native, /RecursiveMode::NonRecursive/);
	assert.match(native, /event_touches_ini/);
});

test("renderer does not call the generic path opener directly", () => {
	const sourceFiles = [
		"src/_Main/MainLocal.tsx",
		"src/_RightSidebar/RightLocal.tsx",
		"src/_LeftSidebar/components/Batch.tsx",
		"src/utils/filesys.ts",
		"src/utils/wuwaModFixer.ts",
	];
	for (const sourceFile of sourceFiles) {
		const source = readFileSync(new URL(`../${sourceFile}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /@tauri-apps\/plugin-opener/);
		assert.doesNotMatch(source, /\bopenPath\s*\(/);
	}
});

test("asset protocol scope is limited to the manager-controlled preview cache", () => {
	const tauriConfig = readJson<TauriConfig>("src-tauri/tauri.conf.json");
	const scope = tauriConfig.app?.security?.assetProtocol?.scope || [];

	assert.deepEqual(scope, ["$APPLOCALDATA/preview-cache/**"]);
});

test("desktop capability does not expose renderer HTTP access", () => {
	const capability = readJson<CapabilityConfig>("src-tauri/capabilities/default.json");
	const permissions = capability.permissions || [];
	assert.equal(
		permissions.some(
			(permission) =>
				permission === "http:default" || (typeof permission !== "string" && permission.identifier?.startsWith("http:"))
		),
		false
	);
});
