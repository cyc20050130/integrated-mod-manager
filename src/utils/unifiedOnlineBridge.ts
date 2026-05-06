import { invoke } from "@tauri-apps/api/core";

import type { Games } from "./types";
import type {
	DuplicateEvidence,
	OnlineSourceId,
	UnifiedDetailLinkRow,
	UnifiedOnlineCard,
	UnifiedOnlineDetailLike,
	UnifiedOnlineDetailSource,
	UnifiedOnlineDetailUpdate,
	UnifiedOnlineDetailStats,
} from "./unifiedOnline";

export type OnlineSourceFilter = "all" | OnlineSourceId;

export interface UnifiedOnlineListParams {
	path: string;
	source: OnlineSourceFilter;
	searchTerm?: string;
	sort?: string;
}

export type UnifiedOnlineDetail = UnifiedOnlineDetailLike;

interface RawUnifiedSourceSpecificNote {
	sourceId: OnlineSourceId;
	label?: string | null;
	contentHtml?: string | null;
}

interface RawUnifiedOnlineDetail extends Omit<UnifiedOnlineDetail, "sourceSpecificNotes"> {
	sourceSpecificNotes?: RawUnifiedSourceSpecificNote[] | Partial<Record<OnlineSourceId, string>>;
}

export interface UnifiedRefreshStatus {
	sourceId: OnlineSourceId;
	status: "idle" | "refreshing" | "success" | "error";
	message?: string;
}

export interface AfdianDiscoveryResult {
	candidates: Array<{
		title: string;
		detailUrl: string;
		author: string;
	}>;
}

export interface TempDuplicateCompareResult {
	evidence: DuplicateEvidence;
}

export function shouldUseUnifiedWwOnline(game: Games): boolean {
	return game === "WW";
}

export function normalizeOnlineSourceFilter(value: string): OnlineSourceFilter {
	return value === "gamebanana" || value === "hui" || value === "keke" || value === "afdian" ? value : "all";
}

export function buildUnifiedOnlineCacheKey(path: string, source: OnlineSourceFilter): string {
	return `ww-unified:${source}:${path}`;
}

function normalizeDetailLinks(links?: UnifiedDetailLinkRow[] | null): UnifiedDetailLinkRow[] {
	return (links || []).filter((link) => Boolean(link?.label) && Boolean(link?.url));
}

function normalizeDetailStats(stats?: UnifiedOnlineDetailStats | null): UnifiedOnlineDetailStats | null {
	return stats || null;
}

function normalizeDetailSource(source: UnifiedOnlineDetailSource): UnifiedOnlineDetailSource {
	return {
		...source,
		previewUrls: [...(source.previewUrls || [])],
		downloadOptions: [...(source.downloadOptions || [])],
		tags: [...(source.tags || [])],
		links: normalizeDetailLinks(source.links),
		summary: source.summary ?? null,
		description: source.description ?? null,
		descriptionHtml: source.descriptionHtml ?? null,
		version: source.version ?? null,
		stats: normalizeDetailStats(source.stats),
	};
}

function normalizeDetailUpdate(update: UnifiedOnlineDetailUpdate): UnifiedOnlineDetailUpdate {
	return {
		...update,
		version: update.version ?? null,
		publishedAt: update.publishedAt ?? null,
		summary: update.summary ?? null,
		url: update.url ?? null,
	};
}

function normalizeSourceSpecificNotes(
	sourceSpecificNotes?: RawUnifiedOnlineDetail["sourceSpecificNotes"]
): Partial<Record<OnlineSourceId, string>> {
	if (!sourceSpecificNotes) {
		return {};
	}

	if (Array.isArray(sourceSpecificNotes)) {
		return sourceSpecificNotes.reduce<Partial<Record<OnlineSourceId, string>>>((result, note) => {
			if (note?.sourceId && note.contentHtml) {
				result[note.sourceId] = note.contentHtml;
			}
			return result;
		}, {});
	}

	return sourceSpecificNotes;
}

export function normalizeUnifiedOnlineDetail(detail: RawUnifiedOnlineDetail): UnifiedOnlineDetail {
	return {
		...detail,
		summary: detail.summary ?? null,
		description: detail.description ?? null,
		summaryHtml: detail.summaryHtml ?? null,
		descriptionHtml: detail.descriptionHtml ?? null,
		aliases: [...(detail.aliases || [])],
		tags: [...(detail.tags || [])],
		links: normalizeDetailLinks(detail.links),
		sourceDetails: (detail.sourceDetails || []).map(normalizeDetailSource),
		updates: (detail.updates || []).map(normalizeDetailUpdate),
		stats: normalizeDetailStats(detail.stats),
		sourceSpecificNotes: normalizeSourceSpecificNotes(detail.sourceSpecificNotes),
	};
}

export async function listUnifiedWwCards(params: UnifiedOnlineListParams): Promise<UnifiedOnlineCard[]> {
	return invoke("list_unified_ww_cards", { params });
}

export async function getUnifiedWwCardDetail(cardId: string): Promise<UnifiedOnlineDetail> {
	const detail = await invoke<RawUnifiedOnlineDetail>("get_unified_ww_card_detail", { cardId });
	return normalizeUnifiedOnlineDetail(detail);
}

export async function refreshUnifiedWwSources(source?: OnlineSourceId): Promise<UnifiedRefreshStatus[]> {
	return invoke("refresh_unified_ww_sources", { sourceId: source ?? null });
}

export async function discoverAfdianCandidates(query: string): Promise<AfdianDiscoveryResult> {
	return invoke("discover_afdian_candidates", { query });
}

export async function attachAfdianCandidateToUnifiedCard(
	cardId: string,
	detailUrl: string
): Promise<UnifiedOnlineDetail> {
	const detail = await invoke<RawUnifiedOnlineDetail>("attach_afdian_candidate_to_unified_card", {
		cardId,
		detailUrl,
	});
	return normalizeUnifiedOnlineDetail(detail);
}

export async function detachAfdianSourceFromUnifiedCard(cardId: string): Promise<UnifiedOnlineDetail> {
	const detail = await invoke<RawUnifiedOnlineDetail>("detach_afdian_source_from_unified_card", {
		cardId,
	});
	return normalizeUnifiedOnlineDetail(detail);
}

export async function runTempDuplicateCompare(
	leftSourceId: OnlineSourceId,
	leftSourceModId: string,
	rightSourceId: OnlineSourceId,
	rightSourceModId: string
): Promise<TempDuplicateCompareResult> {
	return invoke("run_temp_duplicate_compare", {
		leftSourceId,
		leftSourceModId,
		rightSourceId,
		rightSourceModId,
	});
}
