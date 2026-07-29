import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("archive extraction is ZIP-only and no longer invokes external 7z/RAR code", () => {
	const cargo = readSource("src-tauri/Cargo.toml");
	const rust = readSource("src-tauri/src/lib.rs");
	const localSidebar = readSource("src/_RightSidebar/RightLocal.tsx");

	assert.doesNotMatch(cargo, /^unrar\s*=/m);
	assert.doesNotMatch(cargo, /^sevenz-rust2\s*=/m);
	assert.doesNotMatch(rust, /ext[\\/]7z\.exe|ShellExt|decompress_file/);
	assert.match(rust, /ZipArchive/);
	assert.match(rust, /enclosed_name/);
	assert.match(rust, /200/);
	assert.match(rust, /enforce_archive_game_boundary\(game\.as_deref\(\), is_nte_archive\)\?/);
	assert.match(rust, /persisted_nte_library_root_for_destination\(&config_dir, save_path\)\?/);
	assert.match(rust, /NTE archive destination is outside the persisted managed library/);
	assert.doesNotMatch(localSidebar, /\.7z\/\.zip\/\.rar/);
	assert.match(localSidebar, /extensions: \["zip"\]/);
});
