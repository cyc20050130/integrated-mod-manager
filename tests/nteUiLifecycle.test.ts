import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { shouldAcceptNteConfigSaveResponse } from "../src/utils/nteConfigRevision.ts";

function readSource(relativePath: string) {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function sourceBetween(source: string, start: string, end: string) {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	assert.notEqual(startIndex, -1, `missing source boundary: ${start}`);
	assert.notEqual(endIndex, -1, `missing source boundary: ${end}`);
	return source.slice(startIndex, endIndex);
}

test("NTE checklist selection bypasses XXMI onboarding", () => {
	const page2 = readSource("src/_Checklist/pages/Page2.tsx");
	const page3 = readSource("src/_Checklist/pages/Page3.tsx");

	assert.match(page2, /switchGame\("NTE"\)/);
	assert.match(page2, /GAME_NAMES\.NTE/);
	assert.match(page3, /if \(game === "NTE"\)/);
	assert.ok(
		page3.indexOf('if (game === "NTE")') < page3.indexOf('invoke("get_username")'),
		"NTE must leave Page3 before the legacy XXMI onboarding path"
	);
});

test("NTE checklist revalidates a persisted mods root before completing onboarding", () => {
	const page3 = readSource("src/_Checklist/pages/Page3.tsx");

	assert.match(
		page3,
		/invoke<NteGameRootValidation>\("validate_nte_mods_root", \{\s*modsRoot: tgt,\s*region: nteRegion === "auto" \? null : nteRegion,\s*\}\)/s
	);
	assert.match(page3, /setPage\(validation\.valid \? 4 : 3\)/);
	assert.doesNotMatch(page3, /if \(game === "NTE" && src && tgt\) \{\s*setPage\(4\);/s);
});

test("NTE path setup validates a selected game root and persists the resolved region", () => {
	const page4 = readSource("src/_Checklist/pages/Page4.tsx");
	const filesys = readSource("src/utils/filesys.ts");
	const init = readSource("src/utils/init.ts");
	const types = readSource("src/utils/types.ts");
	const defaults = JSON.parse(readSource("src/defaultNTE.json")) as { custom?: number; nteRegion?: string };

	assert.match(page4, /\["auto", "global", "cn", "tw"\]/);
	assert.match(page4, /invoke<NteGameRootValidation>\("validate_nte_game_root", \{\s*path: nteGameRoot,\s*region:/s);
	assert.match(page4, /const sourceRoot = join\(getCwd\(\), "nte-library"\)/);
	assert.match(page4, /setSource\(sourceRoot\)/);
	assert.match(page4, /setTarget\(validation\.modsRoot\)/);
	assert.match(page4, /setChecked\(1\)/);
	assert.match(page4, /setNteRegion\(validation\.region\)/);
	assert.match(filesys, /nteRegion: snapshot\.nteRegion \?\? store\.get\(NTE_REGION\)/);
	assert.match(
		init,
		/if \(game !== "NTE" && configXX\.targetDir && !\(await pathExistsNative\(configXX\.targetDir\)\)\)/
	);
	assert.match(types, /nteRegion\?: NteRegion/);
	assert.equal(defaults.custom, 1);
	assert.equal(defaults.nteRegion, "auto");
});

test("NTE refresh checks the canonical mods root without managedTGT or d3dx categorization", () => {
	const filesys = readSource("src/utils/filesys.ts");
	const refresh = sourceBetween(
		filesys,
		"export async function refreshModList()",
		"export async function createModDownloadDir"
	);

	assert.match(refresh, /const isNte = store\.get\(GAME\) === "NTE"/);
	assert.match(refresh, /const modTgt = isNte \? tgt : join\(tgt, managedTGT\)/);
	assert.match(refresh, /if \(!isNte\) await categorizeDir\(modSrc\)/);
	assert.match(refresh, /exists\(join\(modTgt, entry\.path\)\)/);
});

test("NTE toggle and delete use the native lifecycle command before legacy filesystem work", () => {
	const filesys = readSource("src/utils/filesys.ts");
	const rust = readSource("src-tauri/src/nte.rs");
	const deleteMod = sourceBetween(filesys, "export async function deleteMod", "function getTrackedMods");
	const toggleMod = sourceBetween(
		filesys,
		"export async function toggleMod",
		"export async function savePreviewImageFromData"
	);

	assert.match(toggleMod, /if \(store\.get\(GAME\) === "NTE"\)/);
	assert.match(toggleMod, /invoke\("set_nte_mod_enabled", \{\s*relativePath: path,\s*enabled,\s*\}\)/s);
	assert.ok(toggleMod.indexOf('invoke("set_nte_mod_enabled"') < toggleMod.indexOf('invoke("create_symlink"'));
	assert.ok(toggleMod.indexOf("return true;") < toggleMod.indexOf("syncIniStateFromD3DXIni"));

	assert.match(deleteMod, /const isNte = store\.get\(GAME\) === "NTE"/);
	assert.match(deleteMod, /if \(isNte\)/);
	assert.match(deleteMod, /invoke\("delete_nte_mod", \{\s*relativePath: path,\s*\}\)/s);
	assert.match(rust, /load_persisted_nte_config\(config_dir\)/);
	assert.match(rust, /source_library_root\.join\(&relative\)/);
	assert.ok(deleteMod.indexOf('invoke("delete_nte_mod"') < deleteMod.indexOf("guardedRemove(modSrc"));
	assert.match(deleteMod, /catch \(err\) \{[\s\S]*throw err;/);
});

test("NTE checklist uses semantic controls, a local game image, and localized copy", () => {
	const page2 = readSource("src/_Checklist/pages/Page2.tsx");
	const page4 = readSource("src/_Checklist/pages/Page4.tsx");
	const textData = JSON.parse(readSource("src/textData.json")) as Record<
		string,
		{ _Checklist?: Record<string, string> }
	>;
	const nteAction = page2.indexOf('switchGame("NTE")');
	const nteButtonStart = page2.lastIndexOf("<button", nteAction);
	const nteButtonEnd = page2.indexOf("</button>", nteAction);

	assert.ok(nteButtonStart >= 0 && nteButtonEnd > nteAction, "NTE game selection must be a semantic button");
	assert.match(page2.slice(nteButtonStart, nteButtonEnd), /<img[\s\S]*src="\/NTELogo\.png"[\s\S]*alt=/);
	assert.ok(existsSync(new URL("../public/NTELogo.png", import.meta.url)), "NTE logo must be packaged locally");
	assert.match(page4, /textData\._Checklist\.NTEGameRoot/);
	assert.match(page4, /textData\._Checklist\.NTERegion/);
	assert.match(page4, /aria-label=\{textData\.Browse\}/);
	assert.doesNotMatch(page4, />NTE Game Root</);

	for (const [language, text] of Object.entries(textData)) {
		for (const key of [
			"NTEGameRoot",
			"NTERegion",
			"NTESelectGameRoot",
			"NTEManagedLibraryOutside",
			"NTEGameRootNotConfigured",
		]) {
			assert.equal(typeof text._Checklist?.[key], "string", `${language} is missing _Checklist.${key}`);
			assert.ok(text._Checklist?.[key], `${language} has an empty _Checklist.${key}`);
		}
	}
});

test("NTE checklist localization keys are unique per language", () => {
	const rawTextData = readSource("src/textData.json");
	const languageCount = Object.keys(JSON.parse(rawTextData) as Record<string, unknown>).length;

	for (const key of [
		"NTEGameRoot",
		"NTERegion",
		"NTESelectGameRoot",
		"NTEManagedLibraryOutside",
		"NTEGameRootNotConfigured",
	]) {
		assert.equal(
			rawTextData.match(new RegExp(`"${key}"\\s*:`, "g"))?.length,
			languageCount,
			`${key} must occur once per language`
		);
	}
});

test("NTE deletion commits UI state only after the managed source deletion succeeds", () => {
	const rightLocal = readSource("src/_RightSidebar/RightLocal.tsx");
	const deleteFlow = sourceBetween(rightLocal, "<AlertDialog open={alertOpen}", '<SidebarContent className="bgpattern');

	assert.match(deleteFlow, /try \{\s*await deleteMod\(deleteItemData\.path\);\s*\} catch \{\s*return;\s*\}/s);
	assert.ok(deleteFlow.indexOf("await deleteMod(deleteItemData.path)") < deleteFlow.indexOf("setData((prev)"));
	assert.ok(deleteFlow.indexOf("await deleteMod(deleteItemData.path)") < deleteFlow.indexOf("saveConfigs()"));
	assert.ok(deleteFlow.indexOf("await deleteMod(deleteItemData.path)") < deleteFlow.indexOf("setModList((prev)"));
});

test("NTE presets disable deployed mods from the canonical target without rebuilding managedTGT", () => {
	const filesys = readSource("src/utils/filesys.ts");
	const applyPreset = sourceBetween(
		filesys,
		"export async function applyPreset",
		"export async function installFromArchives"
	);

	assert.match(applyPreset, /const isNte = store\.get\(GAME\) === "NTE"/);
	assert.match(applyPreset, /const presetTarget = isNte \? tgt : join\(tgt, managedTGT\)/);
	assert.match(applyPreset, /readDirRecr\(presetTarget, "", 2\)/);
	assert.match(
		applyPreset,
		/if \(!isNte\) \{\s*await guardedRemove\(presetTarget, \{ recursive: true \}\);\s*await mkdir\(presetTarget, \{ recursive: true \}\);\s*\}/s
	);
	assert.match(applyPreset, /if \(disableResults\.some\(\(result\) => !result\)\) \{\s*throw new Error\(/s);
	assert.match(applyPreset, /if \(enableResults\.some\(\(result\) => !result\)\) \{\s*throw new Error\(/s);
});

test("Disable All refreshes the mod list only after the preset operation completes", () => {
	const leftLocal = readSource("src/_LeftSidebar/LeftLocal.tsx");

	assert.match(
		leftLocal,
		/setCurrentPreset\(-1\);\s*await applyPreset\(\[\]\);\s*setModList\(await refreshModList\(\)\);/s
	);
});

test("NTE rename is delegated to one native WAL transaction", () => {
	const filesys = readSource("src/utils/filesys.ts");
	const rename = sourceBetween(filesys, "export async function changeModName", "export async function deleteCategory");

	assert.match(rename, /const isNte = store\.get\(GAME\) === "NTE"/);
	assert.match(
		rename,
		/const result = await invoke\("rename_nte_mod", \{ relativePath: path, newRelativePath: newPath \}\)/
	);
	assert.ok(rename.indexOf('invoke("rename_nte_mod"') < rename.indexOf("store.set(DATA"));
	const nteBranch = rename.slice(0, rename.indexOf("const modTgt"));
	assert.match(nteBranch, /acceptNteOperationRevision\(result\)/);
	assert.doesNotMatch(nteBranch, /toggleMod\(/);
	assert.doesNotMatch(nteBranch, /guardedRename\(/);
	assert.doesNotMatch(nteBranch, /saveConfigs\(/);
});

test("NTE batch and category mutations serialize native mod-leaf transactions", () => {
	const batch = readSource("src/_LeftSidebar/components/Batch.tsx");
	const filesys = readSource("src/utils/filesys.ts");

	assert.match(batch, /for \(const modPath of selectedPaths\) \{\s*await deleteMod\(/s);
	assert.match(batch, /for \(const modPath of selected\) \{[\s\S]*await changeModName\(/);
	assert.match(batch, /disabled=\{!moveValid\}[\s\S]*if \(!moveValid\) return;/);
	assert.match(batch, /const selected = isNte\s*\? normalizeManagedMods\(cleanChecked, treeData, categories\)/);
	assert.match(
		batch,
		/onSelect=\{async \(currentValue\) => \{[\s\S]*await saveConfigs\(\);[\s\S]*renameCheckedMods\(mods\)/
	);
	assert.match(batch, /if \(isNte\) \{\s*for \(let index = 0; index < newPaths\.length; index \+= 1\)/s);
	assert.match(
		filesys,
		/store\.get\(GAME\) === "NTE" && entry\.name\.startsWith\("\."\) && entry\.name\.includes\("\.imm-"\)/
	);
	const deleteCategory = sourceBetween(
		filesys,
		"export async function deleteCategory",
		"export async function deleteRestorePoint"
	);
	assert.match(deleteCategory, /for \(const modPath of modPaths\) await deleteMod\(modPath\)/);
});

test("NTE config writes use native revision CAS and rename does not rewrite stale snapshots", () => {
	const revision = readSource("src/utils/nteConfigRevision.ts");
	const filesys = readSource("src/utils/filesys.ts");
	const rust = readSource("src-tauri/src/nte.rs");
	const lib = readSource("src-tauri/src/lib.rs");
	const errorCatcher = readSource("src/utils/errorCatcher.tsx");
	const linkIntegrity = readSource("src/utils/linkIntegrity.ts");

	assert.match(revision, /invoke<string>\("save_nte_config"/);
	assert.match(revision, /expectedUpdatedAt,/);
	assert.match(revision, /generationAtCall === nativeMutationGeneration \? currentRevision : expectedAtCall/);
	assert.match(
		revision,
		/await invoke<string>\("save_nte_config"[\s\S]*shouldAcceptNteConfigSaveResponse\(generationAtCall, nativeMutationGeneration\)/
	);
	assert.match(filesys, /path\.replaceAll\("\/", "\\\\"\) === "configNTE\.json"/);
	assert.match(rust, /NTE_CONFIG_LOCK_FILE/);
	assert.match(rust, /persist_nte_config_cas/);
	assert.match(rust, /changed while this update was pending/);
	assert.match(lib, /configNTE\.json must be written through save_nte_config/);
	assert.match(errorCatcher, /content\.game === "NTE"\) await persistNteConfig/);
	assert.match(linkIntegrity, /gameReport\.game === "NTE"\) await persistNteConfig/);
});

test("NTE config reads use the same no-follow identity-checked native entrypoint", () => {
	const revision = readSource("src/utils/nteConfigRevision.ts");
	const init = readSource("src/utils/init.ts");
	const filesys = readSource("src/utils/filesys.ts");
	const linkIntegrity = readSource("src/utils/linkIntegrity.ts");
	const rust = readSource("src-tauri/src/nte.rs");
	const lib = readSource("src-tauri/src/lib.rs");

	assert.match(revision, /invoke<string>\("load_nte_config"\)/);
	assert.match(init, /configNTE\.json"\) return loadNteConfigText\(\)/);
	assert.match(filesys, /configNTE\.json"\) return loadNteConfigText\(\)/);
	assert.match(linkIntegrity, /game === "NTE" \? loadNteConfigText\(\) : readTextFile\(configPath\)/);
	assert.match(rust, /pub fn load_nte_config\(\)[\s\S]*read_nte_config_value\(&config_dir, "for renderer load"\)/);
	assert.match(rust, /pub\(crate\) fn persisted_nte_game_directories\([\s\S]*load_persisted_nte_config/);
	assert.match(lib, /if game == "NTE" \{[\s\S]*nte::persisted_nte_game_directories\(config_dir\)/);
	assert.match(lib, /configNTE\.json must be read through load_nte_config/);
});

test("an older NTE save response cannot overwrite a newer native mutation revision", () => {
	let visibleRevision = "rename-revision";
	const saveGeneration = 0;
	const generationAfterRename = 1;
	if (shouldAcceptNteConfigSaveResponse(saveGeneration, generationAfterRename)) {
		visibleRevision = "stale-save-revision";
	}
	assert.equal(visibleRevision, "rename-revision");
	assert.equal(shouldAcceptNteConfigSaveResponse(1, 1), true);
});

test("NTE deletion is committed by the native quarantine transaction", () => {
	const filesys = readSource("src/utils/filesys.ts");
	const deleteMod = sourceBetween(filesys, "export async function deleteMod", "function getTrackedMods");
	const rust = readSource("src-tauri/src/nte.rs");
	const lib = readSource("src-tauri/src/lib.rs");

	assert.match(deleteMod, /invoke\("delete_nte_mod"/);
	assert.match(deleteMod, /const result = await invoke\("delete_nte_mod"[\s\S]*acceptNteOperationRevision\(result\)/);
	assert.doesNotMatch(deleteMod, /saveConfigs\(/);
	assert.match(rust, /fn delete_mod_inner\(/);
	assert.match(rust, /let quarantine = unique_sibling\(source_path, "delete"\)/);
	assert.match(rust, /durable_rename_bound_directory\([\s\S]*&source_handle[\s\S]*quarantine_name/);
	assert.match(rust, /complete_nte_delete_config/);
	assert.match(rust, /restore_nte_delete_config/);
	assert.match(rust, /delete_config: Option<NteDeleteConfigPlan>/);
	assert.match(lib, /nte::delete_nte_mod/);
});

test("NTE download validation redeploys an update when the Mod was already enabled", () => {
	const filesys = readSource("src/utils/filesys.ts");
	const validateDownload = sourceBetween(
		filesys,
		"export async function validateModDownload",
		"export async function cleanCancelledDownload"
	);

	assert.match(
		validateDownload,
		/if \(store\.get\(GAME\) === "NTE" && relPath && \(await exists\(join\(tgt, relPath\)\)\)\)/
	);
	assert.match(validateDownload, /if \(!\(await toggleMod\(relPath, true\)\)\) \{/);
	assert.match(validateDownload, /catch \(err\) \{[\s\S]*return false;/);

	const downloads = readSource("src/_LeftSidebar/components/Downloads.tsx");
	assert.match(
		downloads,
		/if \(!\(await validateModDownload\(finished\.dlPath \|\| ""\)\)\) \{[\s\S]*handleDownloadFailure\(key,[\s\S]*"validation"\);[\s\S]*return;/
	);
});

test("NTE downloads, manual installs, and previews never write directly into a visible Mod leaf", () => {
	const filesys = readSource("src/utils/filesys.ts");
	const downloads = readSource("src/_LeftSidebar/components/Downloads.tsx");
	const rust = readSource("src-tauri/src/lib.rs");
	const createTarget = sourceBetween(
		filesys,
		"export async function createModDownloadTarget",
		"export async function validateModDownload"
	);
	const manualInstallStart = filesys.indexOf("export async function installFromArchives");
	assert.notEqual(manualInstallStart, -1, "missing manual install flow");
	const manualInstall = filesys.slice(manualInstallStart);

	assert.match(createTarget, /const isNte = store\.get\(GAME\) === "NTE"/);
	assert.match(createTarget, /if \(!isNte\) await mkdir\(path, \{ recursive: true \}\)/);
	assert.match(manualInstall, /if \(!isNte\) await mkdir\(dest, \{ recursive: true \}\)/);
	assert.match(downloads, /createdDlPath && game !== "NTE"/);
	assert.match(rust, /nte_download_staging_directory\(&app_handle, &key, &requested_save_path\)/);
	assert.match(rust, /deploy_downloaded_nte_preview/);
	assert.match(rust, /stage_and_deploy_nte_preview/);
	assert.match(rust, /deploy_staged_directory\([\s\S]*Some\(journal\)/);
	assert.match(filesys, /store\.get\(GAME\) === "NTE"[\s\S]*invoke\("save_nte_preview_data"/);
	assert.match(filesys, /store\.get\(GAME\) === "NTE"[\s\S]*invoke\("import_nte_preview_file"/);
	assert.match(rust, /fn deploy_local_nte_preview<[\s\S]*deploy_downloaded_nte_preview/);
	assert.match(rust, /async fn save_nte_preview_data/);
	assert.match(rust, /async fn import_nte_preview_file/);
});

test("NTE hidden download staging is reclaimed after an owner process exits", () => {
	const rust = readSource("src-tauri/src/lib.rs");

	assert.match(rust, /fn nte_download_staging_owner\(/);
	assert.match(rust, /fn cleanup_stale_nte_download_staging\(/);
	assert.match(rust, /if nte_staging_owner_is_live\(owner_pid\) \{\s*continue;/s);
	assert.match(rust, /cleanup_stale_nte_download_staging_root\(&root\)\?/);
	assert.match(rust, /let name = "nte-download-staging"/);
	assert.match(rust, /open_bound_directory_for_rename_optional\([\s\S]*OsStr::new\(name\)/);
	assert.match(rust, /cleanup_stale_nte_download_staging\(&app_local_data\)/);
});

test("NTE launch failures are surfaced and automatic launch observes rejection", () => {
	const init = readSource("src/utils/init.ts");
	const launch = sourceBetween(init, "export async function launchGame()", "async function initHelpers");

	assert.match(launch, /catch \(launchError\) \{[\s\S]*addToast\(\{[\s\S]*type: "error"/);
	assert.doesNotMatch(init, /launchGame\(\);/);
});

test("NTE checklist ignores stale validation results after its dependencies change", () => {
	const page3 = readSource("src/_Checklist/pages/Page3.tsx");

	assert.match(page3, /let cancelled = false/);
	assert.match(page3, /if \(cancelled\) return/);
	assert.match(page3, /return \(\) => \{\s*cancelled = true;\s*\}/s);
});

test("NTE launch invokes only the Rust launcher with the persisted region", () => {
	const init = readSource("src/utils/init.ts");
	const launch = sourceBetween(init, "export async function launchGame()", "async function initHelpers");

	assert.match(launch, /if \(config\.game === "NTE"\)/);
	assert.match(launch, /const configuredTarget = store\.get\(TARGET\) \|\| configXX\.targetDir/);
	assert.match(
		launch,
		/invoke\("launch_nte_game", \{\s*gameRoot,\s*region: store\.get\(NTE_REGION\) \|\| configXX\.nteRegion \|\| null/s
	);
	assert.ok(launch.indexOf('invoke("launch_nte_game"') < launch.indexOf('syncIniStateOnce("launch-game")'));
	assert.ok(launch.indexOf("return;") < launch.indexOf("executeXXMI"));
});

test("legacy game checklist and XXMI lifecycle branches remain present", () => {
	const page2 = readSource("src/_Checklist/pages/Page2.tsx");
	const filesys = readSource("src/utils/filesys.ts");
	const init = readSource("src/utils/init.ts");

	for (const game of ["WW", "ZZ", "GI", "SR", "EF"]) {
		assert.match(page2, new RegExp(`switchGame\\("${game}"\\)`));
	}
	assert.match(filesys, /invoke\("create_symlink"/);
	assert.match(filesys, /syncIniStateFromD3DXIni\(/);
	assert.match(init, /executeXXMI\(/);
});
