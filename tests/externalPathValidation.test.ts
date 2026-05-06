import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readInitSource() {
	return readFileSync(new URL("../src/utils/init.ts", import.meta.url), "utf8");
}

test("source and target directory validation use native path checks for external XXMI locations", () => {
	const source = readInitSource();

	assert.match(source, /configXX\.sourceDir && !\(await pathExistsNative\(join\(configXX\.sourceDir\)\)\)/);
	assert.match(source, /configXX\.targetDir && !\(await pathExistsNative\(configXX\.targetDir\)\)\)/);
});
