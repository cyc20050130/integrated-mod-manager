import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readInitSource() {
	return readFileSync(new URL("../src/utils/init.ts", import.meta.url), "utf8");
}

test("default XXMI discovery targets the Roaming sibling directory instead of the app-specific data folder", () => {
	const source = readInitSource();

	assert.match(source, /function getDefaultXxmiDirFromAppData\(/);
	assert.match(source, /\.split\("\\\\"\)/);
	assert.match(source, /\.slice\(0, -1\)/);
	assert.match(source, /join\(\.\.\.parentParts, "XXMI Launcher"\)/);
});
