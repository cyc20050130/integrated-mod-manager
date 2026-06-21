import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

type LatestManifest = {
	version: string;
	platforms?: {
		[key: string]: {
			url?: string;
		};
	};
};

function readLatestManifest() {
	const manifestPath = new URL("../latest.json", import.meta.url);
	return JSON.parse(readFileSync(manifestPath, "utf8")) as LatestManifest;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("latest.json Windows installer URL uses the GitHub release asset-safe filename", () => {
	const manifest = readLatestManifest();
	const downloadUrl = manifest.platforms?.["windows-x86_64"]?.url || "";
	const version = manifest.version;
	const escapedVersion = escapeRegExp(version);

	assert.ok(downloadUrl, "expected latest.json to include a windows-x86_64 download URL");
	assert.match(
		downloadUrl,
		new RegExp(
			`/releases/(?:latest/download|download/v${escapedVersion})/Integrated\\.Mod\\.Manager\\.IMM\\._${escapedVersion}_x64-setup\\.exe$`
		)
	);
	assert.doesNotMatch(downloadUrl, /%20|\(|\)/);
});
