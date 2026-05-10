export type OnlineSourceId = "gamebanana" | "hui" | "keke" | "afdian";

export interface UnifiedDownloadOption {
	label: string;
	url: string;
}

export interface UnifiedSourceVariant {
	sourceId: OnlineSourceId;
	sourceModId: string;
	title: string;
	detailUrl: string;
	downloadOptions: UnifiedDownloadOption[];
	previewUrls: string[];
	author: string;
	isFreePublic: boolean;
	rawUpdatedAt: string;
}

export interface DuplicateEvidence {
	nameScore: number;
	translatedNameScore: number;
	translationGap: number;
	previewHashDistance: number | null;
	tempFileHashMatch: boolean | null;
	decision: "merge" | "separate" | "temp_compare";
}

export interface UnifiedOnlineCard {
	cardId: string;
	primarySourceId: OnlineSourceId;
	displayName: string;
	originalNames: string[];
	category: string;
	preview: string | null;
	sources: UnifiedSourceVariant[];
	duplicateScore: number;
	duplicateReasons: string[];
	duplicateEvidence?: DuplicateEvidence | null;
}

export interface UnifiedOnlineListCard {
	_idRow: string;
	_sModelName: "UnifiedCard";
	_sName: string;
	_sProfileUrl: string;
	_sInitialVisibility: "show";
	_nLikeCount: number;
	_nPostCount: number;
	_tsDateAdded?: number;
	_tsDateModified?: number;
	_aSubmitter: {
		_idRow: number;
		_sName: string;
		_bIsOnline: boolean;
		_sProfileUrl: string;
		_sAvatarUrl: string;
		_sHdAvatarUrl: string;
	};
	_aRootCategory: {
		_sName: string;
		_sProfileUrl: string;
		_sIconUrl: string;
	};
	_aPreviewMedia?: {
		_aImages?: Array<{
			_sBaseUrl: string;
			_sFile: string;
		}>;
	};
	_unifiedPreferredSourceId?: OnlineSourceId;
	_unifiedCard: UnifiedOnlineCard;
}

export interface UnifiedPreviewImage {
	_sBaseUrl: string;
	_sFile: string;
}

export interface UnifiedSourceRefreshRow {
	sourceId: OnlineSourceId;
	title: string;
	status: "idle" | "refreshing" | "success" | "error";
	message: string;
	isPrimary: boolean;
}

export interface UnifiedDuplicateEvidenceRow {
	label: string;
	value: string;
}

export interface UnifiedDetailLinkRow {
	label: string;
	url: string;
}

export interface UnifiedDetailFactRow {
	label: string;
	value: string;
}

export interface UnifiedOnlineDetailStats {
	likeCount?: number;
	downloadCount?: number;
	viewCount?: number;
	postCount?: number;
}

export interface UnifiedOnlineDetailSource {
	sourceId: OnlineSourceId;
	sourceModId?: string;
	title?: string;
	detailUrl?: string;
	downloadOptions?: UnifiedDownloadOption[];
	previewUrls?: string[];
	author?: string;
	isFreePublic?: boolean;
	rawUpdatedAt?: string;
	summary?: string | null;
	description?: string | null;
	descriptionHtml?: string | null;
	version?: string | null;
	tags?: string[];
	links?: UnifiedDetailLinkRow[];
	stats?: UnifiedOnlineDetailStats | null;
}

export interface UnifiedOnlineDetailUpdate {
	sourceId?: OnlineSourceId;
	title: string;
	version?: string | null;
	publishedAt?: string | null;
	summary?: string | null;
	url?: string | null;
}

export interface UnifiedDetailUpdateRow {
	title: string;
	version: string;
	publishedAt: string;
	summary: string;
	url: string;
}

interface BuildUnifiedDownloadQueueItemInput {
	card: UnifiedOnlineCard;
	sourceVariant?: UnifiedSourceVariant | null;
	downloadOption: UnifiedDownloadOption;
	sourceRoute: string;
	now: number;
}

export interface UnifiedOnlineDetailLike {
	card: UnifiedOnlineCard;
	commentsEnabled: boolean;
	updatesEnabled: boolean;
	summary?: string | null;
	description?: string | null;
	summaryHtml?: string | null;
	descriptionHtml?: string | null;
	aliases?: string[];
	tags?: string[];
	links?: UnifiedDetailLinkRow[];
	sourceDetails?: UnifiedOnlineDetailSource[];
	updates?: UnifiedOnlineDetailUpdate[];
	stats?: UnifiedOnlineDetailStats | null;
	sourceSpecificNotes?: Partial<Record<OnlineSourceId, string>>;
	primarySourceCanReuseLegacyDetail?: boolean;
}

export interface UnifiedResolvedDetailSourceVariant extends UnifiedSourceVariant {
	summary: string;
	description: string;
	descriptionHtml: string;
	version: string;
	tags: string[];
	links: UnifiedDetailLinkRow[];
	stats: UnifiedOnlineDetailStats | null;
}

export type UnifiedDetailViewMode = "legacy-plain" | "legacy-reuse" | "unified-generic";

interface ResolveUnifiedDetailViewStateInput {
	selectedRoute?: string | null;
	card?: UnifiedOnlineCard | null;
	detail?: UnifiedOnlineDetailLike | null;
	preferredSourceId?: OnlineSourceId | null;
	legacyRouteResolver: (detailUrl: string) => string;
}

export interface UnifiedDetailViewState {
	mode: UnifiedDetailViewMode;
	activeSource: UnifiedResolvedDetailSourceVariant | null;
	legacyReuseRoute: string;
	commentsTargetRoute: string;
	shouldReuseLegacyComments: boolean;
}

interface UnifiedSourceRefreshStatusLike {
	sourceId: OnlineSourceId;
	status: "idle" | "refreshing" | "success" | "error";
	message?: string;
}
export type LegacyOnlineListCard = {
	_idRow: number | string;
	_sModelName: string;
	_sName: string;
	_sInitialVisibility: string;
	_nLikeCount: number;
	_nPostCount?: number;
};

interface EvaluateDuplicateEvidenceInput {
	leftTitle: string;
	rightTitle: string;
	leftTranslatedTitle?: string;
	rightTranslatedTitle?: string;
	previewHashDistance?: number | null;
	tempFileHashMatch?: boolean | null;
	sameLanguage?: boolean;
}

const SOURCE_PRIORITY: Record<OnlineSourceId, number> = {
	gamebanana: 0,
	hui: 1,
	keke: 2,
	afdian: 3,
};

const NOISE_TERMS = [
	"mod",
	"mods",
	"ui",
	"3dmigoto",
	"nsfw",
	"sfw",
	"wuthering waves",
	"鸣潮",
];

export function normalizeOnlineName(input: string): string {
	return input
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\[[^\]]*]/g, " ")
		.replace(/\([^)]*\)/g, " ")
		.replace(/\b(?:ver|version|v)\s*\d+(?:\.\d+)*(?:[a-z]+)?\b/g, " ")
		.replace(/\bby\s+[a-z0-9_\-.]+\b/g, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.split(/\s+/)
		.filter(Boolean)
		.filter((token) => !NOISE_TERMS.includes(token))
		.join(" ")
		.trim();
}

function levenshtein(left: string, right: string): number {
	if (left === right) return 0;
	if (!left.length) return right.length;
	if (!right.length) return left.length;

	const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
	const next = new Array<number>(right.length + 1).fill(0);

	for (let i = 0; i < left.length; i++) {
		next[0] = i + 1;
		for (let j = 0; j < right.length; j++) {
			const cost = left[i] === right[j] ? 0 : 1;
			next[j + 1] = Math.min(next[j] + 1, prev[j + 1] + 1, prev[j] + cost);
		}
		for (let j = 0; j < next.length; j++) {
			prev[j] = next[j];
		}
	}

	return prev[right.length];
}

function similarity(left: string, right: string): number {
	const normalizedLeft = normalizeOnlineName(left);
	const normalizedRight = normalizeOnlineName(right);
	if (!normalizedLeft && !normalizedRight) return 1;
	if (!normalizedLeft || !normalizedRight) return 0;
	const longest = Math.max(normalizedLeft.length, normalizedRight.length);
	const charScore = 1 - levenshtein(normalizedLeft, normalizedRight) / longest;
	const leftTokens = normalizedLeft.split(" ").filter(Boolean);
	const rightTokens = normalizedRight.split(" ").filter(Boolean);
	const overlap = leftTokens.filter((token) => rightTokens.includes(token)).length;
	const tokenScore =
		leftTokens.length + rightTokens.length > 0 ? (2 * overlap) / (leftTokens.length + rightTokens.length) : 0;
	return Number(Math.max(charScore, tokenScore).toFixed(4));
}

export function evaluateDuplicateEvidence(input: EvaluateDuplicateEvidenceInput): DuplicateEvidence {
	const nameScore = similarity(input.leftTitle, input.rightTitle);
	const translatedNameScore =
		input.leftTranslatedTitle && input.rightTranslatedTitle
			? similarity(input.leftTranslatedTitle, input.rightTranslatedTitle)
			: 0;
	const translationGap =
		input.leftTranslatedTitle && input.rightTranslatedTitle ? Number((1 - translatedNameScore).toFixed(4)) : 1;
	const previewHashDistance = input.previewHashDistance ?? null;
	const tempFileHashMatch = input.tempFileHashMatch ?? null;

	if (input.sameLanguage !== false && nameScore >= 0.96) {
		return {
			nameScore,
			translatedNameScore,
			translationGap,
			previewHashDistance,
			tempFileHashMatch,
			decision: "merge",
		};
	}

	if (input.sameLanguage === false) {
		if (translatedNameScore < 0.82) {
			return {
				nameScore,
				translatedNameScore,
				translationGap,
				previewHashDistance: null,
				tempFileHashMatch,
				decision: "separate",
			};
		}

		if (translatedNameScore >= 0.92) {
			return {
				nameScore,
				translatedNameScore,
				translationGap,
				previewHashDistance,
				tempFileHashMatch,
				decision: "merge",
			};
		}

		if (translatedNameScore >= 0.86 && previewHashDistance !== null && previewHashDistance <= 8) {
			return {
				nameScore,
				translatedNameScore,
				translationGap,
				previewHashDistance,
				tempFileHashMatch,
				decision: "merge",
			};
		}

		if (translatedNameScore >= 0.84 && tempFileHashMatch) {
			return {
				nameScore,
				translatedNameScore,
				translationGap,
				previewHashDistance,
				tempFileHashMatch,
				decision: "merge",
			};
		}

		if (translatedNameScore >= 0.84) {
			return {
				nameScore,
				translatedNameScore,
				translationGap,
				previewHashDistance,
				tempFileHashMatch,
				decision: "temp_compare",
			};
		}
	}

	return {
		nameScore,
		translatedNameScore,
		translationGap,
		previewHashDistance,
		tempFileHashMatch,
		decision: "separate",
	};
}

export function createUnifiedCardFromVariant(source: UnifiedSourceVariant, category: string): UnifiedOnlineCard {
	return {
		cardId: `${source.sourceId}:${source.sourceModId}`,
		primarySourceId: source.sourceId,
		displayName: source.title,
		originalNames: [source.title],
		category,
		preview: source.previewUrls[0] || null,
		sources: [source],
		duplicateScore: 0,
		duplicateReasons: [],
		duplicateEvidence: null,
	};
}

export function buildUnifiedCardRoute(cardId: string): string {
	return `UnifiedCard/${cardId}`;
}

export function isUnifiedCardRoute(route: string): boolean {
	return route.startsWith("UnifiedCard/");
}

export function resolveUnifiedSourceVariant(
	card: UnifiedOnlineCard,
	preferredSourceId?: OnlineSourceId | null
): UnifiedSourceVariant | null {
	if (preferredSourceId) {
		const preferred = card.sources.find((source) => source.sourceId === preferredSourceId);
		if (preferred) return preferred;
	}

	return (
		card.sources.find((source) => source.sourceId === card.primarySourceId) ||
		card.sources[0] ||
		null
	);
}

export function findUnifiedGenericFallbackSourceId(
	card: UnifiedOnlineCard,
	excludedSourceId: OnlineSourceId = "gamebanana",
	skipSourceIds: OnlineSourceId[] = []
): OnlineSourceId | null {
	const skipSet = new Set<OnlineSourceId>([excludedSourceId, ...skipSourceIds]);
	return card.sources.find((source) => !skipSet.has(source.sourceId))?.sourceId || null;
}

export function findUnifiedCardRouteForSource(
	items: Array<UnifiedOnlineListCard | LegacyOnlineListCard> | null | undefined,
	sourceId: OnlineSourceId
): string | null {
	const matched = findUnifiedListCardForSource(items, sourceId);
	return matched?._sProfileUrl || null;
}

export function buildUnifiedAfdianDiscoveryQuery(
	card: UnifiedOnlineCard,
	detail: UnifiedOnlineDetailLike | null | undefined
): string {
	const preferred =
		card.displayName?.trim() ||
		detail?.aliases?.find((alias) => alias?.trim())?.trim() ||
		card.originalNames.find((name) => name?.trim())?.trim() ||
		card.sources[0]?.title?.trim() ||
		"";
	return preferred;
}

export function findPreferredAfdianCandidate(
	candidates: Array<{ title: string; detailUrl: string; author: string }>,
	preferredAuthor?: string | null
): { title: string; detailUrl: string; author: string } | null {
	if (!candidates.length) {
		return null;
	}

	const normalizedPreferredAuthor = preferredAuthor?.trim().toLowerCase() || "";
	if (normalizedPreferredAuthor) {
		const matched = candidates.find((candidate) => candidate.author.trim().toLowerCase() === normalizedPreferredAuthor);
		if (matched) {
			return matched;
		}
	}

	return candidates[0];
}

export function areAfdianCandidatesFresh(activeQuery: string, loadedQuery: string): boolean {
	return Boolean(activeQuery.trim()) && activeQuery.trim() === loadedQuery.trim();
}

export function findUnifiedListCardForSource(
	items: Array<UnifiedOnlineListCard | LegacyOnlineListCard> | null | undefined,
	sourceId: OnlineSourceId
): UnifiedOnlineListCard | null {
	if (!items || items.length === 0) {
		return null;
	}

	const matched = items.find(
		(item): item is UnifiedOnlineListCard =>
			item._sModelName === "UnifiedCard" &&
			"_unifiedCard" in item &&
			item._unifiedCard.sources.some((source) => source.sourceId === sourceId)
	);
	return matched || null;
}

export function replaceUnifiedListCard(
	items: Array<UnifiedOnlineListCard | LegacyOnlineListCard> | null | undefined,
	card: UnifiedOnlineCard
): Array<UnifiedOnlineListCard | LegacyOnlineListCard> {
	if (!items?.length) {
		return items || [];
	}

	const route = buildUnifiedCardRoute(card.cardId);
	return items.map((item) =>
		item._sModelName === "UnifiedCard" && "_sProfileUrl" in item && item._sProfileUrl === route ? toOnlineListCard(card) : item
	);
}

function findUnifiedDetailSource(
	detail: UnifiedOnlineDetailLike | null | undefined,
	card: UnifiedOnlineCard,
	preferredSourceId?: OnlineSourceId | null
): UnifiedOnlineDetailSource | null {
	const preferredId = preferredSourceId || card.primarySourceId;
	const sourceDetails = detail?.sourceDetails || [];
	return (
		sourceDetails.find((source) => source.sourceId === preferredId) ||
		sourceDetails.find((source) => source.sourceId === card.primarySourceId) ||
		sourceDetails[0] ||
		null
	);
}

function uniqueDetailValues(values: Array<string | null | undefined>): string[] {
	return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function appendDetailLink(
	rows: UnifiedDetailLinkRow[],
	seen: Set<string>,
	label: string,
	url?: string | null
) {
	const normalizedUrl = url?.trim() || "";
	if (!normalizedUrl || seen.has(normalizedUrl)) return;
	seen.add(normalizedUrl);
	rows.push({ label, url: normalizedUrl });
}

export function resolveUnifiedDetailSourceVariant(
	card: UnifiedOnlineCard,
	detail: UnifiedOnlineDetailLike | null | undefined,
	preferredSourceId?: OnlineSourceId | null
): UnifiedResolvedDetailSourceVariant | null {
	const baseSource = resolveUnifiedSourceVariant(card, preferredSourceId);
	if (!baseSource) {
		return null;
	}

	const detailSource = findUnifiedDetailSource(detail, card, preferredSourceId);
	return {
		...baseSource,
		sourceId: detailSource?.sourceId || baseSource.sourceId,
		sourceModId: detailSource?.sourceModId || baseSource.sourceModId,
		title: detailSource?.title || baseSource.title,
		detailUrl: detailSource?.detailUrl || baseSource.detailUrl,
		downloadOptions:
			detailSource?.downloadOptions && detailSource.downloadOptions.length > 0
				? detailSource.downloadOptions
				: baseSource.downloadOptions,
		previewUrls:
			detailSource?.previewUrls && detailSource.previewUrls.length > 0
				? detailSource.previewUrls
				: baseSource.previewUrls,
		author: detailSource?.author || baseSource.author,
		isFreePublic: detailSource?.isFreePublic ?? baseSource.isFreePublic,
		rawUpdatedAt: detailSource?.rawUpdatedAt || baseSource.rawUpdatedAt,
		summary: detailSource?.summary || detail?.summary || "",
		description: detailSource?.description || detail?.description || "",
		descriptionHtml: detailSource?.descriptionHtml || detail?.descriptionHtml || "",
		version: detailSource?.version || "",
		tags: uniqueDetailValues([...(detail?.tags || []), ...(detailSource?.tags || [])]),
		links: [...(detailSource?.links || [])],
		stats: detailSource?.stats || detail?.stats || null,
	};
}

function mapPreviewUrlToImage(previewUrl: string): UnifiedPreviewImage | null {
	try {
		const parsed = new URL(previewUrl);
		const pathParts = parsed.pathname.split("/").filter(Boolean);
		const file = pathParts.pop() || "";
		if (!file) return null;

		return {
			_sBaseUrl: `${parsed.origin}${pathParts.length ? `/${pathParts.join("/")}` : ""}`,
			_sFile: file,
		};
	} catch {
		return null;
	}
}

export function buildUnifiedDetailPreviewImages(
	card: UnifiedOnlineCard,
	preferredSourceId?: OnlineSourceId | null,
	detail?: UnifiedOnlineDetailLike | null
): UnifiedPreviewImage[] {
	const activeSource = resolveUnifiedDetailSourceVariant(card, detail, preferredSourceId);
	const activeImages = (activeSource?.previewUrls || [])
		.map(mapPreviewUrlToImage)
		.filter((image): image is UnifiedPreviewImage => image !== null);
	if (activeImages.length > 0) return activeImages;

	return card.sources
		.flatMap((source) => source.previewUrls)
		.map(mapPreviewUrlToImage)
		.filter((image): image is UnifiedPreviewImage => image !== null);
}

export function buildUnifiedDownloadOptions(
	card: UnifiedOnlineCard,
	preferredSourceId?: OnlineSourceId | null,
	detail?: UnifiedOnlineDetailLike | null
): UnifiedDownloadOption[] {
	const activeSource = resolveUnifiedDetailSourceVariant(card, detail, preferredSourceId);
	if (activeSource?.downloadOptions?.length) {
		return activeSource.downloadOptions;
	}

	return card.sources.find((source) => source.downloadOptions.length > 0)?.downloadOptions || [];
}

export function buildUnifiedDetailOverviewRows(
	card: UnifiedOnlineCard,
	detail: UnifiedOnlineDetailLike | null,
	preferredSourceId?: OnlineSourceId | null
): UnifiedDetailFactRow[] {
	if (!detail) {
		return [];
	}

	const activeSource = resolveUnifiedDetailSourceVariant(card, detail, preferredSourceId);
	const rows: UnifiedDetailFactRow[] = [];
	const summary = activeSource?.summary || detail.summary || "";
	if (summary) {
		rows.push({ label: "详情摘要", value: summary });
	}

	const aliases = uniqueDetailValues(detail.aliases || []);
	if (aliases.length > 0) {
		rows.push({ label: "别名", value: aliases.join(" / ") });
	}

	const tags = uniqueDetailValues([...(detail.tags || []), ...(activeSource?.tags || [])]);
	if (tags.length > 0) {
		rows.push({ label: "标签", value: tags.join(" / ") });
	}

	if (activeSource?.version) {
		rows.push({ label: "版本", value: activeSource.version });
	}

	if (activeSource?.rawUpdatedAt) {
		rows.push({ label: "最近更新", value: activeSource.rawUpdatedAt });
	}

	const stats = activeSource?.stats || detail.stats || null;
	if (typeof stats?.likeCount === "number") {
		rows.push({ label: "点赞", value: String(stats.likeCount) });
	}
	if (typeof stats?.downloadCount === "number") {
		rows.push({ label: "下载", value: String(stats.downloadCount) });
	}
	if (typeof stats?.viewCount === "number") {
		rows.push({ label: "浏览", value: String(stats.viewCount) });
	}
	if (typeof stats?.postCount === "number") {
		rows.push({ label: "帖子", value: String(stats.postCount) });
	}

	return rows;
}

export function buildUnifiedDetailLinkRows(
	card: UnifiedOnlineCard,
	detail: UnifiedOnlineDetailLike | null,
	preferredSourceId?: OnlineSourceId | null
): UnifiedDetailLinkRow[] {
	if (!detail) {
		return [];
	}

	const activeSource = resolveUnifiedDetailSourceVariant(card, detail, preferredSourceId);
	const rows: UnifiedDetailLinkRow[] = [];
	const seen = new Set<string>();

	appendDetailLink(rows, seen, "当前来源", activeSource?.detailUrl);
	for (const link of detail.links || []) {
		appendDetailLink(rows, seen, link.label || "相关链接", link.url);
	}
	for (const link of activeSource?.links || []) {
		appendDetailLink(rows, seen, link.label || "来源链接", link.url);
	}

	return rows;
}

export function buildUnifiedDetailUpdateRows(
	detail: UnifiedOnlineDetailLike | null,
	preferredSourceId?: OnlineSourceId | null
): UnifiedDetailUpdateRow[] {
	if (!detail) {
		return [];
	}

	return (detail.updates || [])
		.filter((update) => !preferredSourceId || !update.sourceId || update.sourceId === preferredSourceId)
		.map((update) => ({
			title: update.title,
			version: update.version || "",
			publishedAt: update.publishedAt || "",
			summary: update.summary || "",
			url: update.url || "",
		}));
}

export function buildUnifiedSourceRefreshRows(
	card: UnifiedOnlineCard,
	statuses: UnifiedSourceRefreshStatusLike[]
): UnifiedSourceRefreshRow[] {
	return card.sources.map((source) => {
		const matched = statuses.find((status) => status.sourceId === source.sourceId);
		return {
			sourceId: source.sourceId,
			title: source.title,
			status: matched?.status || "idle",
			message: matched?.message || "",
			isPrimary: source.sourceId === card.primarySourceId,
		};
	});
}

function formatUnifiedDuplicateReason(reason: string): string {
	switch (reason) {
		case "translated-name":
			return "翻译标题匹配";
		case "preview-phash":
			return "预览图相似";
		case "temp-file":
			return "临时文件一致";
		case "name":
			return "原始标题匹配";
		case "temp_compare":
			return "待临时比对确认";
		case "separate":
			return "保持分开展示";
		default:
			return reason;
	}
}

export function buildUnifiedDuplicateSummary(card: UnifiedOnlineCard): string {
	if (!card.duplicateReasons.length || card.duplicateScore <= 0) {
		return "单来源或未触发自动合并";
	}

	const reasons = card.duplicateReasons.map(formatUnifiedDuplicateReason).join(" / ");
	return `${(card.duplicateScore * 100).toFixed(2)}% · ${reasons}`;
}

function formatUnifiedDecision(decision: DuplicateEvidence["decision"]): string {
	switch (decision) {
		case "merge":
			return "合并";
		case "separate":
			return "分开";
		case "temp_compare":
			return "待临时比对";
		default:
			return decision;
	}
}

export function buildUnifiedDuplicateEvidenceRows(card: UnifiedOnlineCard): UnifiedDuplicateEvidenceRow[] {
	const evidence = card.duplicateEvidence;
	if (!evidence) {
		return [];
	}

	return [
		{ label: "原始标题分数", value: `${(evidence.nameScore * 100).toFixed(2)}%` },
		{ label: "翻译标题分数", value: `${(evidence.translatedNameScore * 100).toFixed(2)}%` },
		{ label: "翻译差距", value: `${(evidence.translationGap * 100).toFixed(2)}%` },
		{ label: "预览图距离", value: evidence.previewHashDistance === null ? "未触发" : String(evidence.previewHashDistance) },
		{ label: "临时文件比对", value: evidence.tempFileHashMatch === null ? "未触发" : evidence.tempFileHashMatch ? "一致" : "不一致" },
		{ label: "决策", value: formatUnifiedDecision(evidence.decision) },
	];
}

function deriveUnifiedDownloadFileName(url: string): string {
	try {
		const parsed = new URL(url);
		const pathname = parsed.pathname.split("/").filter(Boolean);
		return pathname[pathname.length - 1] || "download.bin";
	} catch {
		return "download.bin";
	}
}

export function buildUnifiedDownloadQueueItem(input: BuildUnifiedDownloadQueueItemInput) {
	const activeSource = input.sourceVariant || resolveUnifiedSourceVariant(input.card, input.card.primarySourceId);
	return {
		status: "pending" as const,
		addon: false,
		preview: activeSource?.previewUrls[0] || input.card.preview || "",
		category: input.card.category,
		source: input.sourceRoute,
		file: input.downloadOption.url,
		updated: Date.parse(activeSource?.rawUpdatedAt || "") || input.now,
		name: input.card.displayName,
		displayName: input.card.displayName,
		fname: deriveUnifiedDownloadFileName(input.downloadOption.url),
		requeueRounds: 0,
		createdAt: input.now,
	};
}

export function resolveUnifiedDetailCard(
	listCard: UnifiedOnlineCard | null,
	detail: UnifiedOnlineDetailLike | null
): UnifiedOnlineCard | null {
	return detail?.card || listCard;
}

export function buildUnifiedDetailCapabilityLabels(detail: UnifiedOnlineDetailLike | null): string[] {
	if (!detail) {
		return ["详情能力未加载"];
	}

	return [
		detail.commentsEnabled ? "支持评论" : "不支持评论",
		detail.updatesEnabled ? "支持更新" : "不支持更新",
	];
}

export function resolveUnifiedDetailSourceNote(
	detail: UnifiedOnlineDetailLike | null,
	preferredSourceId?: OnlineSourceId | null
): string {
	if (!detail?.sourceSpecificNotes) {
		return "";
	}

	if (preferredSourceId && detail.sourceSpecificNotes[preferredSourceId]) {
		return detail.sourceSpecificNotes[preferredSourceId] || "";
	}

	return detail.sourceSpecificNotes[detail.card.primarySourceId] || "";
}

export function resolveUnifiedDetailViewState(
	input: ResolveUnifiedDetailViewStateInput
): UnifiedDetailViewState {
	const selectedRoute = input.selectedRoute || "";
	if (!isUnifiedCardRoute(selectedRoute) || !input.card) {
		return {
			mode: "legacy-plain",
			activeSource: null,
			legacyReuseRoute: "",
			commentsTargetRoute: selectedRoute,
			shouldReuseLegacyComments: false,
		};
	}

	const activeSource = resolveUnifiedDetailSourceVariant(input.card, input.detail, input.preferredSourceId);
	const canReuseLegacyDetail = Boolean(
		activeSource?.sourceId === "gamebanana" &&
			input.detail?.primarySourceCanReuseLegacyDetail &&
			input.legacyRouteResolver(activeSource.detailUrl || "")
	);
	const legacyReuseRoute = canReuseLegacyDetail ? input.legacyRouteResolver(activeSource?.detailUrl || "") : "";

	return {
		mode: canReuseLegacyDetail ? "legacy-reuse" : "unified-generic",
		activeSource,
		legacyReuseRoute,
		commentsTargetRoute: canReuseLegacyDetail ? legacyReuseRoute : "",
		shouldReuseLegacyComments: canReuseLegacyDetail,
	};
}

export function toOnlineListCard(card: UnifiedOnlineCard): UnifiedOnlineListCard {
	const previewImage = card.preview ? mapPreviewUrlToImage(card.preview) : null;

	return {
		_idRow: card.cardId,
		_sModelName: "UnifiedCard",
		_sName: card.displayName,
		_sProfileUrl: buildUnifiedCardRoute(card.cardId),
		_sInitialVisibility: "show",
		_nLikeCount: 0,
		_nPostCount: 0,
		_tsDateModified: card.sources
			.map((source) => Date.parse(source.rawUpdatedAt))
			.filter((value) => Number.isFinite(value))
			.sort((left, right) => right - left)[0],
		_aSubmitter: {
			_idRow: 0,
			_sName: card.sources[0]?.author || "",
			_bIsOnline: false,
			_sProfileUrl: "",
			_sAvatarUrl: "",
			_sHdAvatarUrl: "",
		},
		_aRootCategory: {
			_sName: card.category,
			_sProfileUrl: "",
			_sIconUrl: "",
		},
		...(previewImage
			? {
					_aPreviewMedia: {
						_aImages: [
							{
								_sBaseUrl: previewImage._sBaseUrl,
								_sFile: previewImage._sFile,
							},
						],
					},
				}
			: {}),
		_unifiedCard: card,
	};
}

export function resolveUnifiedOnlineList(
	unifiedCards: UnifiedOnlineCard[] | null | undefined,
	legacyCards: LegacyOnlineListCard[],
	options: { appendLegacy?: boolean } = {}
): Array<UnifiedOnlineListCard | LegacyOnlineListCard> {
	if (!unifiedCards || unifiedCards.length === 0) return legacyCards;
	const unifiedList = unifiedCards.map(toOnlineListCard);
	if (!options.appendLegacy) return unifiedList;

	const unifiedGameBananaIds = new Set(
		unifiedCards
			.flatMap((card) => card.sources)
			.filter((source) => source.sourceId === "gamebanana")
			.map((source) => String(source.sourceModId))
	);
	const remainingLegacy = legacyCards.filter((card) => {
		return card._sModelName !== "Mod" || !unifiedGameBananaIds.has(String(card._idRow));
	});
	return [...unifiedList, ...remainingLegacy];
}

export function mergeUnifiedCardGroup(cards: UnifiedOnlineCard[], evidence: DuplicateEvidence[]): UnifiedOnlineCard {
	const orderedCards = [...cards].sort((left, right) => {
		return SOURCE_PRIORITY[left.primarySourceId] - SOURCE_PRIORITY[right.primarySourceId];
	});
	const primary = orderedCards[0];
	const allSources = orderedCards
		.flatMap((card) => card.sources)
		.sort((left, right) => SOURCE_PRIORITY[left.sourceId] - SOURCE_PRIORITY[right.sourceId]);
	const topScore = evidence.reduce((max, item) => Math.max(max, item.translatedNameScore || item.nameScore), 0);
	const duplicateReasons = evidence.map((item) => {
		if (item.decision === "merge" && item.translatedNameScore >= 0.92) return "translated-name";
		if (item.decision === "merge" && item.previewHashDistance !== null && item.previewHashDistance <= 8) return "preview-phash";
		if (item.decision === "merge" && item.tempFileHashMatch) return "temp-file";
		if (item.decision === "merge") return "name";
		return item.decision;
	});

	return {
		cardId: primary.cardId,
		primarySourceId: primary.primarySourceId,
		displayName: primary.displayName,
		originalNames: Array.from(new Set(orderedCards.flatMap((card) => card.originalNames))),
		category: primary.category,
		preview: primary.preview || allSources.find((source) => source.previewUrls[0])?.previewUrls[0] || null,
		sources: allSources,
		duplicateScore: Number(topScore.toFixed(4)),
		duplicateReasons,
		duplicateEvidence: evidence[0] || null,
	};
}
