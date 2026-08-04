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
	assert.equal(identifiers.includes("fs:default"), false);
	assert.equal(identifiers.includes("fs:allow-rename"), false);
	assert.equal(identifiers.includes("opener:default"), false);
	assert.equal(identifiers.includes("opener:allow-open-path"), false);
	assert.equal(identifiers.includes("opener:allow-reveal-item-in-dir"), false);
	assert.equal(
		identifiers.some((identifier) => identifier.startsWith("fs:")),
		false
	);
	assert.equal(identifiers.includes("fs:allow-write-text-file"), false);
	assert.equal(identifiers.includes("dialog:allow-save"), false);
	assert.ok(identifiers.includes("opener:allow-default-urls"));
});

test("renderer filesystem access is mediated by typed Rust commands", () => {
	const backend = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
	const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
	const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
	const packageJson = readJson<{ dependencies?: Record<string, string> }>("package.json");

	assert.doesNotMatch(backend, /tauri_plugin_fs::init/);
	assert.doesNotMatch(cargo, /tauri-plugin-fs/);
	assert.doesNotMatch(vite, /@tauri-apps\/plugin-fs/);
	assert.equal(packageJson.dependencies?.["@tauri-apps/plugin-fs"], undefined);
	for (const command of [
		"path_exists_native",
		"read_text_file_native",
		"read_dir_native",
		"mkdir_native",
		"guarded_remove_path",
		"guarded_rename_path",
		"guarded_copy_file_path",
		"guarded_import_file_path",
	]) {
		assert.doesNotMatch(backend, new RegExp(`fn ${command}\\(`));
		assert.doesNotMatch(backend, new RegExp(`${command},`));
	}
	assert.match(backend, /managed_fs::managed_path_exists,/);
	assert.match(backend, /managed_fs::read_managed_dir,/);
	assert.match(backend, /managed_text::pick_json_import_document,/);
});

test("desktop capability exposes only the window and webview mutations used by the main UI", () => {
	const capability = readJson<CapabilityConfig>("src-tauri/capabilities/default.json");
	const identifiers = (capability.permissions || []).map((permission) =>
		typeof permission === "string" ? permission : permission.identifier || ""
	);

	assert.equal(identifiers.includes("core:default"), false);
	assert.equal(identifiers.includes("core:window:default"), false);
	assert.equal(identifiers.includes("core:webview:default"), false);
	assert.equal(identifiers.includes("core:webview:allow-create-webview"), false);
	assert.equal(identifiers.includes("core:webview:allow-create-webview-window"), false);
	assert.equal(identifiers.includes("core:webview:allow-print"), false);
	assert.equal(identifiers.includes("core:webview:allow-reparent"), false);
	assert.equal(identifiers.includes("core:menu:default"), false);
	assert.equal(identifiers.includes("core:tray:default"), false);
	assert.equal(identifiers.includes("core:event:allow-emit"), false);
	assert.ok(identifiers.includes("core:window:allow-close"));
	assert.ok(identifiers.includes("core:window:allow-minimize"));
	assert.ok(identifiers.includes("core:window:allow-toggle-maximize"));
	assert.ok(identifiers.includes("core:webview:allow-set-webview-focus"));
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

test("renderer cannot launch arbitrary executables or arguments", () => {
	const backend = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
	const autolaunch = readFileSync(new URL("../src/utils/autolaunch.ts", import.meta.url), "utf8");
	const fixer = readFileSync(new URL("../src/utils/wuwaModFixer.ts", import.meta.url), "utf8");
	const packageJson = readJson<{ dependencies?: Record<string, string> }>("package.json");

	assert.doesNotMatch(backend, /fn execute_with_args\(/);
	assert.doesNotMatch(backend, /execute_with_args,/);
	assert.match(backend, /fn launch_configured_xxmi\(/);
	assert.match(backend, /fn launch_bundled_wuwa_mod_fixer\(/);
	assert.doesNotMatch(autolaunch, /exePath|args:/);
	assert.doesNotMatch(fixer, /executeWithArgs/);
	assert.equal(packageJson.dependencies?.["@tauri-apps/plugin-shell"], undefined);
});
