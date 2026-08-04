import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("renderer has no generic text-write or save-dialog capability", () => {
	const capability = read("src-tauri/capabilities/default.json");
	const backend = read("src-tauri/src/lib.rs");
	const renderer = [
		read("src/utils/filesys.ts"),
		read("src/utils/init.ts"),
		read("src/utils/hotreload.ts"),
		read("src/utils/linkIntegrity.ts"),
		read("src/utils/utils.ts"),
	].join("\n");

	assert.doesNotMatch(capability, /fs:allow-write-text-file/);
	assert.doesNotMatch(capability, /fs:default/);
	assert.doesNotMatch(capability, /fs:allow-rename/);
	assert.doesNotMatch(capability, /dialog:allow-save/);
	assert.doesNotMatch(backend, /fn write_text_file_native\(/);
	assert.doesNotMatch(backend, /write_text_file_native,/);
	assert.doesNotMatch(renderer, /write_text_file_native/);
	assert.doesNotMatch(renderer, /writeTextFile as|\bwriteTextFile\s*\(/);
	assert.doesNotMatch(renderer, /\bwriteFile\s*\(/);
	assert.doesNotMatch(renderer, /@tauri-apps\/plugin-dialog["'];[\s\S]*\bsave\s*\(/);
});

test("application reset is a typed repository transaction", () => {
	const backend = read("src-tauri/src/app_state.rs");
	const renderer = read("src/utils/filesys.ts");

	assert.match(renderer, /await invoke\("reset_app_state_with_backup"\)/);
	assert.doesNotMatch(renderer, /MAN_\$\{Date\.now\(\)\}_config|\brename\s*\(/);
	assert.match(backend, /pub\(crate\) fn reset_with_backup\(&self\)/);
	assert.match(backend, /reset_backups_root/);
	assert.match(backend, /if let Some\(pointer\) = &before/);
	assert.match(backend, /backup_legacy_configs\(&self\.paths, "recovery-reset"\)/);
	assert.match(backend, /let committed = commit_state\(&self\.paths, &mut journal, reset_state\)\?/);
});

test("managed text writes are purpose-bound and reject path aliases", () => {
	const backend = read("src-tauri/src/managed_text.rs");
	const renderer = read("src/utils/filesys.ts");

	for (const purpose of [
		"D3dxUserIni",
		"ModMetadata",
		"PresetExport",
		"CollisionChecklist",
		"ModPreference",
		"ModIni",
	]) {
		assert.match(backend, new RegExp(purpose));
	}
	assert.match(backend, /metadata_is_reparse/);
	assert.match(backend, /GetFileInformationByHandle/);
	assert.match(backend, /nNumberOfLinks > 1/);
	assert.match(backend, /canonical\.starts_with\(root\)/);
	assert.match(renderer, /invoke<void>\("write_managed_text_asset", \{/);
	const invocation = /invoke<void>\("write_managed_text_asset",\s*\{([\s\S]*?)\}\);/.exec(renderer);
	assert.ok(invocation);
	assert.doesNotMatch(invocation[1], /\bpath:/);
});

test("JSON exports select and validate the destination in Rust", () => {
	const backend = read("src-tauri/src/managed_text.rs");
	const linkAudit = read("src/utils/linkIntegrity.ts");
	const utils = read("src/utils/utils.ts");

	assert.match(backend, /blocking_save_file\(\)/);
	assert.match(backend, /Exports cannot replace files in an IMM-controlled directory/);
	assert.match(backend, /JSON exports must use the \.json extension/);
	assert.match(linkAudit, /invoke<boolean>\("export_json_document", \{\s*kind: "linkAudit"/s);
	assert.match(utils, /invoke<boolean>\("export_json_document", \{\s*kind: "gameConfig"/s);
});

test("JSON imports are selected and bounded in Rust without exposing a path", () => {
	const backend = read("src-tauri/src/managed_text.rs");
	const settings = read("src/_LeftSidebar/components/Settings.tsx");
	const errorBoundary = read("src/utils/errorCatcher.tsx");

	assert.match(backend, /blocking_pick_file\(\)/);
	assert.match(backend, /FollowSymlinks::No/);
	assert.match(backend, /open_file_has_multiple_links\(&file\)\?/);
	assert.match(backend, /MAX_JSON_IMPORT_BYTES/);
	assert.match(backend, /Configuration import must contain a JSON object/);
	assert.match(settings, /invoke<string \| null>\("pick_json_import_document"\)/);
	assert.doesNotMatch(settings, /@tauri-apps\/plugin-fs/);
	assert.doesNotMatch(settings, /const filePath = await open/);
	assert.doesNotMatch(errorBoundary, /Import Config|readTextFile|getManagedConfigTarget/);
});
