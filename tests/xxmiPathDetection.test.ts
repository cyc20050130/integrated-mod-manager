import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readInitSource() {
	return readFileSync(new URL("../src/utils/init.ts", import.meta.url), "utf8");
}

test("default XXMI discovery tests both direct and sibling Roaming candidates", () => {
	const source = readInitSource();

	assert.match(source, /function getDefaultXxmiDirCandidatesFromAppData\(/);
	assert.match(source, /const directCandidate = join\(normalized, "XXMI Launcher"\)/);
	assert.match(source, /parentParts\.length \? join\(\.\.\.parentParts, "XXMI Launcher"\) : ""/);
	assert.match(source, /for \(const candidate of xxmiCandidates\)/);
	assert.match(source, /if \(await pathExistsNative\(candidate\)\)/);
});
