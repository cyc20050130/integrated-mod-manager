import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("game registry exposes NTE with stable serialized and GameBanana identities", async () => {
	const { GAME_REGISTRY, getGameRegistryEntry } = await import("../src/utils/gameRegistry.ts");
	const nte = getGameRegistryEntry("NTE");

	assert.equal(nte.key, "NTE");
	assert.equal(nte.serializedId, 5);
	assert.equal(nte.gameBananaId, 23012);
	assert.equal(nte.displayName, "Neverness to Everness");
	assert.equal(nte.displayNameZh, "异环");
	assert.deepEqual(nte.contentTypes, ["Skins", "UI", "Other"]);
	assert.equal(GAME_REGISTRY.NTE.adapterId, "gamebananante");
});

test("registry maps old ids without renumbering existing games", async () => {
	const { GAME_REGISTRY, getGameBySerializedId, getGameByGameBananaId } = await import(
		"../src/utils/gameRegistry.ts"
	);

	assert.deepEqual(
		Object.values(GAME_REGISTRY).map((entry) => [entry.key, entry.serializedId]),
		[
			["WW", 0],
			["ZZ", 1],
			["GI", 2],
			["SR", 3],
			["EF", 4],
			["NTE", 5],
		]
	);
	assert.equal(getGameBySerializedId(0)?.key, "WW");
	assert.equal(getGameBySerializedId(4)?.key, "EF");
	assert.equal(getGameByGameBananaId(23012)?.key, "NTE");
	assert.equal(getGameByGameBananaId(99999), undefined);
});

test("NTE default config is isolated and uses the existing game config schema", () => {
	const config = JSON.parse(readFileSync(new URL("../src/defaultNTE.json", import.meta.url), "utf8")) as {
		game?: string;
		settings?: { download?: { maxConcurrentDownloads?: number } };
		data?: unknown;
	};

	assert.equal(config.game, "NTE");
	assert.equal(config.settings?.download?.maxConcurrentDownloads, 1);
	assert.deepEqual(config.data, {});
});

test("game data contains a dynamic-provider NTE entry instead of a stale category snapshot", () => {
	const data = JSON.parse(readFileSync(new URL("../src/gameData.json", import.meta.url), "utf8")) as Record<
		string,
		{ id?: { game?: string }; categoryList?: unknown[]; provider?: string }
	>;

	assert.equal(data.NTE?.id?.game, "23012");
	assert.equal(data.NTE?.provider, "gamebananante");
	assert.deepEqual(data.NTE?.categoryList, []);
});

test("NTE initialization uses its isolated defaults and does not call legacy XXMI hotreload", () => {
	const source = readFileSync(new URL("../src/utils/init.ts", import.meta.url), "utf8");

	assert.match(source, /import defConfigNTE from "\.\.\/defaultNTE\.json"/);
	assert.match(source, /const defaultGameConfig = game === "NTE" \? defConfigNTE : defConfigXX/);
	assert.match(source, /if \(config\.game !== "NTE"\) \{\s*setHotreload\(/s);
});
