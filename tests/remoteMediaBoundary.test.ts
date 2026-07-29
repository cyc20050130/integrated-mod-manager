import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("remote media paths are resolved through a native cache before asset conversion", async () => {
	const moduleUrl = new URL("../src/utils/remoteMedia.ts", import.meta.url);
	assert.ok(existsSync(moduleUrl), "expected the remote media resolver module");
	const { isRemoteMediaSource, resolveRemoteMediaAssetUrl } = await import("../src/utils/remoteMedia.ts");

	assert.equal(isRemoteMediaSource("https://images.gamebanana.com/img/demo.png"), true);
	assert.equal(isRemoteMediaSource("http://images.gamebanana.com/img/demo.png"), false);
	assert.equal(isRemoteMediaSource("/who.jpg"), false);
	assert.equal(
		resolveRemoteMediaAssetUrl("C:\\cache\\abc.png", (path) => `asset://${path}`),
		"asset://C:\\cache\\abc.png"
	);
});

test("renderer remote media and health requests cross narrow Rust commands", () => {
	const rust = readSource("src-tauri/src/lib.rs");
	const remoteMedia = readSource("src/utils/remoteMedia.ts");
	const api = readSource("src/utils/api.ts");
	const modPreview = readSource("src/_RightSidebar/components/ModPreview.tsx");

	assert.match(rust, /remote_media::resolve_remote_media/);
	assert.match(rust, /service_health_check/);
	assert.match(remoteMedia, /invoke<string>\("resolve_remote_media"/);
	assert.doesNotMatch(api, /\bfetch\s*\(/);
	assert.doesNotMatch(modPreview, /\bfetch\s*\(/);
	assert.match(readSource("src-tauri/src/remote_media.rs"), /Health check response is not JSON/);
});

test("RemoteImage derives fallback state per request without synchronous effect resets", () => {
	const component = readSource("src/components/RemoteImage.tsx");
	assert.match(component, /resolved\?\.key === requestKey/);
	assert.doesNotMatch(component, /if \(!isRemoteMediaSource\(source\)\) \{\s*set/s);
});

test("renderer HTTP plugin is removed from dependencies, registration, and capabilities", () => {
	const sources = [
		readSource("package.json"),
		readSource("vite.config.ts"),
		readSource("src-tauri/Cargo.toml"),
		readSource("src-tauri/src/lib.rs"),
		readSource("src-tauri/capabilities/default.json"),
	].join("\n");

	assert.doesNotMatch(sources, /tauri-plugin-http|plugin_http|@tauri-apps\/plugin-http|http:default/);
});

test("untrusted HTML cannot create remote media elements", () => {
	const sanitizer = readSource("src/utils/sanitizeHtml.ts");
	assert.match(sanitizer, /FORBID_TAGS/);
	assert.match(sanitizer, /["']img["']/);
	assert.match(sanitizer, /["']picture["']/);
	assert.match(sanitizer, /["']source["']/);
});

test("online cards, carousel, and details render through RemoteImage", () => {
	for (const path of [
		"src/_Main/components/CardOnline.tsx",
		"src/_Main/components/Carousel.tsx",
		"src/_RightSidebar/RightOnline.tsx",
	]) {
		const source = readSource(path);
		assert.match(source, /RemoteImage/, path);
	}
});
