import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readInitSource() {
	const sourcePath = new URL("../src/utils/init.ts", import.meta.url);
	return readFileSync(sourcePath, "utf8");
}

test("app startup does not await update checks before finishing initialization", () => {
	const source = readInitSource();
	const initDoneIndex = source.indexOf("isInitialized = true;");
	const fireAndForgetIndex = source.indexOf("void refreshAppUpdateCheck(false);");
	const awaitedIndex = source.indexOf("await refreshAppUpdateCheck(false);");

	assert.equal(awaitedIndex, -1, "startup should not await updater checks");
	assert.notEqual(fireAndForgetIndex, -1, "startup should trigger updater checks in the background");
	assert.notEqual(initDoneIndex, -1, "expected init.ts to mark initialization complete");
	assert.ok(
		fireAndForgetIndex > initDoneIndex,
		"background updater check should run only after initialization completes"
	);
});

test("game config initialization rewrites stale saved config versions", () => {
	const source = readInitSource();
	const mergeIndex = source.indexOf("...savedConfig,");
	const versionIndex = source.indexOf("version: VERSION,", mergeIndex);
	const gameIndex = source.indexOf("game,", mergeIndex);

	assert.notEqual(mergeIndex, -1, "expected initGame to merge saved game config");
	assert.notEqual(versionIndex, -1, "saved game config version should be replaced with the app version");
	assert.ok(versionIndex > mergeIndex, "version override must happen after spreading savedConfig");
	assert.ok(gameIndex > versionIndex, "version override should stay in the initGame config object");
});
