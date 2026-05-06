import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readFileText(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("XXMI config and importer file access use native invoke commands instead of plugin-fs direct reads", () => {
	const initSource = readFileText("src/utils/init.ts");

	assert.match(initSource, /invoke<string>\("read_text_file_native"/);
	assert.match(initSource, /invoke<boolean>\("path_exists_native"/);
	assert.doesNotMatch(initSource, /readTextFile\(join\(path, "XXMI Launcher Config\.json"\)\)/);
});

test("tauri backend exposes native file io commands used by XXMI integration", () => {
	const rustSource = readFileText("src-tauri/src/lib.rs");

	assert.match(rustSource, /fn path_exists_native\(/);
	assert.match(rustSource, /fn read_text_file_native\(/);
	assert.match(rustSource, /path_exists_native,/);
	assert.match(rustSource, /read_text_file_native,/);
});
