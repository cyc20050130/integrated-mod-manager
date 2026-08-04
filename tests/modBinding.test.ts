import assert from "node:assert/strict";
import test from "node:test";

import {
	boundGameBananaModId,
	createGameBananaBinding,
	findGameBananaBindingConflicts,
	parseGameBananaModId,
	rankLocalBindingCandidates,
	validateGameBananaDownloadIdentity,
} from "../src/utils/modBinding.ts";

test("GameBanana binding IDs are stable and restored source URLs remain discoverable", () => {
	assert.equal(parseGameBananaModId("https://gamebanana.com/mods/123"), 123);
	assert.equal(parseGameBananaModId("https://gamebanana.com/Mod/456?tab=files"), 456);
	assert.equal(boundGameBananaModId({ source: "https://gamebanana.com/mods/123" }), 123);
	assert.equal(
		boundGameBananaModId({
			source: "https://gamebanana.com/Mod/123",
			gameBanana: {
				provider: "gamebanana",
				modId: 789,
				profileUrl: "https://gamebanana.com/mods/789",
				variant: "primary",
				boundAt: 1,
			},
		}),
		789
	);
});

test("duplicate GameBanana IDs identify the occupying local path", () => {
	const conflicts = findGameBananaBindingConflicts(
		{
			"Characters/Alpha": { source: "https://gamebanana.com/Mod/42" },
			"Characters/Beta": {
				gameBanana: createGameBananaBinding({
					modId: 42,
					profileUrl: "https://gamebanana.com/Mod/42",
					independentVariant: true,
					boundAt: 1,
				}),
			},
		},
		"Characters/Beta",
		42,
		new Set(["Characters/Alpha", "Characters/Beta"])
	);
	assert.deepEqual(conflicts, ["Characters/Alpha"]);
});

test("independent variant intent is persisted explicitly", () => {
	const binding = createGameBananaBinding({
		modId: 42,
		profileUrl: "https://gamebanana.com/Mod/42",
		independentVariant: true,
		boundAt: 123,
		selectedFile: { id: "7", name: "variant.zip", size: 1200, updatedAt: 100 },
	});
	assert.equal(binding.variant, "independent");
	assert.equal(binding.selectedFile?.id, "7");
});

test("local candidates are ranked by the closest archive size without declaring identity", () => {
	const ranked = rankLocalBindingCandidates(
		[
			{ path: "Mods/A", name: "A" },
			{ path: "Mods/B", name: "B" },
			{ path: "Mods/C", name: "C" },
		],
		{ "Mods/A": 980, "Mods/B": 5000 },
		[
			{ id: 1, name: "old.zip", size: 1000, updatedAt: 10 },
			{ id: 2, name: "new.zip", size: 4900, updatedAt: 20 },
		]
	);
	assert.deepEqual(
		ranked.map((candidate) => candidate.mod.path),
		["Mods/A", "Mods/B", "Mods/C"]
	);
	assert.equal(ranked[0].difference, 20);
	assert.equal(ranked[0].closestFile?.name, "old.zip");
	assert.equal(ranked[2].difference, undefined);
});

test("download identity fails closed before a legacy queue item can reach the network", () => {
	assert.match(
		validateGameBananaDownloadIdentity({
			source: "https://gamebanana.com/mods/42",
			gameBananaFileId: "7",
		}) || "",
		/no valid GameBanana Mod ID/
	);
	assert.match(
		validateGameBananaDownloadIdentity({
			source: "https://gamebanana.com/mods/42",
			gameBananaModId: 42,
			gameBananaFileId: "7",
		}) || "",
		/no valid file size/
	);
	assert.match(
		validateGameBananaDownloadIdentity({
			source: "https://gamebanana.com/mods/42",
			gameBananaModId: 42,
			gameBananaFileId: "7",
			expectedSize: 1200,
		}) || "",
		/no valid MD5 checksum/
	);
	assert.equal(
		validateGameBananaDownloadIdentity({
			source: "https://gamebanana.com/mods/42",
			gameBananaModId: 42,
			gameBananaFileId: "7",
			expectedSize: 1200,
			expectedHash: { algorithm: "md5", value: "d41d8cd98f00b204e9800998ecf8427e" },
		}),
		null
	);
});
