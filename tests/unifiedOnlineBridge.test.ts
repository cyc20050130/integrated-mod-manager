import test from "node:test";
import assert from "node:assert/strict";

import {
	buildUnifiedOnlineCacheKey,
	normalizeUnifiedOnlineDetail,
	normalizeOnlineSourceFilter,
	shouldUseUnifiedWwOnline,
} from "../src/utils/unifiedOnlineBridge.ts";
import { createUnifiedCardFromVariant, type UnifiedSourceVariant } from "../src/utils/unifiedOnline.ts";

function makeVariant(overrides: Partial<UnifiedSourceVariant> = {}): UnifiedSourceVariant {
	return {
		sourceId: "gamebanana",
		sourceModId: "mod-1",
		title: "示例 Mod",
		detailUrl: "https://example.com/mod-1",
		downloadOptions: [],
		previewUrls: [],
		author: "Tester",
		isFreePublic: true,
		rawUpdatedAt: "2026-04-17T12:00:00.000Z",
		...overrides,
	};
}

test("shouldUseUnifiedWwOnline only enables unified bridge for WW", () => {
	assert.equal(shouldUseUnifiedWwOnline("WW"), true);
	assert.equal(shouldUseUnifiedWwOnline("GI"), false);
	assert.equal(shouldUseUnifiedWwOnline(""), false);
});

test("normalizeOnlineSourceFilter falls back invalid values to all", () => {
	assert.equal(normalizeOnlineSourceFilter("gamebanana"), "gamebanana");
	assert.equal(normalizeOnlineSourceFilter("afdian"), "afdian");
	assert.equal(normalizeOnlineSourceFilter("unexpected"), "all");
});

test("buildUnifiedOnlineCacheKey namespaces unified WW cache entries by source and path", () => {
	assert.equal(buildUnifiedOnlineCacheKey("search/jinhsi&_type=Mod", "hui"), "ww-unified:hui:search/jinhsi&_type=Mod");
	assert.equal(buildUnifiedOnlineCacheKey("home&type=Mod", "all"), "ww-unified:all:home&type=Mod");
});

test("normalizeUnifiedOnlineDetail fills optional richer payload collections safely", () => {
	const card = createUnifiedCardFromVariant(makeVariant({ sourceId: "hui", sourceModId: "hui-7" }), "Other");
	const detail = normalizeUnifiedOnlineDetail({
		card,
		commentsEnabled: false,
		updatesEnabled: true,
		sourceSpecificNotes: [
			{
				sourceId: "hui",
				label: "Hui",
				contentHtml: "<p>Mirror note</p>",
			},
		],
		sourceDetails: [{ sourceId: "hui" }],
	});

	assert.deepEqual(detail.aliases, []);
	assert.deepEqual(detail.tags, []);
	assert.deepEqual(detail.links, []);
	assert.deepEqual(detail.updates, []);
	assert.equal(detail.stats, null);
	assert.equal(detail.summary, null);
	assert.equal(detail.description, null);
	assert.equal(detail.descriptionHtml, null);
	assert.equal(detail.sourceDetails[0]?.sourceId, "hui");
	assert.deepEqual(detail.sourceDetails[0]?.previewUrls, []);
	assert.deepEqual(detail.sourceDetails[0]?.downloadOptions, []);
	assert.deepEqual(detail.sourceDetails[0]?.tags, []);
	assert.deepEqual(detail.sourceDetails[0]?.links, []);
	assert.equal(detail.sourceDetails[0]?.stats, null);
	assert.deepEqual(detail.sourceSpecificNotes, { hui: "<p>Mirror note</p>" });
});

test("normalizeUnifiedOnlineDetail preserves richer payload fields from bridge", () => {
	const card = createUnifiedCardFromVariant(makeVariant({ sourceId: "gamebanana", sourceModId: "gb-700001" }), "Other");
	const detail = normalizeUnifiedOnlineDetail({
		card,
		commentsEnabled: true,
		updatesEnabled: true,
		summary: "Merged overview",
		description: "Primary source remains GameBanana.",
		aliases: ["Blue Dress"],
		tags: ["outfit"],
		links: [{ label: "Unified Card", url: "https://imm.example.com/card/1" }],
		stats: { likeCount: 128, viewCount: 2048 },
		updates: [
			{
				sourceId: "gamebanana",
				title: "Compatibility update",
				version: "v1.1",
				publishedAt: "2026-04-21T02:00:00Z",
				summary: "Patched for the latest game update.",
				url: "https://gamebanana.com/updates/700001",
			},
		],
		sourceDetails: [
			{
				sourceId: "gamebanana",
				title: "Camellya Blue Dress",
				detailUrl: "https://gamebanana.com/mods/700001",
				downloadOptions: [{ label: "Main Download", url: "https://downloads.example.com/gb.zip" }],
				previewUrls: ["https://example.com/previews/camellya-blue-dress.jpg"],
				author: "BlueArchive",
				isFreePublic: true,
				rawUpdatedAt: "2026-04-21T02:00:00Z",
				summary: "Primary source summary",
				descriptionHtml: "<p>Detailed HTML</p>",
				version: "v1.1",
				tags: ["mirror-safe"],
				links: [{ label: "Readme", url: "https://gamebanana.com/readme/700001" }],
				stats: { downloadCount: 2048, postCount: 36 },
			},
		],
		sourceSpecificNotes: {
			gamebanana: "<p>Legacy detail can be reused.</p>",
		},
	});

	assert.equal(detail.summary, "Merged overview");
	assert.equal(detail.description, "Primary source remains GameBanana.");
	assert.deepEqual(detail.aliases, ["Blue Dress"]);
	assert.deepEqual(detail.tags, ["outfit"]);
	assert.deepEqual(detail.links, [{ label: "Unified Card", url: "https://imm.example.com/card/1" }]);
	assert.deepEqual(detail.stats, { likeCount: 128, viewCount: 2048 });
	assert.equal(detail.updates[0]?.title, "Compatibility update");
	assert.equal(detail.updates[0]?.version, "v1.1");
	assert.equal(detail.sourceDetails[0]?.title, "Camellya Blue Dress");
	assert.equal(detail.sourceDetails[0]?.descriptionHtml, "<p>Detailed HTML</p>");
	assert.deepEqual(detail.sourceDetails[0]?.stats, { downloadCount: 2048, postCount: 36 });
	assert.deepEqual(detail.sourceSpecificNotes, { gamebanana: "<p>Legacy detail can be reused.</p>" });
});
