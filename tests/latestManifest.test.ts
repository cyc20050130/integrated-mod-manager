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

test("latest.json Windows installer URL uses the GitHub release asset-safe filename", () => {
	const manifest = readLatestManifest();
	const downloadUrl = manifest.platforms?.["windows-x86_64"]?.url || "";

	assert.ok(downloadUrl, "expected latest.json to include a windows-x86_64 download URL");
	assert.match(downloadUrl, /\/releases\/download\/v3\.2\.0\/Integrated\.Mod\.Manager\.IMM\._3\.2\.0_x64-setup\.exe$/);
	assert.doesNotMatch(downloadUrl, /%20|\(|\)/);
	assert.doesNotMatch(downloadUrl, /\/releases\/latest\/download\//);
});
