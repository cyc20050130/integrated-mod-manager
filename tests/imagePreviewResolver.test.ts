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
