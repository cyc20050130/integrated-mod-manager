import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readSource(path: string) {
	return readFileSync(new URL("../" + path, import.meta.url), "utf8");
}

test("default XXMI discovery is fixed-purpose and checks direct plus sibling candidates", () => {
	const init = readSource("src/utils/init.ts");
	const native = readSource("src-tauri/src/managed_text.rs");

	assert.match(init, /invoke<string \| null>\("discover_xxmi_launcher_dir"\)/);
	assert.doesNotMatch(init, /getDefaultXxmiDirCandidatesFromAppData|pathExistsNative/);
	assert.match(native, /let mut candidates = vec!\[app_data\.join\("XXMI Launcher"\)\]/);
	assert.match(native, /candidates\.push\(parent\.join\("XXMI Launcher"\)\)/);
	assert.match(native, /for candidate in candidates/);
	assert.match(native, /safe_configured_root\(&candidate\.to_string_lossy\(\), "XXMI Launcher candidate"\)/);
});
