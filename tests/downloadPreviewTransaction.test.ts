import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("online Mod downloads require preview preparation before the native install completes", () => {
	const downloads = readSource("src/_LeftSidebar/components/Downloads.tsx");
	const rust = readSource("src-tauri/src/lib.rs");

	assert.match(downloads, /invoke(?:<[^>]+>)?\("download_and_unzip", \{[\s\S]*previewUrl: item\.preview \|\| null/);
	assert.match(downloads, /installState: \{[\s\S]*expectedDataEntry/);
	assert.match(downloads, /acceptCommittedAppConfigSnapshot\(snapshot, game\)/);
	assert.match(downloads, /validateGameBananaDownloadIdentity\(item\)[\s\S]*createModDownloadTarget/);
	assert.match(downloads, /if \(type === "auto"\) \{[\s\S]*native command publishes[\s\S]*return;\s*\} else \{/);
	assert.doesNotMatch(downloads, /link_preview_/);
	assert.match(rust, /async fn prepare_install_preview/);
	assert.match(rust, /GameBanana preview failed after 3 attempts/);
	assert.match(rust, /normalize_staged_mod_root\(staging_path\)/);
	assert.match(rust, /install_required_preview\(staging_path, required_preview\)/);
	assert.match(rust, /stage: if last_error[\s\S]*contains\("preview"\)/);
	assert.match(rust, /operation: "gamebanana_download"/);
	assert.match(rust, /prepare_gamebanana_download_state/);
	assert.match(rust, /resolve_post_install_staging_cleanup\([\s\S]*extraction_snapshot\.is_some\(\)/);
});

test("historical preview backfill uses its audited game and the transactional native command", () => {
	const source = readSource("src/utils/linkIntegrity.ts");
	const rust = readSource("src-tauri/src/lib.rs");

	assert.match(source, /async function fetchPreviewUrl\(game: Games, source: string\)/);
	assert.match(source, /getGameBananaProvider\(game\)\.mod\(route\)/);
	assert.match(source, /invoke\("backfill_mod_preview", \{/);
	assert.doesNotMatch(source, /PREVIEW_DELAY_MS/);
	assert.match(rust, /async fn backfill_mod_preview/);
	assert.match(rust, /stage_and_deploy_generic_preview/);
	assert.match(rust, /deploy_downloaded_nte_preview/);
});

test("manual GameBanana binding commits metadata and preview through one native transaction", () => {
	const rightOnline = readSource("src/_RightSidebar/RightOnline.tsx");
	const repository = readSource("src/utils/appConfigRepository.ts");
	const rust = readSource("src-tauri/src/lib.rs");

	assert.match(rightOnline, /await saveGameBananaBinding\(game, selectedLinkPath, itemPreviewUrl, nextData\)/);
	assert.doesNotMatch(rightOnline, /backfill_mod_preview/);
	assert.match(repository, /invoke<AppConfigSnapshot>\("bind_gamebanana_mod"/);
	assert.match(rust, /async fn bind_gamebanana_mod/);
	assert.match(rust, /operation: "gamebanana_binding"/);
	assert.match(rust, /before_game_config_hash/);
	assert.match(rust, /deploy_staged_directory_with_commit/);
});
