import test from "node:test";
import assert from "node:assert/strict";

import {
	buildUnifiedDownloadQueueItem,
	buildUnifiedDuplicateSummary,
	buildUnifiedDuplicateEvidenceRows,
	buildUnifiedDetailLinkRows,
	buildUnifiedDetailOverviewRows,
	buildUnifiedDetailPreviewImages,
	buildUnifiedDetailUpdateRows,
	buildUnifiedSourceRefreshRows,
	buildUnifiedDownloadOptions,
	buildUnifiedDetailCapabilityLabels,
	buildUnifiedCardRoute,
	createUnifiedCardFromVariant,
	evaluateDuplicateEvidence,
	areAfdianCandidatesFresh,
	buildUnifiedAfdianDiscoveryQuery,
	findPreferredAfdianCandidate,
	findUnifiedCardRouteForSource,
	findUnifiedListCardForSource,
	findUnifiedGenericFallbackSourceId,
	replaceUnifiedListCard,
	isUnifiedCardRoute,
	mergeUnifiedCardGroup,
	resolveUnifiedDetailCard,
	resolveUnifiedDetailViewState,
	resolveUnifiedDetailSourceNote,
	resolveUnifiedDetailSourceVariant,
	resolveUnifiedSourceVariant,
	resolveUnifiedOnlineList,
	toOnlineListCard,
	normalizeOnlineName,
	type UnifiedOnlineDetailLike,
	type UnifiedSourceVariant,
} from "../src/utils/unifiedOnline.ts";

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

test("normalizeOnlineName strips version, author suffixes, and noise terms", () => {
	const normalized = normalizeOnlineName("  Camellya Mod v1.2 by Alice [3DMigoto UI NSFW]  ");

	assert.equal(normalized, "camellya");
});

test("evaluateDuplicateEvidence merges same-language high-confidence matches directly", () => {
	const evidence = evaluateDuplicateEvidence({
		leftTitle: "Camellya Ultimate Dress",
		rightTitle: "Camellya Ultimate Dress",
		sameLanguage: true,
	});

	assert.equal(evidence.decision, "merge");
	assert.equal(evidence.nameScore, 1);
	assert.equal(evidence.translatedNameScore, 0);
});

test("evaluateDuplicateEvidence skips preview promotion when translated similarity is too low", () => {
	const evidence = evaluateDuplicateEvidence({
		leftTitle: "今汐 蓝礼服",
		rightTitle: "Encore school uniform",
		leftTranslatedTitle: "Jinhsi blue dress",
		rightTranslatedTitle: "Encore school uniform",
		previewHashDistance: 2,
		sameLanguage: false,
	});

	assert.equal(evidence.decision, "separate");
	assert.ok(evidence.translationGap > 0.18);
	assert.equal(evidence.previewHashDistance, null);
});

test("evaluateDuplicateEvidence requests temp compare for near-threshold cross-language matches", () => {
	const evidence = evaluateDuplicateEvidence({
		leftTitle: "今汐 蓝礼服",
		rightTitle: "Jinhsi Blue Dress",
		leftTranslatedTitle: "Jinhsi blue dress",
		rightTranslatedTitle: "Jinhsi blue dress alt",
		sameLanguage: false,
	});

	assert.equal(evidence.decision, "temp_compare");
	assert.ok((evidence.translatedNameScore || 0) >= 0.84);
});

test("mergeUnifiedCardGroup keeps GameBanana as primary source and preserves alternates", () => {
	const gbCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "gamebanana",
			sourceModId: "gb-1",
			title: "Camellya Blue Dress",
			detailUrl: "https://gamebanana.com/mods/1",
		}),
		"Camellya"
	);
	const huiCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "hui",
			sourceModId: "hui-1",
			title: "今汐 蓝礼服",
			detailUrl: "https://hui.example/mod/1",
		}),
		"Camellya"
	);

	const merged = mergeUnifiedCardGroup([huiCard, gbCard], [
		{
			nameScore: 0.44,
			translatedNameScore: 0.93,
			translationGap: 0.07,
			previewHashDistance: 6,
			tempFileHashMatch: null,
			decision: "merge",
		},
	]);

	assert.equal(merged.primarySourceId, "gamebanana");
	assert.deepEqual(
		merged.sources.map((source) => source.sourceId),
		["gamebanana", "hui"]
	);
	assert.equal(merged.duplicateScore, 0.93);
	assert.ok(merged.originalNames.includes("Camellya Blue Dress"));
	assert.ok(merged.originalNames.includes("今汐 蓝礼服"));
});

test("buildUnifiedCardRoute and isUnifiedCardRoute identify unified detail routes", () => {
	const route = buildUnifiedCardRoute("gamebanana:123");

	assert.equal(route, "UnifiedCard/gamebanana:123");
	assert.equal(isUnifiedCardRoute(route), true);
	assert.equal(isUnifiedCardRoute("Mod/123"), false);
});

test("toOnlineListCard maps unified cards into existing online card shape", () => {
	const card = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "afdian",
			sourceModId: "afd-7",
			title: "Jinhsi Blue Dress",
			previewUrls: ["https://cdn.example.com/preview.jpg"],
			author: "BlueAuthor",
		}),
		"Other"
	);

	const mapped = toOnlineListCard(card);

	assert.equal(mapped._sModelName, "UnifiedCard");
	assert.equal(mapped._idRow, "afdian:afd-7");
	assert.equal(mapped._sName, "Jinhsi Blue Dress");
	assert.equal(mapped._sProfileUrl, "UnifiedCard/afdian:afd-7");
	assert.equal(mapped._aSubmitter?._sName, "BlueAuthor");
	assert.equal(mapped._aRootCategory?._sName, "Other");
	assert.equal(mapped._aPreviewMedia?._aImages?.[0]?._sBaseUrl, "https://cdn.example.com");
	assert.equal(mapped._aPreviewMedia?._aImages?.[0]?._sFile, "preview.jpg");
});

test("resolveUnifiedOnlineList prefers mapped unified cards and falls back to legacy online data when bridge is empty", () => {
	const unifiedCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "hui",
			sourceModId: "hui-22",
			title: "Unified Camellya",
		}),
		"Other"
	);
	const legacyCards = [
		{
			_idRow: 999,
			_sModelName: "Mod",
			_sName: "Legacy Camellya",
			_sInitialVisibility: "show",
			_nLikeCount: 1,
			_nPostCount: 0,
			_aSubmitter: {
				_idRow: 1,
				_sName: "Tester",
				_bIsOnline: true,
				_sProfileUrl: "",
				_sAvatarUrl: "",
				_sHdAvatarUrl: "",
			},
			_aRootCategory: {
				_sName: "Other",
				_sProfileUrl: "",
				_sIconUrl: "",
			},
		},
	];

	const unifiedResult = resolveUnifiedOnlineList([unifiedCard], legacyCards);
	const fallbackResult = resolveUnifiedOnlineList([], legacyCards);

	assert.equal(unifiedResult[0]?._sModelName, "UnifiedCard");
	assert.equal(unifiedResult[0]?._idRow, "hui:hui-22");
	assert.deepEqual(fallbackResult, legacyCards);
});

test("resolveUnifiedSourceVariant prefers requested source and falls back to primary source", () => {
	const card = mergeUnifiedCardGroup(
		[
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "gamebanana",
					sourceModId: "gb-1",
					title: "Camellya Blue Dress",
					previewUrls: ["https://cdn.example.com/gb/camellya.jpg"],
					downloadOptions: [{ label: "GB", url: "https://downloads.example.com/gb.zip" }],
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "hui",
					sourceModId: "hui-1",
					title: "Camellya Azure Outfit",
					previewUrls: ["https://cdn.example.com/hui/camellya.jpg"],
					downloadOptions: [{ label: "Hui", url: "https://downloads.example.com/hui.zip" }],
				}),
				"Other"
			),
		],
		[]
	);

	assert.equal(resolveUnifiedSourceVariant(card, "hui")?.sourceId, "hui");
	assert.equal(resolveUnifiedSourceVariant(card, "afdian")?.sourceId, "gamebanana");
});

test("findUnifiedGenericFallbackSourceId prefers the first non-GameBanana source", () => {
	const card = mergeUnifiedCardGroup(
		[
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "gamebanana",
					sourceModId: "gb-1",
					title: "Camellya Blue Dress",
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "hui",
					sourceModId: "hui-1",
					title: "Camellya Azure Outfit",
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "keke",
					sourceModId: "keke-1",
					title: "Camellya Keke Mirror",
				}),
				"Other"
			),
		],
		[]
	);

	assert.equal(findUnifiedGenericFallbackSourceId(card), "hui");
});

test("findUnifiedGenericFallbackSourceId skips excluded sources and returns the next generic source", () => {
	const card = mergeUnifiedCardGroup(
		[
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "gamebanana",
					sourceModId: "gb-1",
					title: "Camellya Blue Dress",
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "hui",
					sourceModId: "hui-1",
					title: "Camellya Azure Outfit",
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "keke",
					sourceModId: "keke-1",
					title: "Camellya Keke Mirror",
				}),
				"Other"
			),
		],
		[]
	);

	assert.equal(findUnifiedGenericFallbackSourceId(card, "gamebanana", ["hui"]), "keke");
	assert.equal(findUnifiedGenericFallbackSourceId(card, "gamebanana", ["hui", "keke"]), null);
});

test("findUnifiedGenericFallbackSourceId returns null when no alternate source exists", () => {
	const card = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "gamebanana",
			sourceModId: "gb-1",
			title: "Camellya Blue Dress",
		}),
		"Other"
	);

	assert.equal(findUnifiedGenericFallbackSourceId(card), null);
});

test("findUnifiedCardRouteForSource finds a unified list card by source id", () => {
	const huiCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "hui",
			sourceModId: "hui-1",
			title: "Camellya Azure Outfit",
		}),
		"Other"
	);
	const kekeCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "keke",
			sourceModId: "keke-1",
			title: "Jinhsi School Uniform UI",
		}),
		"UI"
	);

	const route = findUnifiedCardRouteForSource([toOnlineListCard(huiCard), toOnlineListCard(kekeCard)], "keke");

	assert.equal(route, "UnifiedCard/keke:keke-1");
	assert.equal(findUnifiedCardRouteForSource([toOnlineListCard(huiCard)], "afdian"), null);
});

test("findUnifiedListCardForSource returns the matching unified list item", () => {
	const huiCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "hui",
			sourceModId: "hui-1",
			title: "Camellya Azure Outfit",
		}),
		"Other"
	);
	const kekeCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "keke",
			sourceModId: "keke-1",
			title: "Jinhsi School Uniform UI",
		}),
		"UI"
	);

	const kekeItem = findUnifiedListCardForSource([toOnlineListCard(huiCard), toOnlineListCard(kekeCard)], "keke");

	assert.equal(kekeItem?._sProfileUrl, "UnifiedCard/keke:keke-1");
	assert.equal(kekeItem?._unifiedCard.cardId, "keke:keke-1");
	assert.equal(findUnifiedListCardForSource([toOnlineListCard(huiCard)], "afdian"), null);
});

test("replaceUnifiedListCard swaps the matching unified card in cached lists", () => {
	const original = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "gamebanana",
			sourceModId: "gb-1",
			title: "Camellya Blue Dress",
		}),
		"Other"
	);
	const updated = {
		...original,
		sources: [
			...original.sources,
			makeVariant({
				sourceId: "afdian",
				sourceModId: "afd-1",
				title: "Camellya Blue Dress Mirror Post",
				detailUrl: "https://afdian.net/a/bluearchive/post/fixture-camellya",
				author: "BlueArchive",
				isFreePublic: false,
			}),
		],
	};
	const untouched = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "keke",
			sourceModId: "keke-1",
			title: "Jinhsi School Uniform UI",
		}),
		"UI"
	);

	const next = replaceUnifiedListCard([toOnlineListCard(original), toOnlineListCard(untouched)], updated);

	assert.equal((next[0] as any)._unifiedCard.sources.length, 2);
	assert.equal((next[0] as any)._unifiedCard.sources[1].sourceId, "afdian");
	assert.equal((next[1] as any)._unifiedCard.cardId, untouched.cardId);
});

test("buildUnifiedAfdianDiscoveryQuery prefers unified display name and falls back to aliases", () => {
	const displayCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "hui",
			sourceModId: "hui-1",
			title: "Camellya Azure Outfit",
		}),
		"Other"
	);
	displayCard.displayName = "Camellya Blue Dress";
	const aliasCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "keke",
			sourceModId: "keke-1",
			title: "Jinhsi School Uniform UI",
		}),
		"UI"
	);
	aliasCard.displayName = "   ";

	assert.equal(buildUnifiedAfdianDiscoveryQuery(displayCard, null), "Camellya Blue Dress");
	assert.equal(
		buildUnifiedAfdianDiscoveryQuery(aliasCard, {
			card: aliasCard,
			commentsEnabled: false,
			updatesEnabled: true,
			aliases: ["Jinhsi UI Uniform"],
		}),
		"Jinhsi UI Uniform"
	);
	assert.equal(
		buildUnifiedAfdianDiscoveryQuery(
			{ ...aliasCard, displayName: "   ", originalNames: [] },
			{ card: aliasCard, commentsEnabled: false, updatesEnabled: false }
		),
		"Jinhsi School Uniform UI"
	);
});

test("findPreferredAfdianCandidate prefers author matches and falls back to the first candidate", () => {
	const candidates = [
		{
			title: "Camellya Blue Dress Mirror Post",
			detailUrl: "https://afdian.net/a/bluearchive/post/fixture-camellya",
			author: "BlueArchive",
		},
		{
			title: "Jinhsi School Uniform UI Pack",
			detailUrl: "https://afdian.net/a/uniformlab/post/fixture-jinhsi",
			author: "UniformLab",
		},
	];

	assert.equal(findPreferredAfdianCandidate(candidates, "UniformLab")?.detailUrl, candidates[1].detailUrl);
	assert.equal(findPreferredAfdianCandidate(candidates, "Missing Author")?.detailUrl, candidates[0].detailUrl);
	assert.equal(findPreferredAfdianCandidate([], "UniformLab"), null);
});

test("areAfdianCandidatesFresh only accepts candidates fetched for the current query", () => {
	assert.equal(areAfdianCandidatesFresh("Camellya Blue Dress", "Camellya Blue Dress"), true);
	assert.equal(areAfdianCandidatesFresh("Jinhsi School Uniform UI", "Camellya Blue Dress"), false);
	assert.equal(areAfdianCandidatesFresh("Jinhsi School Uniform UI", ""), false);
	assert.equal(areAfdianCandidatesFresh("", "Jinhsi School Uniform UI"), false);
});

test("buildUnified detail helpers prefer selected source assets and fall back safely", () => {
	const card = mergeUnifiedCardGroup(
		[
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "gamebanana",
					sourceModId: "gb-1",
					title: "Camellya Blue Dress",
					previewUrls: ["https://cdn.example.com/gb/camellya.jpg"],
					downloadOptions: [{ label: "GB", url: "https://downloads.example.com/gb.zip" }],
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "hui",
					sourceModId: "hui-1",
					title: "Camellya Azure Outfit",
					previewUrls: ["https://cdn.example.com/hui/camellya-1.jpg", "https://cdn.example.com/hui/camellya-2.jpg"],
					downloadOptions: [{ label: "Hui", url: "https://downloads.example.com/hui.zip" }],
				}),
				"Other"
			),
		],
		[]
	);

	assert.deepEqual(
		buildUnifiedDetailPreviewImages(card, "hui"),
		[
			{ _sBaseUrl: "https://cdn.example.com/hui", _sFile: "camellya-1.jpg" },
			{ _sBaseUrl: "https://cdn.example.com/hui", _sFile: "camellya-2.jpg" },
		]
	);
	assert.deepEqual(buildUnifiedDownloadOptions(card, "hui"), [{ label: "Hui", url: "https://downloads.example.com/hui.zip" }]);
	assert.deepEqual(buildUnifiedDownloadOptions(card, "afdian"), [{ label: "GB", url: "https://downloads.example.com/gb.zip" }]);
});

test("richer detail payload overrides selected source assets and links", () => {
	const card = mergeUnifiedCardGroup(
		[
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "gamebanana",
					sourceModId: "gb-1",
					title: "Camellya Blue Dress",
					detailUrl: "https://gamebanana.com/mods/1",
					previewUrls: ["https://cdn.example.com/gb/camellya.jpg"],
					downloadOptions: [{ label: "GB", url: "https://downloads.example.com/gb.zip" }],
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "hui",
					sourceModId: "hui-1",
					title: "Camellya Azure Outfit",
					detailUrl: "https://hui.example/mod/1",
					previewUrls: ["https://cdn.example.com/hui/camellya.jpg"],
					downloadOptions: [{ label: "Hui", url: "https://downloads.example.com/hui.zip" }],
				}),
				"Other"
			),
		],
		[]
	);
	const detail: UnifiedOnlineDetailLike = {
		card,
		commentsEnabled: true,
		updatesEnabled: true,
		links: [{ label: "聚合页", url: "https://unified.example/cards/camellya" }],
		sourceDetails: [
			{
				sourceId: "hui",
				title: "Camellya Azure Outfit Deluxe",
				author: "Rich Hui Author",
				detailUrl: "https://hui.example/mod/1/detail",
				previewUrls: ["https://detail.example.com/hui/cover.jpg"],
				downloadOptions: [{ label: "Rich Hui", url: "https://detail.example.com/hui.zip" }],
				links: [{ label: "Hui 说明", url: "https://hui.example/readme" }],
			},
		],
	};

	assert.equal(resolveUnifiedDetailSourceVariant(card, detail, "hui")?.title, "Camellya Azure Outfit Deluxe");
	assert.equal(resolveUnifiedDetailSourceVariant(card, detail, "hui")?.author, "Rich Hui Author");
	assert.deepEqual(buildUnifiedDetailPreviewImages(card, "hui", detail), [
		{ _sBaseUrl: "https://detail.example.com/hui", _sFile: "cover.jpg" },
	]);
	assert.deepEqual(buildUnifiedDownloadOptions(card, "hui", detail), [
		{ label: "Rich Hui", url: "https://detail.example.com/hui.zip" },
	]);
	assert.deepEqual(buildUnifiedDetailLinkRows(card, detail, "hui"), [
		{ label: "当前来源", url: "https://hui.example/mod/1/detail" },
		{ label: "聚合页", url: "https://unified.example/cards/camellya" },
		{ label: "Hui 说明", url: "https://hui.example/readme" },
	]);
});

test("richer detail helpers build overview and updates with optional-field fallbacks", () => {
	const card = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "hui",
			sourceModId: "hui-1",
			title: "Camellya Azure Outfit",
			detailUrl: "https://hui.example/mod/1",
		}),
		"Other"
	);
	const detail: UnifiedOnlineDetailLike = {
		card,
		commentsEnabled: true,
		updatesEnabled: true,
		summary: "聚合层面的统一摘要",
		aliases: ["Blue Dress", "Azure Outfit"],
		tags: ["清凉", "4K"],
		sourceDetails: [
			{
				sourceId: "hui",
				summary: "Hui 详情摘要",
				version: "v1.1",
				rawUpdatedAt: "2026-04-20T03:00:00Z",
				tags: ["精选", "高清"],
				stats: {
					likeCount: 9,
					downloadCount: 42,
				},
			},
		],
		updates: [
			{
				sourceId: "hui",
				title: "兼容 2.1",
				version: "v1.1",
				publishedAt: "2026-04-20T00:00:00Z",
				url: "https://hui.example/updates/1",
			},
		],
	};

	assert.deepEqual(buildUnifiedDetailOverviewRows(card, detail, "hui"), [
		{ label: "详情摘要", value: "Hui 详情摘要" },
		{ label: "别名", value: "Blue Dress / Azure Outfit" },
		{ label: "标签", value: "清凉 / 4K / 精选 / 高清" },
		{ label: "版本", value: "v1.1" },
		{ label: "最近更新", value: "2026-04-20T03:00:00Z" },
		{ label: "点赞", value: "9" },
		{ label: "下载", value: "42" },
	]);
	assert.deepEqual(buildUnifiedDetailUpdateRows(detail, "hui"), [
		{
			title: "兼容 2.1",
			version: "v1.1",
			publishedAt: "2026-04-20T00:00:00Z",
			summary: "",
			url: "https://hui.example/updates/1",
		},
	]);
	assert.deepEqual(buildUnifiedDetailUpdateRows(detail, "gamebanana"), []);
});

test("buildUnifiedSourceRefreshRows keeps card source order and fills missing entries as idle", () => {
	const card = mergeUnifiedCardGroup(
		[
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "gamebanana",
					sourceModId: "gb-1",
					title: "Camellya Blue Dress",
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "hui",
					sourceModId: "hui-1",
					title: "Camellya Azure Outfit",
				}),
				"Other"
			),
		],
		[]
	);

	const rows = buildUnifiedSourceRefreshRows(card, [
		{ sourceId: "hui", status: "success", message: "fixture ok" },
		{ sourceId: "afdian", status: "error", message: "ignored" },
	]);

	assert.deepEqual(rows, [
		{
			sourceId: "gamebanana",
			title: "Camellya Blue Dress",
			status: "idle",
			message: "",
			isPrimary: true,
		},
		{
			sourceId: "hui",
			title: "Camellya Azure Outfit",
			status: "success",
			message: "fixture ok",
			isPrimary: false,
		},
	]);
});

test("buildUnifiedDuplicateSummary formats readable confidence and reasons", () => {
	const card = {
		...createUnifiedCardFromVariant(makeVariant({ title: "Camellya Blue Dress" }), "Other"),
		duplicateScore: 0.94,
		duplicateReasons: ["translated-name", "preview-phash"],
	};

	assert.equal(buildUnifiedDuplicateSummary(card), "94.00% · 翻译标题匹配 / 预览图相似");
});

test("resolveUnifiedDetailCard prefers bridge detail card over list card", () => {
	const listCard = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "gamebanana",
			sourceModId: "gb-1",
			title: "Camellya Blue Dress",
		}),
		"Other"
	);
	const detailCard = {
		...listCard,
		displayName: "Camellya Blue Dress Detailed",
		duplicateReasons: ["translated-name"],
	};

	assert.equal(
		resolveUnifiedDetailCard(listCard, {
			card: detailCard,
			commentsEnabled: true,
			updatesEnabled: false,
		})?.displayName,
		"Camellya Blue Dress Detailed"
	);
	assert.equal(resolveUnifiedDetailCard(listCard, null)?.displayName, "Camellya Blue Dress");
});

test("buildUnifiedDetailCapabilityLabels maps detail flags into readable labels", () => {
	assert.deepEqual(
		buildUnifiedDetailCapabilityLabels({
			card: createUnifiedCardFromVariant(makeVariant(), "Other"),
			commentsEnabled: true,
			updatesEnabled: false,
		}),
		["支持评论", "不支持更新"]
	);
	assert.deepEqual(buildUnifiedDetailCapabilityLabels(null), ["详情能力未加载"]);
});

test("resolveUnifiedDetailSourceNote prefers selected source note and falls back to primary source", () => {
	const detail: UnifiedOnlineDetailLike = {
		card: createUnifiedCardFromVariant(
			makeVariant({
				sourceId: "gamebanana",
				sourceModId: "gb-1",
			}),
			"Other"
		),
		commentsEnabled: true,
		updatesEnabled: false,
		sourceSpecificNotes: {
			gamebanana: "<p>Primary note</p>",
			hui: "<p>Mirror note</p>",
		},
	};

	assert.equal(resolveUnifiedDetailSourceNote(detail, "hui"), "<p>Mirror note</p>");
	assert.equal(resolveUnifiedDetailSourceNote(detail, "afdian"), "<p>Primary note</p>");
	assert.equal(resolveUnifiedDetailSourceNote(null, "hui"), "");
});

test("buildUnifiedDuplicateEvidenceRows formats structured duplicate evidence details", () => {
	const card = {
		...createUnifiedCardFromVariant(makeVariant({ title: "Camellya Blue Dress" }), "Other"),
		duplicateScore: 0.94,
		duplicateReasons: ["translated-name", "preview-phash"],
		duplicateEvidence: {
			nameScore: 0.71,
			translatedNameScore: 0.94,
			translationGap: 0.06,
			previewHashDistance: 6,
			tempFileHashMatch: null,
			decision: "merge" as const,
		},
	};

	assert.deepEqual(buildUnifiedDuplicateEvidenceRows(card), [
		{ label: "原始标题分数", value: "71.00%" },
		{ label: "翻译标题分数", value: "94.00%" },
		{ label: "翻译差距", value: "6.00%" },
		{ label: "预览图距离", value: "6" },
		{ label: "临时文件比对", value: "未触发" },
		{ label: "决策", value: "合并" },
	]);
});

test("buildUnifiedDownloadQueueItem maps unified source download to legacy queue shape", () => {
	const card = createUnifiedCardFromVariant(
		makeVariant({
			sourceId: "hui",
			sourceModId: "hui-1",
			title: "Camellya Azure Outfit",
			previewUrls: ["https://cdn.example.com/hui/camellya.jpg"],
			rawUpdatedAt: "2026-04-21T03:45:00Z",
		}),
		"Other"
	);
	const item = buildUnifiedDownloadQueueItem({
		card,
		downloadOption: {
			label: "Mirror Download",
			url: "https://downloads.example.com/hui/camellya-azure-outfit.zip",
		},
		sourceRoute: "UnifiedCard/hui:hui-1",
		now: 1234567890,
	});

	assert.deepEqual(item, {
		status: "pending",
		addon: false,
		preview: "https://cdn.example.com/hui/camellya.jpg",
		category: "Other",
		source: "UnifiedCard/hui:hui-1",
		file: "https://downloads.example.com/hui/camellya-azure-outfit.zip",
		updated: Date.parse("2026-04-21T03:45:00Z"),
		name: "Camellya Azure Outfit",
		displayName: "Camellya Azure Outfit",
		fname: "camellya-azure-outfit.zip",
		requeueRounds: 0,
		createdAt: 1234567890,
	});
});

test("resolveUnifiedDetailViewState routes reusable GameBanana sources through legacy detail", () => {
	const card = mergeUnifiedCardGroup(
		[
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "gamebanana",
					sourceModId: "gb-1",
					title: "Camellya Blue Dress",
					detailUrl: "https://gamebanana.com/mods/593490",
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "hui",
					sourceModId: "hui-1",
					title: "Camellya Azure Outfit",
					detailUrl: "https://hui.example/mod/1",
				}),
				"Other"
			),
		],
		[]
	);

	const state = resolveUnifiedDetailViewState({
		selectedRoute: "UnifiedCard/gamebanana:camellya-blue-dress",
		card,
		detail: {
			card,
			commentsEnabled: true,
			updatesEnabled: true,
			primarySourceCanReuseLegacyDetail: true,
		},
		preferredSourceId: "gamebanana",
		legacyRouteResolver: (detailUrl) => (detailUrl === "https://gamebanana.com/mods/593490" ? "Mod/593490" : ""),
	});

	assert.equal(state.mode, "legacy-reuse");
	assert.equal(state.activeSource?.sourceId, "gamebanana");
	assert.equal(state.legacyReuseRoute, "Mod/593490");
	assert.equal(state.commentsTargetRoute, "Mod/593490");
	assert.equal(state.shouldReuseLegacyComments, true);
});

test("resolveUnifiedDetailViewState keeps non-GameBanana unified sources on generic detail", () => {
	const card = mergeUnifiedCardGroup(
		[
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "gamebanana",
					sourceModId: "gb-1",
					title: "Camellya Blue Dress",
					detailUrl: "https://gamebanana.com/mods/593490",
				}),
				"Other"
			),
			createUnifiedCardFromVariant(
				makeVariant({
					sourceId: "hui",
					sourceModId: "hui-1",
					title: "Camellya Azure Outfit",
					detailUrl: "https://hui.example/mod/1",
				}),
				"Other"
			),
		],
		[]
	);

	const state = resolveUnifiedDetailViewState({
		selectedRoute: "UnifiedCard/gamebanana:camellya-blue-dress",
		card,
		detail: {
			card,
			commentsEnabled: true,
			updatesEnabled: true,
			primarySourceCanReuseLegacyDetail: true,
		},
		preferredSourceId: "hui",
		legacyRouteResolver: () => "Mod/593490",
	});

	assert.equal(state.mode, "unified-generic");
	assert.equal(state.activeSource?.sourceId, "hui");
	assert.equal(state.legacyReuseRoute, "");
	assert.equal(state.commentsTargetRoute, "");
	assert.equal(state.shouldReuseLegacyComments, false);
});

test("resolveUnifiedDetailViewState preserves plain legacy routing for non-unified selections", () => {
	const state = resolveUnifiedDetailViewState({
		selectedRoute: "Mod/593490",
		card: null,
		detail: null,
		preferredSourceId: null,
		legacyRouteResolver: () => "",
	});

	assert.equal(state.mode, "legacy-plain");
	assert.equal(state.activeSource, null);
	assert.equal(state.legacyReuseRoute, "");
	assert.equal(state.commentsTargetRoute, "Mod/593490");
	assert.equal(state.shouldReuseLegacyComments, false);
});
