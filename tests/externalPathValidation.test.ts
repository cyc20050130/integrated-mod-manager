import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readInitSource() {
	return readFileSync(new URL("../src/utils/init.ts", import.meta.url), "utf8");
}

test("source and target directory validation uses persisted managed roots", () => {
	const source = readInitSource();

	assert.match(source, /invoke<boolean>\("managed_path_exists", \{ game, rootKind, relativePath: "" \}\)/);
	assert.match(source, /configXX\.sourceDir && !\(await managedGameRootExists\(game, "source"\)\)/);
	assert.match(source, /configXX\.targetDir && !\(await managedGameRootExists\(game, "target"\)\)/);
	assert.doesNotMatch(source, /pathExistsNative|path_exists_native/);
});
