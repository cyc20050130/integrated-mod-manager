import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("GameBanana JSON requests cross the Rust provider boundary", () => {
	const rustSource = readSource("src-tauri/src/lib.rs");
	const remoteMediaSource = readSource("src-tauri/src/remote_media.rs");
	const mainOnlineSource = readSource("src/_Main/MainOnline.tsx");
	const apiSource = readSource("src/utils/api.ts");

	assert.match(rustSource, /fn fetch_gamebanana_json/);
	assert.match(rustSource, /struct GameBananaHttpState/);
	assert.match(rustSource, /\.manage\(GameBananaHttpState::new\(\)\)/);
	assert.match(rustSource, /fn cancel_gamebanana_request/);
	assert.match(rustSource, /4 \* 1024 \* 1024/);
	assert.match(rustSource, /gamebanana\.com/);
	assert.match(apiSource, /const requestId = createRequestId\(\)/);
	assert.match(apiSource, /invoke\("cancel_gamebanana_request", \{ requestId \}\)/);
	assert.match(apiSource, /invoke<T>\("fetch_gamebanana_json", \{ url, requestId \}\)/);
	assert.match(mainOnlineSource, /fetchGameBananaJson<OnlineListResponse>\(url, signal\)/);
	assert.doesNotMatch(mainOnlineSource, /invoke\(/);
	assert.doesNotMatch(mainOnlineSource, /plugin-http/);
	assert.doesNotMatch(rustSource, /GenericHttps|api\.hakush\.in/);
	assert.doesNotMatch(remoteMediaSource, /"api\.hakush\.in"\s*=>/);
	assert.doesNotMatch(apiSource, /api\.hakush\.in/);
	assert.match(rustSource, /GameBanana download metadata is missing a positive file size/);
	assert.match(rustSource, /GameBanana download metadata is missing a valid MD5 checksum/);
});
