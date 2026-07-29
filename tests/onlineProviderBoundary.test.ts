import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("GameBanana JSON requests cross the Rust provider boundary", () => {
	const rustSource = readSource("src-tauri/src/lib.rs");
	const mainOnlineSource = readSource("src/_Main/MainOnline.tsx");
	const apiSource = readSource("src/utils/api.ts");

	assert.match(rustSource, /fn fetch_gamebanana_json/);
	assert.match(rustSource, /4 \* 1024 \* 1024/);
	assert.match(rustSource, /gamebanana\.com/);
	assert.match(mainOnlineSource, /invoke<unknown>\("fetch_gamebanana_json"/);
	assert.doesNotMatch(mainOnlineSource, /plugin-http/);
	assert.match(apiSource, /invoke<[^>]+>\("fetch_gamebanana_json"/);
});
