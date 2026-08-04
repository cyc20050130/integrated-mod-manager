import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("WER diagnostics expose only fixed parameterless commands to the renderer", () => {
	const settings = read("src/_LeftSidebar/components/Settings.tsx");
	const helper = read("src-tauri/src/privileged_helper.rs");
	const registration = read("src-tauri/src/lib.rs");

	assert.match(helper, /pub\(crate\) fn get_wer_local_dumps_status\(\)/);
	assert.match(helper, /pub\(crate\) async fn configure_wer_local_dumps\(\)/);
	assert.match(helper, /pub\(crate\) async fn remove_wer_local_dumps\(\)/);
	assert.match(registration, /privileged_helper::get_wer_local_dumps_status,/);
	assert.match(registration, /privileged_helper::configure_wer_local_dumps,/);
	assert.match(registration, /privileged_helper::remove_wer_local_dumps,/);
	assert.match(settings, /invoke<WerLocalDumpsStatus>\("get_wer_local_dumps_status"\)/);
	assert.match(settings, /invoke<void>\(command\)/);
	assert.match(settings, /"configure_wer_local_dumps" \| "remove_wer_local_dumps"/);
	assert.doesNotMatch(settings, /invoke(?:<[^>]+>)?\("(?:configure|remove)_wer_local_dumps",\s*\{/);
});

test("WER settings render every backend state and keep unsafe states read-only", () => {
	const settings = read("src/_LeftSidebar/components/Settings.tsx");
	const states = [
		"unsupported_build",
		"disabled",
		"enabled",
		"unmanaged",
		"drifted",
		"managed_by_other_install",
		"recovery_required",
	];

	for (const state of states) {
		assert.match(settings, new RegExp(`${state}:`));
	}
	assert.match(
		settings,
		/werStatus\.state === "disabled"[\s\S]*werStatus\.state === "managed_by_other_install"[\s\S]*werStatus\.state === "recovery_required"[\s\S]*runWerAction\("configure_wer_local_dumps"\)/
	);
	assert.match(settings, /werStatus\?\.state === "enabled"[\s\S]*runWerAction\("remove_wer_local_dumps"\)/);
	assert.doesNotMatch(settings, /werStatus\.state === "(?:unmanaged|drifted)"[\s\S]{0,300}runWerAction/);
});

test("WER actions refresh authoritative status on both success and failure", () => {
	const settings = read("src/_LeftSidebar/components/Settings.tsx");
	const actionStart = settings.indexOf("const runWerAction");
	const actionEnd = settings.indexOf("const handleSettingsOpenChange", actionStart);
	const action = settings.slice(actionStart, actionEnd);

	assert.notEqual(actionStart, -1);
	assert.notEqual(actionEnd, -1);
	assert.equal(action.match(/await refreshWerStatus\(false\)/g)?.length, 2);
	assert.match(settings, /const handleSettingsOpenChange = \(open: boolean\)[\s\S]*if \(open\) void refreshWerStatus\(\)/);
	assert.match(settings, /<Dialog open=\{settingsOpen\} onOpenChange=\{handleSettingsOpenChange\}>/);
});
