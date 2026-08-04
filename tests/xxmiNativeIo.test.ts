import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readFileText(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("XXMI config and importer access use fixed-purpose commands", () => {
	const initSource = readFileText("src/utils/init.ts");

	assert.match(initSource, /invoke<XxmiLauncherConfigDocument>\("read_xxmi_launcher_config"/);
	assert.match(initSource, /invoke<string>\("read_xxmi_importer_d3dx"/);
	assert.match(initSource, /invoke<string \| null>\("discover_xxmi_launcher_dir"/);
	assert.match(initSource, /invoke<void>\("write_xxmi_launcher_config", \{ contents:/);
	assert.doesNotMatch(initSource, /_native/);
	assert.doesNotMatch(initSource, /@tauri-apps\/plugin-fs/);
	assert.doesNotMatch(initSource, /readTextFile\(join\(path, "XXMI Launcher Config\.json"\)\)/);
});

test("tauri backend exposes only typed filesystem commands", () => {
	const rustSource = readFileText("src-tauri/src/lib.rs");

	assert.doesNotMatch(rustSource, /fn path_exists_native\(/);
	assert.doesNotMatch(rustSource, /fn read_text_file_native\(/);
	assert.doesNotMatch(rustSource, /fn read_dir_native\(/);
	assert.doesNotMatch(rustSource, /fn mkdir_native\(/);
	assert.doesNotMatch(rustSource, /guarded_(remove|rename|copy|import)/);
	assert.match(rustSource, /managed_fs::managed_path_exists,/);
	assert.match(rustSource, /managed_fs::read_managed_dir,/);
	assert.match(rustSource, /managed_text::write_xxmi_launcher_config,/);
});

test("directory verification resolves persisted roots through managed IPC", () => {
	const filesysSource = readFileText("src/utils/filesys.ts");

	assert.match(filesysSource, /invoke<DirEntry\[]>\("read_managed_dir"/);
	assert.match(filesysSource, /invoke<void>\("create_managed_dir"/);
	assert.match(filesysSource, /function getManagedPathIdentity\(path: string\)/);
	assert.match(filesysSource, /Path is outside the persisted game roots/);
	assert.doesNotMatch(filesysSource, /plugin fs/);
	assert.doesNotMatch(filesysSource, /allowedRoots/);
});
