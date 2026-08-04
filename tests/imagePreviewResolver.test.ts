import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("desktop startup no longer owns the legacy loopback image server", () => {
	const tauriLib = readSource("src-tauri/src/lib.rs");
	const cargoToml = readSource("src-tauri/Cargo.toml");
	const sources = [
		tauriLib,
		readSource("src/utils/init.ts"),
		readSource("src/utils/utils.ts"),
		readSource("src/utils/consts.ts"),
		readSource("src-tauri/capabilities/default.json"),
	].join("\n");

	assert.doesNotMatch(sources, /127\.0\.0\.1:1469|localhost:1469/);
	assert.doesNotMatch(sources, /image_server|IMAGE_SERVER|get_image_server_url|setImageServer/);
	assert.doesNotMatch(cargoToml, /^warp\s*=|^mime_guess\s*=/m);
	assert.doesNotMatch(tauriLib, /get_webview_window\("main"\)\.unwrap\(\)/);
	assert.doesNotMatch(tauriLib, /\.expect\("error while running tauri application"\)/);
	assert.equal(existsSync(new URL("../src-tauri/src/image_server.rs", import.meta.url)), false);
});

test("local preview URLs use Tauri asset conversion for the complete resolved path", async () => {
	const moduleUrl = new URL("../src/utils/imagePreview.ts", import.meta.url);
	assert.ok(existsSync(moduleUrl), "expected the local preview resolver module");

	const { resolvePreviewAssetUrl } = await import("../src/utils/imagePreview.ts");
	const windowsPath = "C:\\Users\\Test User\\AppData\\Local\\jp.bhatt.wwmm\\preview-cache\\中文 preview.webp";
	const calls: string[] = [];
	const result = resolvePreviewAssetUrl(windowsPath, (path) => {
		calls.push(path);
		return `asset://${encodeURIComponent(path)}`;
	});

	assert.deepEqual(calls, [windowsPath]);
	assert.equal(result, `asset://${encodeURIComponent(windowsPath)}`);
});

test("visible preview resolution is deduplicated, batched, and concurrency bounded", async () => {
	const { createPreviewAssetManager } = await import("../src/utils/imagePreview.ts");
	const calls: string[][] = [];
	let active = 0;
	let maxActive = 0;
	const manager = createPreviewAssetManager(
		async (_sourceRoot, paths) => {
			calls.push(paths);
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			active -= 1;
			return paths.map((key) => ({ key, path: `C:\\preview-cache\\${key.replaceAll("\\", "-")}.jpg` }));
		},
		(path) => `asset://${path}`
	);
	const game = "WW";
	const paths = Array.from({ length: 40 }, (_, index) => `Characters\\Mod-${index}`);

	manager.beginGeneration(game);
	manager.requestVisible(game, [...paths, paths[0], paths[1]]);
	manager.requestVisible(game, paths.slice(0, 10));
	await manager.waitForIdle();

	assert.deepEqual(
		calls.map((batch) => batch.length),
		[16, 16, 8]
	);
	assert.equal(maxActive, 2);
	assert.match(manager.getAssetUrl(game, paths[0]), /^asset:\/\/C:\\preview-cache\\Characters-Mod-0\.jpg\?v=1$/);
});

test("preview generations discard stale source results and preserve source isolation", async () => {
	const { createPreviewAssetManager } = await import("../src/utils/imagePreview.ts");
	const completions: Array<(value: Array<{ key: string; path: string }>) => void> = [];
	const manager = createPreviewAssetManager(
		(_sourceRoot, _paths) =>
			new Promise((resolve) => {
				completions.push(resolve);
			}),
		(path) => `asset://${path}`
	);
	const path = "Characters\\SharedName";

	manager.beginGeneration("WW");
	manager.requestVisible("WW", [path]);
	manager.beginGeneration("NTE");
	manager.requestVisible("NTE", [path]);
	assert.equal(completions.length, 2);

	completions[0]([{ key: path, path: "C:\\preview-cache\\ww.jpg" }]);
	completions[1]([{ key: path, path: "C:\\preview-cache\\nte.jpg" }]);
	await manager.waitForIdle();

	assert.equal(manager.getAssetUrl("WW", path), "");
	assert.equal(manager.getAssetUrl("NTE", path), "asset://C:\\preview-cache\\nte.jpg?v=1");
});

test("preview updates notify only the card whose asset changed", async () => {
	const { createPreviewAssetManager } = await import("../src/utils/imagePreview.ts");
	const manager = createPreviewAssetManager(
		async (_sourceRoot, paths) => paths.map((key) => ({ key, path: `C:\\preview-cache\\${key}.jpg` })),
		(path) => `asset://${path}`
	);
	const game = "WW";
	let firstNotifications = 0;
	let secondNotifications = 0;
	manager.beginGeneration(game);
	const unsubscribeFirst = manager.subscribe(game, "first", () => {
		firstNotifications += 1;
	});
	const unsubscribeSecond = manager.subscribe(game, "second", () => {
		secondNotifications += 1;
	});

	manager.requestVisible(game, ["first", "second"]);
	await manager.waitForIdle();
	assert.equal(firstNotifications, 1);
	assert.equal(secondNotifications, 1);

	await manager.update(game, "first");
	assert.equal(firstNotifications, 2);
	assert.equal(secondNotifications, 1);
	unsubscribeFirst();
	unsubscribeSecond();
});

test("local mod refresh and rendering stay independent from full preview resolution", () => {
	const filesys = readSource("src/utils/filesys.ts");
	const imagePreview = readSource("src/utils/imagePreview.ts");
	const tauriLib = readSource("src-tauri/src/lib.rs");
	const refreshStart = filesys.indexOf("export async function refreshModList()");
	const refreshEnd = filesys.indexOf("export async function createModDownloadDir", refreshStart);
	const refresh = filesys.slice(refreshStart, refreshEnd);
	const mainLocal = readSource("src/_Main/MainLocal.tsx");
	const cardLocal = readSource("src/_Main/components/CardLocal.tsx");

	assert.match(refresh, /beginPreviewGeneration\(store\.get\(GAME\)\)/);
	assert.doesNotMatch(refresh, /await\s+.*Preview|refreshPreviewAssets/);
	assert.match(mainLocal, /useVirtualizer<.*>\(/);
	assert.match(mainLocal, /requestVisiblePreviewAssets\(game, visiblePreviewPaths\)/);
	assert.doesNotMatch(mainLocal, /visibleRange|onScroll=|0\.05\s*\*\s*index|filteredList\.map\(/);
	assert.match(cardLocal, /usePreviewAssetUrl\(game, item\.path\)/);
	assert.match(imagePreview, /invoke<ResolvedPreviewAsset\[\]>\("resolve_preview_assets", \{\s*game,/s);
	assert.doesNotMatch(imagePreview, /sourceRoot,/);
	assert.match(tauriLib, /persisted_managed_source_root\(repository\.runtime_root\(\), &game\)/);
});

test("asset scope exposes only the managed preview cache without renderer HTTP permissions", () => {
	const tauriConfig = JSON.parse(readSource("src-tauri/tauri.conf.json")) as {
		app?: { security?: { assetProtocol?: { scope?: string[] } } };
	};
	const capability = JSON.parse(readSource("src-tauri/capabilities/default.json")) as {
		permissions?: Array<string | { identifier?: string; allow?: Array<{ url?: string }> }>;
	};
	const assetScope = tauriConfig.app?.security?.assetProtocol?.scope || [];
	const httpPermission = capability.permissions?.find(
		(permission) => typeof permission !== "string" && permission.identifier === "http:default"
	);
	assert.deepEqual(assetScope, ["$APPLOCALDATA/preview-cache/**"]);
	assert.equal(httpPermission, undefined);
});
