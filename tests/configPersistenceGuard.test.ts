import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readFileText(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("saveConfigs is guarded until runtime initialization completes", () => {
	const filesysSource = readFileText("src/utils/filesys.ts");

	assert.match(filesysSource, /export async function saveConfigs\(/);
	assert.match(filesysSource, /if \(!isAppInitialized\(\)\) return;/);
	assert.match(filesysSource, /await persistConfigs\(\{ settings \}, skip\);/);
});

test("health check persistence flows through saveConfigs instead of direct config writes", () => {
	const apiSource = readFileText("src/utils/api.ts");

	assert.match(apiSource, /saveConfigs\(\)/);
	assert.doesNotMatch(apiSource, /writeTextFile\(\s*["'`]config\.json["'`]/);
});
