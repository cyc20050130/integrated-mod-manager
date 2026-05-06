use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
};
use tauri::{path::BaseDirectory, AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDownloadOption {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSourceVariant {
    pub source_id: String,
    pub source_mod_id: String,
    pub title: String,
    pub detail_url: String,
    pub download_options: Vec<UnifiedDownloadOption>,
    pub preview_urls: Vec<String>,
    pub author: String,
    pub is_free_public: bool,
    pub raw_updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedOnlineCard {
    pub card_id: String,
    pub primary_source_id: String,
    pub display_name: String,
    pub original_names: Vec<String>,
    pub category: String,
    pub preview: Option<String>,
    pub sources: Vec<UnifiedSourceVariant>,
    pub duplicate_score: f64,
    pub duplicate_reasons: Vec<String>,
    #[serde(default)]
    pub duplicate_evidence: Option<DuplicateEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateEvidence {
    pub name_score: f64,
    pub translated_name_score: f64,
    pub translation_gap: f64,
    pub preview_hash_distance: Option<i32>,
    pub temp_file_hash_match: Option<bool>,
    pub decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedOnlineListParams {
    pub path: String,
    pub source: String,
    pub search_term: Option<String>,
    pub sort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedOnlineDetail {
    pub card: UnifiedOnlineCard,
    pub comments_enabled: bool,
    pub updates_enabled: bool,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub summary_html: Option<String>,
    #[serde(default)]
    pub description_html: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub links: Vec<UnifiedDetailLink>,
    #[serde(default)]
    pub source_details: Vec<UnifiedOnlineDetailSource>,
    #[serde(default)]
    pub updates: Vec<UnifiedOnlineDetailUpdate>,
    #[serde(default)]
    pub stats: Option<UnifiedOnlineDetailStats>,
    #[serde(default)]
    pub source_specific_notes: Vec<UnifiedSourceSpecificNote>,
    #[serde(default)]
    pub primary_source_can_reuse_legacy_detail: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedOnlineDetailStats {
    #[serde(default)]
    pub like_count: Option<u64>,
    #[serde(default)]
    pub download_count: Option<u64>,
    #[serde(default)]
    pub view_count: Option<u64>,
    #[serde(default)]
    pub post_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDetailLink {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedOnlineDetailSource {
    pub source_id: String,
    #[serde(default)]
    pub source_mod_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub detail_url: Option<String>,
    #[serde(default)]
    pub download_options: Vec<UnifiedDownloadOption>,
    #[serde(default)]
    pub preview_urls: Vec<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub is_free_public: Option<bool>,
    #[serde(default)]
    pub raw_updated_at: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub description_html: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub links: Vec<UnifiedDetailLink>,
    #[serde(default)]
    pub stats: Option<UnifiedOnlineDetailStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedOnlineDetailUpdate {
    #[serde(default)]
    pub source_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedRefreshStatus {
    pub source_id: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfdianCandidate {
    pub title: String,
    pub detail_url: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfdianDiscoveryResult {
    pub candidates: Vec<AfdianCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempDuplicateCompareResult {
    pub evidence: DuplicateEvidence,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnifiedCacheSnapshot {
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub cards: Vec<UnifiedCacheCardRecord>,
    #[serde(default)]
    pub refresh_status: Vec<UnifiedRefreshStatus>,
    #[serde(default)]
    pub afdian_candidates: Vec<AfdianCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum UnifiedCacheSourceKind {
    Missing,
    PersistedCache,
    DevFixture,
}

#[derive(Debug, Clone)]
struct LoadedUnifiedCacheSnapshot {
    snapshot: UnifiedCacheSnapshot,
    source_kind: UnifiedCacheSourceKind,
}

#[derive(Debug, Clone)]
struct UnifiedCacheCandidate {
    path: PathBuf,
    source_kind: UnifiedCacheSourceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnifiedCacheCardRecord {
    #[serde(flatten)]
    pub card: UnifiedOnlineCard,
    #[serde(default)]
    pub detail: Option<UnifiedDetailSupplement>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDetailSupplement {
    #[serde(default)]
    pub comments_enabled: bool,
    #[serde(default)]
    pub updates_enabled: bool,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub summary_html: Option<String>,
    #[serde(default)]
    pub description_html: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub links: Vec<UnifiedDetailLink>,
    #[serde(default)]
    pub source_details: Vec<UnifiedOnlineDetailSource>,
    #[serde(default)]
    pub updates: Vec<UnifiedOnlineDetailUpdate>,
    #[serde(default)]
    pub stats: Option<UnifiedOnlineDetailStats>,
    #[serde(default)]
    pub source_specific_notes: Vec<UnifiedSourceSpecificNote>,
    #[serde(default)]
    pub primary_source_can_reuse_legacy_detail: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSourceSpecificNote {
    pub source_id: String,
    pub label: String,
    pub content_html: String,
}

const DEFAULT_SOURCE_IDS: [&str; 4] = ["gamebanana", "hui", "keke", "afdian"];

fn parse_unified_cache_snapshot(payload: &str) -> Result<UnifiedCacheSnapshot, String> {
    serde_json::from_str(payload).map_err(|err| format!("Failed to parse WW unified cache snapshot: {}", err))
}

fn normalize_text(value: &str) -> String {
    value.trim().to_lowercase()
}

fn latest_updated_at(card: &UnifiedOnlineCard) -> String {
    card.sources
        .iter()
        .map(|source| source.raw_updated_at.as_str())
        .max()
        .unwrap_or("")
        .to_string()
}

fn matches_source_filter(card: &UnifiedOnlineCard, source: &str) -> bool {
    let normalized_source = normalize_text(source);
    if normalized_source.is_empty() || normalized_source == "all" {
        return true;
    }
    normalize_text(&card.primary_source_id) == normalized_source
        || card
            .sources
            .iter()
            .any(|variant| normalize_text(&variant.source_id) == normalized_source)
}

fn normalized_category_filter(path: &str) -> Option<String> {
    let normalized_path = normalize_text(path);
    if normalized_path.is_empty()
        || normalized_path.starts_with("home")
        || normalized_path.starts_with("search/")
    {
        return None;
    }

    Some(
        normalized_path
            .split("&_sort=")
            .next()
            .unwrap_or("")
            .split("&_type=")
            .next()
            .unwrap_or("")
            .trim()
            .to_string(),
    )
}

fn derived_search_term(params: &UnifiedOnlineListParams) -> Option<String> {
    if let Some(search_term) = params.search_term.as_ref().map(|term| normalize_text(term)) {
        if !search_term.is_empty() {
            return Some(search_term);
        }
    }

    if params.path.starts_with("search/") {
        let term = params
            .path
            .trim_start_matches("search/")
            .split("&_type=")
            .next()
            .unwrap_or("");
        let normalized = normalize_text(term);
        if !normalized.is_empty() {
            return Some(normalized);
        }
    }

    None
}

fn matches_search_term(card: &UnifiedOnlineCard, search_term: Option<&str>) -> bool {
    let Some(search_term) = search_term else {
        return true;
    };

    normalize_text(&card.display_name).contains(search_term)
        || card
            .original_names
            .iter()
            .any(|name| normalize_text(name).contains(search_term))
        || card.sources.iter().any(|variant| {
            normalize_text(&variant.title).contains(search_term)
                || normalize_text(&variant.author).contains(search_term)
        })
}

fn filter_unified_cards(
    cards: &[UnifiedOnlineCard],
    params: &UnifiedOnlineListParams,
) -> Vec<UnifiedOnlineCard> {
    let category_filter = normalized_category_filter(&params.path);
    let search_term = derived_search_term(params);
    let mut filtered = cards
        .iter()
        .filter(|card| matches_source_filter(card, &params.source))
        .filter(|card| {
            category_filter
                .as_ref()
                .map(|category| normalize_text(&card.category) == *category)
                .unwrap_or(true)
        })
        .filter(|card| matches_search_term(card, search_term.as_deref()))
        .cloned()
        .collect::<Vec<_>>();

    filtered.sort_by(|left, right| {
        latest_updated_at(right)
            .cmp(&latest_updated_at(left))
            .then_with(|| left.card_id.cmp(&right.card_id))
    });
    filtered
}

fn default_refresh_statuses() -> Vec<UnifiedRefreshStatus> {
    DEFAULT_SOURCE_IDS
        .into_iter()
        .map(|source| UnifiedRefreshStatus {
            source_id: source.to_string(),
            status: "idle".to_string(),
            message: Some(
                "WW unified cache file is not present yet. Bridge is ready and waiting for crawler output."
                    .to_string(),
            ),
        })
        .collect()
}

fn apply_cache_source_context(
    statuses: Vec<UnifiedRefreshStatus>,
    source_kind: &UnifiedCacheSourceKind,
) -> Vec<UnifiedRefreshStatus> {
    if *source_kind != UnifiedCacheSourceKind::DevFixture {
        return statuses;
    }

    statuses
        .into_iter()
        .map(|status| UnifiedRefreshStatus {
            message: Some(match status.message {
                Some(message) if message.starts_with("[fixture]") => message,
                Some(message) => format!("[fixture] {}", message),
                None => "[fixture] Dev fixture fallback active.".to_string(),
            }),
            ..status
        })
        .collect()
}

fn dedupe_paths(candidates: Vec<UnifiedCacheCandidate>) -> Vec<UnifiedCacheCandidate> {
    let mut deduped = Vec::new();
    for candidate in candidates {
        if !deduped
            .iter()
            .any(|existing: &UnifiedCacheCandidate| existing.path == candidate.path)
        {
            deduped.push(candidate);
        }
    }
    deduped
}

fn allow_dev_cache_fixtures() -> bool {
    cfg!(debug_assertions)
}

fn resolve_cache_candidates_from_paths(
    app_local_data_dir: Option<PathBuf>,
    resource_fixture_path: Option<PathBuf>,
    current_dir: Option<PathBuf>,
    include_dev_fixtures: bool,
) -> Vec<UnifiedCacheCandidate> {
    let mut candidates = Vec::new();

    if let Some(app_local_data_dir) = app_local_data_dir {
        candidates.push(UnifiedCacheCandidate {
            path: app_local_data_dir.join("ww-unified-cache.json"),
            source_kind: UnifiedCacheSourceKind::PersistedCache,
        });
        candidates.push(UnifiedCacheCandidate {
            path: app_local_data_dir.join("ww-unified").join("cards.json"),
            source_kind: UnifiedCacheSourceKind::PersistedCache,
        });
    }

    if include_dev_fixtures {
        if let Some(resource_fixture_path) = resource_fixture_path {
            candidates.push(UnifiedCacheCandidate {
                path: resource_fixture_path,
                source_kind: UnifiedCacheSourceKind::DevFixture,
            });
        }

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(UnifiedCacheCandidate {
            path: manifest_dir.join("dev-data").join("ww-unified-cache.json"),
            source_kind: UnifiedCacheSourceKind::DevFixture,
        });

        if let Some(current_dir) = current_dir {
            candidates.push(UnifiedCacheCandidate {
                path: current_dir.join("dev-data").join("ww-unified-cache.json"),
                source_kind: UnifiedCacheSourceKind::DevFixture,
            });
            candidates.push(UnifiedCacheCandidate {
                path: current_dir
                    .join("src-tauri")
                    .join("dev-data")
                    .join("ww-unified-cache.json"),
                source_kind: UnifiedCacheSourceKind::DevFixture,
            });
        }
    }

    dedupe_paths(candidates)
}

fn resolve_cache_candidates(app_handle: &AppHandle) -> Vec<UnifiedCacheCandidate> {
    let app_local_data_dir = app_handle.path().app_local_data_dir().ok();
    let resource_fixture_path = app_handle
        .path()
        .resolve("dev-data/ww-unified-cache.json", BaseDirectory::Resource)
        .ok();
    let current_dir = std::env::current_dir().ok();

    resolve_cache_candidates_from_paths(
        app_local_data_dir,
        resource_fixture_path,
        current_dir,
        allow_dev_cache_fixtures(),
    )
}

fn load_unified_cache_snapshot(app_handle: &AppHandle) -> Result<LoadedUnifiedCacheSnapshot, String> {
    let candidates = resolve_cache_candidates(app_handle);
    let mut parse_errors = Vec::new();

    for candidate in candidates {
        if !candidate.path.exists() || !candidate.path.is_file() {
            continue;
        }

        match fs::read_to_string(&candidate.path) {
            Ok(payload) => match parse_unified_cache_snapshot(&payload) {
                Ok(snapshot) => {
                    return Ok(LoadedUnifiedCacheSnapshot {
                        snapshot,
                        source_kind: candidate.source_kind,
                    })
                }
                Err(err) => parse_errors.push(format!("{} [{}]", err, candidate.path.display())),
            },
            Err(err) => parse_errors.push(format!("Failed to read {}: {}", candidate.path.display(), err)),
        }
    }

    if parse_errors.is_empty() {
        Ok(LoadedUnifiedCacheSnapshot {
            snapshot: UnifiedCacheSnapshot::default(),
            source_kind: UnifiedCacheSourceKind::Missing,
        })
    } else {
        Err(parse_errors.join(" | "))
    }
}

fn write_unified_cache_snapshot_to_path(path: &PathBuf, payload: &str) -> Result<(), String> {
    parse_unified_cache_snapshot(payload)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create cache directory {}: {}", parent.display(), err))?;
    }
    fs::write(path, payload).map_err(|err| format!("Failed to write {}: {}", path.display(), err))
}

fn filter_refresh_statuses(
    statuses: &[UnifiedRefreshStatus],
    source_id: Option<&str>,
) -> Vec<UnifiedRefreshStatus> {
    let normalized_source = source_id.map(normalize_text);
    statuses
        .iter()
        .filter(|status| {
            normalized_source
                .as_ref()
                .map(|source| normalize_text(&status.source_id) == *source)
                .unwrap_or(true)
        })
        .cloned()
        .collect()
}

fn filter_afdian_candidates(
    candidates: &[AfdianCandidate],
    query: &str,
) -> Vec<AfdianCandidate> {
    let normalized_query = normalize_text(query);
    if normalized_query.is_empty() {
        return candidates.to_vec();
    }

    candidates
        .iter()
        .filter(|candidate| {
            normalize_text(&candidate.title).contains(&normalized_query)
                || normalize_text(&candidate.author).contains(&normalized_query)
                || normalize_text(&candidate.detail_url).contains(&normalized_query)
        })
        .cloned()
        .collect()
}

fn derive_source_mod_id_from_detail_url(detail_url: &str) -> String {
    detail_url
        .trim_end_matches('/')
        .split('/')
        .next_back()
        .filter(|segment| !segment.trim().is_empty())
        .unwrap_or("afdian-candidate")
        .to_string()
}

fn build_afdian_source_variant(card: &UnifiedOnlineCard, candidate: &AfdianCandidate, generated_at: &str) -> UnifiedSourceVariant {
    UnifiedSourceVariant {
        source_id: "afdian".to_string(),
        source_mod_id: derive_source_mod_id_from_detail_url(&candidate.detail_url),
        title: candidate.title.clone(),
        detail_url: candidate.detail_url.clone(),
        download_options: Vec::new(),
        preview_urls: card.preview.clone().into_iter().collect(),
        author: candidate.author.clone(),
        is_free_public: false,
        raw_updated_at: generated_at.to_string(),
    }
}

fn build_afdian_detail_source(card: &UnifiedOnlineCard, candidate: &AfdianCandidate, generated_at: &str) -> UnifiedOnlineDetailSource {
    UnifiedOnlineDetailSource {
        source_id: "afdian".to_string(),
        source_mod_id: Some(derive_source_mod_id_from_detail_url(&candidate.detail_url)),
        title: Some(candidate.title.clone()),
        detail_url: Some(candidate.detail_url.clone()),
        download_options: Vec::new(),
        preview_urls: card.preview.clone().into_iter().collect(),
        author: Some(candidate.author.clone()),
        is_free_public: Some(false),
        raw_updated_at: Some(generated_at.to_string()),
        summary: Some("Afdian candidate adopted into unified source list.".to_string()),
        description: Some("Imported from Afdian candidate discovery for manual review.".to_string()),
        description_html: Some("<p>Imported from Afdian candidate discovery for manual review.</p>".to_string()),
        version: None,
        tags: vec!["afdian-candidate".to_string()],
        links: vec![UnifiedDetailLink {
            label: "Afdian Candidate".to_string(),
            url: candidate.detail_url.clone(),
        }],
        stats: None,
    }
}

fn attach_afdian_candidate_to_snapshot(
    snapshot: &mut UnifiedCacheSnapshot,
    card_id: &str,
    detail_url: &str,
) -> Result<UnifiedOnlineDetail, String> {
    let candidate_index = snapshot
        .afdian_candidates
        .iter()
        .position(|candidate| candidate.detail_url == detail_url)
        .ok_or_else(|| format!("Afdian candidate not found: {}", detail_url))?;
    let candidate = snapshot.afdian_candidates[candidate_index].clone();
    let generated_at = snapshot
        .generated_at
        .clone()
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());

    let card_index = snapshot
        .cards
        .iter()
        .position(|record| record.card.card_id == card_id)
        .ok_or_else(|| format!("Unified WW card not found: {}", card_id))?;

    {
        let record = snapshot
            .cards
            .get_mut(card_index)
            .ok_or_else(|| format!("Unified WW card not found: {}", card_id))?;
        if !record.card.sources.iter().any(|source| source.source_id == "afdian") {
            record
                .card
                .sources
                .push(build_afdian_source_variant(&record.card, &candidate, &generated_at));
        }
        let detail = record.detail.get_or_insert_with(UnifiedDetailSupplement::default);
        if !detail.source_details.iter().any(|source| source.source_id == "afdian") {
            detail
                .source_details
                .push(build_afdian_detail_source(&record.card, &candidate, &generated_at));
        }
        if !detail
            .source_specific_notes
            .iter()
            .any(|note| note.source_id == "afdian")
        {
            detail.source_specific_notes.push(UnifiedSourceSpecificNote {
                source_id: "afdian".to_string(),
                label: "Afdian".to_string(),
                content_html: "<p>Afdian candidate adopted into unified source list.</p>".to_string(),
            });
        }
    }

    snapshot.afdian_candidates.remove(candidate_index);
    if let Some(status) = snapshot
        .refresh_status
        .iter_mut()
        .find(|status| status.source_id == "afdian")
    {
        status.status = "success".to_string();
        status.message = Some("Afdian candidate adopted into unified source list.".to_string());
    } else {
        snapshot.refresh_status.push(UnifiedRefreshStatus {
            source_id: "afdian".to_string(),
            status: "success".to_string(),
            message: Some("Afdian candidate adopted into unified source list.".to_string()),
        });
    }

    let updated_record = snapshot
        .cards
        .get(card_index)
        .cloned()
        .ok_or_else(|| format!("Unified WW card not found after update: {}", card_id))?;
    Ok(build_unified_online_detail(updated_record))
}

fn detach_afdian_source_from_snapshot(
    snapshot: &mut UnifiedCacheSnapshot,
    card_id: &str,
) -> Result<UnifiedOnlineDetail, String> {
    let card_index = snapshot
        .cards
        .iter()
        .position(|record| record.card.card_id == card_id)
        .ok_or_else(|| format!("Unified WW card not found: {}", card_id))?;

    let (candidate, had_afdian_source) = {
        let record = snapshot
            .cards
            .get_mut(card_index)
            .ok_or_else(|| format!("Unified WW card not found: {}", card_id))?;
        let source_index = record
            .card
            .sources
            .iter()
            .position(|source| source.source_id == "afdian");
        let Some(source_index) = source_index else {
            return Err("Afdian source is not attached to this unified card.".to_string());
        };
        let source = record.card.sources.remove(source_index);
        let detail = record.detail.get_or_insert_with(UnifiedDetailSupplement::default);
        detail.source_details.retain(|detail_source| detail_source.source_id != "afdian");
        detail.source_specific_notes.retain(|note| note.source_id != "afdian");

        (
            AfdianCandidate {
                title: source.title.clone(),
                detail_url: source.detail_url.clone(),
                author: source.author.clone(),
            },
            true,
        )
    };

    if had_afdian_source
        && snapshot
            .afdian_candidates
            .iter()
            .all(|existing| existing.detail_url != candidate.detail_url)
    {
        snapshot.afdian_candidates.push(candidate);
    }

    if let Some(status) = snapshot
        .refresh_status
        .iter_mut()
        .find(|status| status.source_id == "afdian")
    {
        status.status = "idle".to_string();
        status.message = Some("Afdian candidate restored to pending list.".to_string());
    } else {
        snapshot.refresh_status.push(UnifiedRefreshStatus {
            source_id: "afdian".to_string(),
            status: "idle".to_string(),
            message: Some("Afdian candidate restored to pending list.".to_string()),
        });
    }

    let updated_record = snapshot
        .cards
        .get(card_index)
        .cloned()
        .ok_or_else(|| format!("Unified WW card not found after update: {}", card_id))?;
    Ok(build_unified_online_detail(updated_record))
}

fn build_detail_source_from_variant(variant: &UnifiedSourceVariant) -> UnifiedOnlineDetailSource {
    UnifiedOnlineDetailSource {
        source_id: variant.source_id.clone(),
        source_mod_id: Some(variant.source_mod_id.clone()),
        title: Some(variant.title.clone()),
        detail_url: Some(variant.detail_url.clone()),
        download_options: variant.download_options.clone(),
        preview_urls: variant.preview_urls.clone(),
        author: Some(variant.author.clone()),
        is_free_public: Some(variant.is_free_public),
        raw_updated_at: Some(variant.raw_updated_at.clone()),
        summary: None,
        description: None,
        description_html: None,
        version: None,
        tags: Vec::new(),
        links: Vec::new(),
        stats: None,
    }
}

fn merge_detail_source(
    base: UnifiedOnlineDetailSource,
    detail: UnifiedOnlineDetailSource,
) -> UnifiedOnlineDetailSource {
    UnifiedOnlineDetailSource {
        source_id: if detail.source_id.is_empty() {
            base.source_id
        } else {
            detail.source_id
        },
        source_mod_id: detail.source_mod_id.or(base.source_mod_id),
        title: detail.title.or(base.title),
        detail_url: detail.detail_url.or(base.detail_url),
        download_options: if detail.download_options.is_empty() {
            base.download_options
        } else {
            detail.download_options
        },
        preview_urls: if detail.preview_urls.is_empty() {
            base.preview_urls
        } else {
            detail.preview_urls
        },
        author: detail.author.or(base.author),
        is_free_public: detail.is_free_public.or(base.is_free_public),
        raw_updated_at: detail.raw_updated_at.or(base.raw_updated_at),
        summary: detail.summary.or(base.summary),
        description: detail.description.or(base.description),
        description_html: detail.description_html.or(base.description_html),
        version: detail.version.or(base.version),
        tags: if detail.tags.is_empty() { base.tags } else { detail.tags },
        links: if detail.links.is_empty() { base.links } else { detail.links },
        stats: detail.stats.or(base.stats),
    }
}

fn merge_detail_sources(
    card: &UnifiedOnlineCard,
    mut detail_sources: Vec<UnifiedOnlineDetailSource>,
) -> Vec<UnifiedOnlineDetailSource> {
    let mut merged_sources = Vec::with_capacity(card.sources.len().max(detail_sources.len()));

    for source in &card.sources {
        let base = build_detail_source_from_variant(source);
        if let Some(index) = detail_sources
            .iter()
            .position(|detail_source| {
                detail_source.source_id == source.source_id
                    && detail_source
                        .source_mod_id
                        .as_ref()
                        .map(|source_mod_id| source_mod_id == &source.source_mod_id)
                        .unwrap_or(true)
            })
        {
            merged_sources.push(merge_detail_source(base, detail_sources.remove(index)));
        } else {
            merged_sources.push(base);
        }
    }

    merged_sources.extend(detail_sources);
    merged_sources
}

fn build_unified_online_detail(record: UnifiedCacheCardRecord) -> UnifiedOnlineDetail {
    let card = record.card;
    let detail = record.detail.unwrap_or_default();
    let source_details = merge_detail_sources(&card, detail.source_details);
    let updates_enabled = detail.updates_enabled || !detail.updates.is_empty();
    let stats = detail
        .stats
        .or_else(|| {
            source_details
                .iter()
                .find(|source| source.source_id == card.primary_source_id)
                .and_then(|source| source.stats.clone())
        });

    UnifiedOnlineDetail {
        card,
        comments_enabled: detail.comments_enabled,
        updates_enabled,
        summary: detail.summary,
        description: detail.description,
        summary_html: detail.summary_html,
        description_html: detail.description_html,
        aliases: detail.aliases,
        tags: detail.tags,
        links: detail.links,
        source_details,
        updates: detail.updates,
        stats,
        source_specific_notes: detail.source_specific_notes,
        primary_source_can_reuse_legacy_detail: detail.primary_source_can_reuse_legacy_detail,
    }
}

#[tauri::command]
pub fn list_unified_ww_cards(
    app_handle: tauri::AppHandle,
    params: UnifiedOnlineListParams,
) -> Result<Vec<UnifiedOnlineCard>, String> {
    let loaded = load_unified_cache_snapshot(&app_handle)?;
    let cards = loaded
        .snapshot
        .cards
        .into_iter()
        .map(|record| record.card)
        .collect::<Vec<_>>();
    Ok(filter_unified_cards(&cards, &params))
}

#[tauri::command]
pub fn get_unified_ww_card_detail(
    app_handle: tauri::AppHandle,
    card_id: String,
) -> Result<UnifiedOnlineDetail, String> {
    let loaded = load_unified_cache_snapshot(&app_handle)?;
    let card = loaded
        .snapshot
        .cards
        .into_iter()
        .find(|record| record.card.card_id == card_id)
        .ok_or_else(|| format!("Unified WW card detail not found: {}", card_id))?;

    Ok(build_unified_online_detail(card))
}

#[tauri::command]
pub fn refresh_unified_ww_sources(
    app_handle: tauri::AppHandle,
    source_id: Option<String>,
) -> Result<Vec<UnifiedRefreshStatus>, String> {
    let loaded = load_unified_cache_snapshot(&app_handle)?;
    let statuses = if loaded.snapshot.refresh_status.is_empty() {
        default_refresh_statuses()
    } else {
        loaded.snapshot.refresh_status
    };
    Ok(filter_refresh_statuses(
        &apply_cache_source_context(statuses, &loaded.source_kind),
        source_id.as_deref(),
    ))
}

#[tauri::command]
pub fn discover_afdian_candidates(
    app_handle: tauri::AppHandle,
    query: String,
) -> Result<AfdianDiscoveryResult, String> {
    let loaded = load_unified_cache_snapshot(&app_handle)?;
    Ok(AfdianDiscoveryResult {
        candidates: filter_afdian_candidates(&loaded.snapshot.afdian_candidates, &query),
    })
}

#[tauri::command]
pub fn write_unified_ww_cache_snapshot(
    app_handle: tauri::AppHandle,
    payload: String,
) -> Result<String, String> {
    let cache_path = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Failed to resolve app local data dir: {}", err))?
        .join("ww-unified-cache.json");
    write_unified_cache_snapshot_to_path(&cache_path, &payload)?;
    Ok(cache_path.display().to_string())
}

#[tauri::command]
pub fn attach_afdian_candidate_to_unified_card(
    app_handle: tauri::AppHandle,
    card_id: String,
    detail_url: String,
) -> Result<UnifiedOnlineDetail, String> {
    let mut loaded = load_unified_cache_snapshot(&app_handle)?;
    let detail = attach_afdian_candidate_to_snapshot(&mut loaded.snapshot, &card_id, &detail_url)?;
    let payload = serde_json::to_string_pretty(&loaded.snapshot)
        .map_err(|err| format!("Failed to serialize updated WW unified cache snapshot: {}", err))?;
    let cache_path = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Failed to resolve app local data dir: {}", err))?
        .join("ww-unified-cache.json");
    write_unified_cache_snapshot_to_path(&cache_path, &payload)?;
    Ok(detail)
}

#[tauri::command]
pub fn detach_afdian_source_from_unified_card(
    app_handle: tauri::AppHandle,
    card_id: String,
) -> Result<UnifiedOnlineDetail, String> {
    let mut loaded = load_unified_cache_snapshot(&app_handle)?;
    let detail = detach_afdian_source_from_snapshot(&mut loaded.snapshot, &card_id)?;
    let payload = serde_json::to_string_pretty(&loaded.snapshot)
        .map_err(|err| format!("Failed to serialize updated WW unified cache snapshot: {}", err))?;
    let cache_path = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Failed to resolve app local data dir: {}", err))?
        .join("ww-unified-cache.json");
    write_unified_cache_snapshot_to_path(&cache_path, &payload)?;
    Ok(detail)
}

#[tauri::command]
pub fn run_temp_duplicate_compare(
    _left_source_id: String,
    _left_source_mod_id: String,
    _right_source_id: String,
    _right_source_mod_id: String,
) -> Result<TempDuplicateCompareResult, String> {
    Err("Temporary duplicate comparison is not supported by this build yet.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_dev_fixture_snapshot() -> UnifiedCacheSnapshot {
        parse_unified_cache_snapshot(
            r#"{
                "generatedAt": "2026-04-21T14:30:00Z",
                "cards": [
                    {
                        "cardId": "gamebanana:camellya-blue-dress",
                        "primarySourceId": "gamebanana",
                        "displayName": "Camellya Blue Dress",
                        "originalNames": ["Camellya Blue Dress", "Camellya Azure Outfit"],
                        "category": "Other",
                        "preview": "https://example.com/previews/camellya-blue-dress.jpg",
                        "sources": [
                            {
                                "sourceId": "gamebanana",
                                "sourceModId": "camellya-blue-dress",
                                "title": "Camellya Blue Dress",
                                "detailUrl": "https://gamebanana.com/mods/593490",
                                "downloadOptions": [
                                    {
                                        "label": "Main Download",
                                        "url": "https://downloads.example.com/gamebanana/camellya-blue-dress.zip"
                                    }
                                ],
                                "previewUrls": ["https://example.com/previews/camellya-blue-dress.jpg"],
                                "author": "BlueArchive",
                                "isFreePublic": true,
                                "rawUpdatedAt": "2026-04-20T18:10:00Z"
                            },
                            {
                                "sourceId": "hui",
                                "sourceModId": "hui-camellya-001",
                                "title": "Camellya Azure Outfit",
                                "detailUrl": "https://hui.example.com/mods/camellya-azure-outfit",
                                "downloadOptions": [
                                    {
                                        "label": "Mirror Download",
                                        "url": "https://downloads.example.com/hui/camellya-azure-outfit.zip"
                                    }
                                ],
                                "previewUrls": ["https://example.com/previews/camellya-blue-dress.jpg"],
                                "author": "AzureTailor",
                                "isFreePublic": true,
                                "rawUpdatedAt": "2026-04-21T03:45:00Z"
                            }
                        ],
                        "duplicateScore": 0.94,
                        "duplicateReasons": ["translated-name", "preview-phash"],
                        "duplicateEvidence": {
                            "nameScore": 0.71,
                            "translatedNameScore": 0.94,
                            "translationGap": 0.06,
                            "previewHashDistance": 6,
                            "tempFileHashMatch": null,
                            "decision": "merge"
                        },
                        "detail": {
                            "commentsEnabled": true,
                            "updatesEnabled": true,
                            "summary": "Camellya merged card overview",
                            "description": "GameBanana remains primary while Hui supplements metadata.",
                            "summaryHtml": "<p><strong>Camellya Blue Dress</strong> 聚合了 GameBanana 与绘站镜像，优先复用 GameBanana 详情。</p>",
                            "descriptionHtml": "<p>主来源提供完整帖子说明，镜像来源补充了汉化命名与更新时间。</p>",
                            "primarySourceCanReuseLegacyDetail": true,
                            "stats": {
                                "likeCount": 128,
                                "downloadCount": 2048,
                                "viewCount": 4096,
                                "postCount": 12
                            },
                            "updates": [
                                {
                                    "sourceId": "gamebanana",
                                    "title": "Compatibility 2.1",
                                    "version": "v1.1",
                                    "publishedAt": "2026-04-21T02:00:00Z",
                                    "summary": "Adjusted shader metadata for 2.1.",
                                    "url": "https://gamebanana.com/updates/593490"
                                }
                            ],
                            "sourceDetails": [
                                {
                                    "sourceId": "gamebanana",
                                    "summary": "Primary source detail summary",
                                    "sourceModId": "camellya-blue-dress",
                                    "detailUrl": "https://gamebanana.com/mods/593490",
                                    "version": "v1.1",
                                    "downloadOptions": [
                                        {
                                            "label": "Main Download",
                                            "url": "https://downloads.example.com/gamebanana/camellya-blue-dress.zip"
                                        }
                                    ],
                                    "previewUrls": ["https://example.com/previews/camellya-blue-dress.jpg"],
                                    "tags": ["outfit", "4k"],
                                    "links": [
                                        {
                                            "label": "GameBanana",
                                            "url": "https://gamebanana.com/mods/593490"
                                        }
                                    ],
                                    "stats": {
                                        "likeCount": 128,
                                        "downloadCount": 2048
                                    }
                                },
                                {
                                    "sourceId": "hui",
                                    "title": "Camellya Azure Outfit",
                                    "summary": "Hui mirror metadata",
                                    "sourceModId": "hui-camellya-001",
                                    "detailUrl": "https://hui.example.com/mods/camellya-azure-outfit",
                                    "version": "v1.1",
                                    "downloadOptions": [
                                        {
                                            "label": "Mirror Download",
                                            "url": "https://downloads.example.com/hui/camellya-azure-outfit.zip"
                                        }
                                    ],
                                    "previewUrls": ["https://example.com/previews/camellya-blue-dress.jpg"],
                                    "tags": ["mirror"],
                                    "stats": {
                                        "viewCount": 640
                                    }
                                }
                            ],
                            "sourceSpecificNotes": [
                                {
                                    "sourceId": "gamebanana",
                                    "label": "GameBanana",
                                    "contentHtml": "<p>Legacy detail is reusable.</p>"
                                },
                                {
                                    "sourceId": "hui",
                                    "label": "Hui",
                                    "contentHtml": "<p>Mirror metadata fills localized fields.</p>"
                                }
                            ]
                        }
                    }
                ],
                "refreshStatus": [
                    {
                        "sourceId": "hui",
                        "status": "success",
                        "message": "Fixture seeded from local dev cache."
                    }
                ],
                "afdianCandidates": [
                    {
                        "title": "Camellya Uniform Variant",
                        "detailUrl": "https://afdian.net/a/bluearchive/post/fixture-camellya",
                        "author": "UniformLab"
                    }
                ]
            }"#,
        )
        .expect("inline fixture should parse")
    }

    fn make_card(
        card_id: &str,
        primary_source_id: &str,
        display_name: &str,
        category: &str,
        updated_at: &str,
    ) -> UnifiedOnlineCard {
        UnifiedOnlineCard {
            card_id: card_id.to_string(),
            primary_source_id: primary_source_id.to_string(),
            display_name: display_name.to_string(),
            original_names: vec![display_name.to_string()],
            category: category.to_string(),
            preview: None,
            sources: vec![UnifiedSourceVariant {
                source_id: primary_source_id.to_string(),
                source_mod_id: card_id.to_string(),
                title: display_name.to_string(),
                detail_url: format!("https://example.com/{}", card_id),
                download_options: Vec::new(),
                preview_urls: Vec::new(),
                author: "Tester".to_string(),
                is_free_public: true,
                raw_updated_at: updated_at.to_string(),
            }],
            duplicate_score: 0.0,
            duplicate_reasons: Vec::new(),
            duplicate_evidence: None,
        }
    }

    fn make_cached_card(card: UnifiedOnlineCard) -> UnifiedCacheCardRecord {
        UnifiedCacheCardRecord { card, detail: None }
    }

    #[test]
    fn parse_unified_cache_snapshot_reads_cards_and_statuses() {
        let snapshot = parse_unified_cache_snapshot(
            r#"{
                "generatedAt": "2026-04-21T12:00:00Z",
                "cards": [
                    {
                        "cardId": "hui:camellya",
                        "primarySourceId": "hui",
                        "displayName": "Camellya Blue Dress",
                        "originalNames": ["Camellya Blue Dress"],
                        "category": "Other",
                        "preview": null,
                        "sources": [
                            {
                                "sourceId": "hui",
                                "sourceModId": "camellya",
                                "title": "Camellya Blue Dress",
                                "detailUrl": "https://example.com/camellya",
                                "downloadOptions": [],
                                "previewUrls": [],
                                "author": "Tester",
                                "isFreePublic": true,
                                "rawUpdatedAt": "2026-04-21T10:00:00Z"
                            }
                        ],
                        "duplicateScore": 0.91,
                        "duplicateReasons": ["translated-name"],
                        "duplicateEvidence": {
                            "nameScore": 0.72,
                            "translatedNameScore": 0.91,
                            "translationGap": 0.09,
                            "previewHashDistance": 6,
                            "tempFileHashMatch": null,
                            "decision": "merge"
                        }
                    }
                ],
                "refreshStatus": [
                    {
                        "sourceId": "hui",
                        "status": "success",
                        "message": "ok"
                    }
                ]
            }"#,
        )
        .expect("snapshot should parse");

        assert_eq!(snapshot.cards.len(), 1);
        assert_eq!(snapshot.cards[0].card.card_id, "hui:camellya");
        assert_eq!(
            snapshot.cards[0]
                .card
                .duplicate_evidence
                .as_ref()
                .map(|evidence| evidence.decision.as_str()),
            Some("merge")
        );
        assert_eq!(snapshot.refresh_status.len(), 1);
        assert_eq!(snapshot.refresh_status[0].status, "success");
    }

    #[test]
    fn filter_unified_cards_respects_source_category_and_search() {
        let snapshot = UnifiedCacheSnapshot {
            generated_at: Some("2026-04-21T12:00:00Z".to_string()),
            cards: vec![
                make_cached_card(make_card(
                    "hui:camellya",
                    "hui",
                    "Camellya Blue Dress",
                    "Other",
                    "2026-04-21T10:00:00Z",
                )),
                make_cached_card(make_card(
                    "keke:jinhsi",
                    "keke",
                    "Jinhsi School Uniform",
                    "UI",
                    "2026-04-21T08:00:00Z",
                )),
            ],
            refresh_status: Vec::new(),
            afdian_candidates: Vec::new(),
        };
        let cards = snapshot
            .cards
            .iter()
            .map(|record| record.card.clone())
            .collect::<Vec<_>>();

        let filtered = filter_unified_cards(
            &cards,
            &UnifiedOnlineListParams {
                path: "Other&_sort=".to_string(),
                source: "hui".to_string(),
                search_term: Some("camellya".to_string()),
                sort: None,
            },
        );

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].card_id, "hui:camellya");
    }

    #[test]
    fn bundled_dev_cache_fixture_exists_and_contains_cards() {
        let snapshot = load_dev_fixture_snapshot();

        assert!(
            !snapshot.cards.is_empty(),
            "expected dev cache fixture to contain at least one unified card"
        );
        assert_eq!(
            snapshot.cards[0].card.card_id,
            "gamebanana:camellya-blue-dress"
        );
    }

    #[test]
    fn bundled_dev_cache_fixture_exposes_refresh_status_filters() {
        let snapshot = load_dev_fixture_snapshot();

        let filtered = filter_refresh_statuses(&snapshot.refresh_status, Some("hui"));

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].source_id, "hui");
        assert_eq!(filtered[0].status, "success");
    }

    #[test]
    fn bundled_dev_cache_fixture_exposes_afdian_candidate_filters() {
        let snapshot = load_dev_fixture_snapshot();

        let filtered = filter_afdian_candidates(&snapshot.afdian_candidates, "uniform");

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].author, "UniformLab");
    }

    #[test]
    fn parse_unified_cache_snapshot_reads_detail_supplement_when_present() {
        let snapshot = parse_unified_cache_snapshot(
            r#"{
                "cards": [
                    {
                        "cardId": "gamebanana:camellya-blue-dress",
                        "primarySourceId": "gamebanana",
                        "displayName": "Camellya Blue Dress",
                        "originalNames": ["Camellya Blue Dress"],
                        "category": "Other",
                        "preview": "https://example.com/previews/camellya-blue-dress.jpg",
                        "sources": [
                            {
                                "sourceId": "gamebanana",
                                "sourceModId": "camellya-blue-dress",
                                "title": "Camellya Blue Dress",
                                "detailUrl": "https://gamebanana.com/mods/700001",
                                "downloadOptions": [],
                                "previewUrls": [],
                                "author": "BlueArchive",
                                "isFreePublic": true,
                                "rawUpdatedAt": "2026-04-20T18:10:00Z"
                            }
                        ],
                        "duplicateScore": 0.94,
                        "duplicateReasons": ["translated-name"],
                        "detail": {
                            "summaryHtml": "<p>Detailed summary</p>",
                            "descriptionHtml": "<p>Detailed description</p>",
                            "primarySourceCanReuseLegacyDetail": true,
                            "sourceSpecificNotes": [
                                {
                                    "sourceId": "gamebanana",
                                    "label": "GameBanana",
                                    "contentHtml": "<p>Legacy detail is reusable.</p>"
                                }
                            ]
                        }
                    }
                ]
            }"#,
        )
        .expect("snapshot should parse");

        let detail = snapshot.cards[0]
            .detail
            .as_ref()
            .expect("detail supplement should exist");
        assert_eq!(detail.summary_html.as_deref(), Some("<p>Detailed summary</p>"));
        assert_eq!(detail.description_html.as_deref(), Some("<p>Detailed description</p>"));
        assert_eq!(detail.primary_source_can_reuse_legacy_detail, Some(true));
        assert_eq!(detail.source_specific_notes.len(), 1);
        assert_eq!(detail.source_specific_notes[0].source_id, "gamebanana");
    }

    #[test]
    fn build_unified_online_detail_surfaces_detail_only_fields() {
        let snapshot = load_dev_fixture_snapshot();
        let cached_card = snapshot
            .cards
            .into_iter()
            .find(|card| card.card.card_id == "gamebanana:camellya-blue-dress")
            .expect("fixture card should exist");

        let detail = build_unified_online_detail(cached_card);

        assert_eq!(detail.card.card_id, "gamebanana:camellya-blue-dress");
        assert!(detail.comments_enabled);
        assert!(detail.updates_enabled);
        assert_eq!(
            detail.summary_html.as_deref(),
            Some("<p><strong>Camellya Blue Dress</strong> 聚合了 GameBanana 与绘站镜像，优先复用 GameBanana 详情。</p>")
        );
        assert_eq!(
            detail.description_html.as_deref(),
            Some("<p>主来源提供完整帖子说明，镜像来源补充了汉化命名与更新时间。</p>")
        );
        assert_eq!(detail.primary_source_can_reuse_legacy_detail, Some(true));
        assert_eq!(detail.source_specific_notes.len(), 2);
        assert_eq!(detail.source_specific_notes[0].source_id, "gamebanana");
        assert_eq!(detail.updates.len(), 1);
        assert_eq!(detail.updates[0].title, "Compatibility 2.1");
        assert_eq!(
            detail.stats.as_ref().and_then(|stats| stats.download_count),
            Some(2048)
        );
        assert_eq!(detail.source_details.len(), 2);
        assert_eq!(detail.source_details[0].source_id, "gamebanana");
        assert_eq!(detail.source_details[0].download_options.len(), 1);
        assert_eq!(detail.source_details[0].version.as_deref(), Some("v1.1"));
        assert_eq!(detail.source_details[1].source_id, "hui");
        assert_eq!(
            detail.source_details[1]
                .stats
                .as_ref()
                .and_then(|stats| stats.view_count),
            Some(640)
        );
    }

    #[test]
    fn parse_unified_cache_snapshot_reads_richer_detail_payload_fields() {
        let snapshot = parse_unified_cache_snapshot(
            r#"{
                "cards": [
                    {
                        "cardId": "hui:camellya-deluxe",
                        "primarySourceId": "hui",
                        "displayName": "Camellya Deluxe",
                        "originalNames": ["Camellya Deluxe"],
                        "category": "Other",
                        "preview": null,
                        "sources": [
                            {
                                "sourceId": "hui",
                                "sourceModId": "hui-100",
                                "title": "Camellya Deluxe",
                                "detailUrl": "https://hui.example.com/mods/hui-100",
                                "downloadOptions": [],
                                "previewUrls": [],
                                "author": "MirrorAuthor",
                                "isFreePublic": true,
                                "rawUpdatedAt": "2026-04-21T06:00:00Z"
                            }
                        ],
                        "duplicateScore": 0.0,
                        "duplicateReasons": [],
                        "detail": {
                            "commentsEnabled": true,
                            "updatesEnabled": true,
                            "stats": {
                                "likeCount": 21,
                                "downloadCount": 88,
                                "viewCount": 233
                            },
                            "updates": [
                                {
                                    "sourceId": "hui",
                                    "title": "兼容 2.1",
                                    "version": "v1.1",
                                    "publishedAt": "2026-04-21T05:30:00Z",
                                    "summary": "补齐 richer detail",
                                    "url": "https://hui.example.com/updates/1"
                                }
                            ],
                            "sourceDetails": [
                                {
                                    "sourceId": "hui",
                                    "summary": "Hui 详情摘要",
                                    "version": "v1.1",
                                    "tags": ["高清", "剧情"],
                                    "links": [
                                        {
                                            "label": "Hui 说明",
                                            "url": "https://hui.example.com/readme"
                                        }
                                    ],
                                    "stats": {
                                        "likeCount": 9,
                                        "downloadCount": 55
                                    }
                                }
                            ]
                        }
                    }
                ]
            }"#,
        )
        .expect("snapshot should parse");

        let detail = snapshot.cards[0]
            .detail
            .as_ref()
            .expect("detail supplement should exist");
        assert!(detail.comments_enabled);
        assert!(detail.updates_enabled);
        assert_eq!(detail.updates.len(), 1);
        assert_eq!(detail.updates[0].title, "兼容 2.1");
        assert_eq!(
            detail.stats.as_ref().and_then(|stats| stats.download_count),
            Some(88)
        );
        assert_eq!(detail.source_details.len(), 1);
        assert_eq!(detail.source_details[0].source_id, "hui");
        assert_eq!(detail.source_details[0].version.as_deref(), Some("v1.1"));
        assert_eq!(detail.source_details[0].tags, vec!["高清", "剧情"]);
        assert_eq!(detail.source_details[0].links.len(), 1);
        assert_eq!(
            detail.source_details[0]
                .stats
                .as_ref()
                .and_then(|stats| stats.like_count),
            Some(9)
        );
    }

    #[test]
    fn build_unified_online_detail_surfaces_richer_detail_payload() {
        let snapshot = parse_unified_cache_snapshot(
            r#"{
                "cards": [
                    {
                        "cardId": "gamebanana:camellya-blue-dress",
                        "primarySourceId": "gamebanana",
                        "displayName": "Camellya Blue Dress",
                        "originalNames": ["Camellya Blue Dress"],
                        "category": "Other",
                        "preview": null,
                        "sources": [
                            {
                                "sourceId": "gamebanana",
                                "sourceModId": "camellya-blue-dress",
                                "title": "Camellya Blue Dress",
                                "detailUrl": "https://gamebanana.com/mods/700001",
                                "downloadOptions": [
                                    {
                                        "label": "Main Download",
                                        "url": "https://downloads.example.com/gamebanana/camellya-blue-dress.zip"
                                    }
                                ],
                                "previewUrls": [
                                    "https://example.com/previews/camellya-blue-dress.jpg"
                                ],
                                "author": "BlueArchive",
                                "isFreePublic": true,
                                "rawUpdatedAt": "2026-04-20T18:10:00Z"
                            },
                            {
                                "sourceId": "hui",
                                "sourceModId": "hui-camellya-001",
                                "title": "Camellya Azure Outfit",
                                "detailUrl": "https://hui.example.com/mods/camellya-azure-outfit",
                                "downloadOptions": [],
                                "previewUrls": [],
                                "author": "AzureTailor",
                                "isFreePublic": true,
                                "rawUpdatedAt": "2026-04-21T03:45:00Z"
                            }
                        ],
                        "duplicateScore": 0.0,
                        "duplicateReasons": [],
                        "detail": {
                            "commentsEnabled": true,
                            "updatesEnabled": false,
                            "updates": [
                                {
                                    "sourceId": "gamebanana",
                                    "title": "适配 2.1",
                                    "version": "v1.1",
                                    "publishedAt": "2026-04-21T02:00:00Z",
                                    "summary": "补丁说明",
                                    "url": "https://gamebanana.com/updates/700001"
                                }
                            ],
                            "sourceDetails": [
                                {
                                    "sourceId": "gamebanana",
                                    "summary": "主来源详情摘要",
                                    "version": "v1.1",
                                    "tags": ["服装", "高清"],
                                    "links": [
                                        {
                                            "label": "说明页",
                                            "url": "https://gamebanana.com/readme/700001"
                                        }
                                    ],
                                    "stats": {
                                        "likeCount": 128,
                                        "downloadCount": 2048
                                    }
                                }
                            ]
                        }
                    }
                ]
            }"#,
        )
        .expect("snapshot should parse");
        let cached_card = snapshot
            .cards
            .into_iter()
            .next()
            .expect("fixture card should exist");

        let detail = build_unified_online_detail(cached_card);

        assert!(detail.comments_enabled);
        assert!(detail.updates_enabled, "non-empty updates should enable updates section");
        assert_eq!(
            detail.stats.as_ref().and_then(|stats| stats.like_count),
            Some(128)
        );
        assert_eq!(detail.updates.len(), 1);
        assert_eq!(detail.updates[0].source_id.as_deref(), Some("gamebanana"));
        assert_eq!(detail.updates[0].version.as_deref(), Some("v1.1"));
        assert_eq!(detail.source_details.len(), 2);
        assert_eq!(detail.source_details[0].source_id, "gamebanana");
        assert_eq!(detail.source_details[0].source_mod_id.as_deref(), Some("camellya-blue-dress"));
        assert_eq!(detail.source_details[0].download_options.len(), 1);
        assert_eq!(detail.source_details[0].preview_urls.len(), 1);
        assert_eq!(detail.source_details[0].version.as_deref(), Some("v1.1"));
        assert_eq!(detail.source_details[0].tags, vec!["服装", "高清"]);
        assert_eq!(detail.source_details[1].source_id, "hui");
        assert_eq!(detail.source_details[1].title.as_deref(), Some("Camellya Azure Outfit"));
    }

    #[test]
    fn fixture_refresh_statuses_are_labeled_as_fixture_fallback() {
        let statuses = apply_cache_source_context(
            vec![UnifiedRefreshStatus {
                source_id: "hui".to_string(),
                status: "success".to_string(),
                message: Some("Fixture seeded from local dev cache.".to_string()),
            }],
            &UnifiedCacheSourceKind::DevFixture,
        );

        assert_eq!(
            statuses[0].message.as_deref(),
            Some("[fixture] Fixture seeded from local dev cache.")
        );
    }

    #[test]
    fn production_cache_candidates_exclude_dev_fixtures() {
        let candidates = resolve_cache_candidates_from_paths(
            Some(PathBuf::from("C:/Users/test/AppData/Local/jp.bhatt.wwmm")),
            Some(PathBuf::from("C:/Program Files/IMM/resources/dev-data/ww-unified-cache.json")),
            Some(PathBuf::from("D:/code/projects/integrated-mod-manager")),
            false,
        );

        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.source_kind != UnifiedCacheSourceKind::DevFixture),
            "production cache candidates must not include dev fixture paths"
        );
    }

    #[test]
    fn temp_duplicate_compare_returns_explicit_unsupported_error() {
        let result = run_temp_duplicate_compare(
            "hui".to_string(),
            "left".to_string(),
            "keke".to_string(),
            "right".to_string(),
        );

        assert_eq!(
            result.unwrap_err(),
            "Temporary duplicate comparison is not supported by this build yet."
        );
    }

    #[test]
    fn write_unified_cache_snapshot_to_path_persists_roundtrip_payload() {
        let temp_root = std::env::temp_dir().join(format!(
            "imm-unified-cache-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        ));
        let cache_path = temp_root.join("ww-unified-cache.json");
        let payload = r#"{
            "generatedAt": "2026-04-26T00:00:00Z",
            "cards": [
                {
                    "cardId": "hui:test-card",
                    "primarySourceId": "hui",
                    "displayName": "Test Card",
                    "originalNames": ["Test Card"],
                    "category": "Other",
                    "preview": null,
                    "sources": [
                        {
                            "sourceId": "hui",
                            "sourceModId": "test-card",
                            "title": "Test Card",
                            "detailUrl": "https://hui.example.com/mods/test-card",
                            "downloadOptions": [],
                            "previewUrls": [],
                            "author": "Tester",
                            "isFreePublic": true,
                            "rawUpdatedAt": "2026-04-26T00:00:00Z"
                        }
                    ],
                    "duplicateScore": 0.0,
                    "duplicateReasons": []
                }
            ]
        }"#;

        write_unified_cache_snapshot_to_path(&cache_path, payload)
            .expect("payload should be written after validation");
        let written = fs::read_to_string(&cache_path).expect("written cache should be readable");
        let snapshot = parse_unified_cache_snapshot(&written).expect("written cache should parse");

        assert_eq!(snapshot.cards.len(), 1);
        assert_eq!(snapshot.cards[0].card.card_id, "hui:test-card");

        let _ = fs::remove_file(&cache_path);
        let _ = fs::remove_dir(&temp_root);
    }

    #[test]
    fn attach_afdian_candidate_to_snapshot_adds_source_and_removes_candidate() {
        let mut snapshot = load_dev_fixture_snapshot();

        let detail = attach_afdian_candidate_to_snapshot(
            &mut snapshot,
            "gamebanana:camellya-blue-dress",
            "https://afdian.net/a/bluearchive/post/fixture-camellya",
        )
        .expect("candidate should attach");

        assert!(
            detail.card.sources.iter().any(|source| source.source_id == "afdian"),
            "afdian source should be appended to the unified card"
        );
        assert!(
            detail
                .source_details
                .iter()
                .any(|source| source.source_id == "afdian" && source.detail_url.as_deref() == Some("https://afdian.net/a/bluearchive/post/fixture-camellya")),
            "afdian source detail should be present"
        );
        assert!(
            detail
                .source_specific_notes
                .iter()
                .any(|note| note.source_id == "afdian"),
            "afdian source note should be added"
        );
        assert!(
            snapshot
                .refresh_status
                .iter()
                .any(|status| status.source_id == "afdian" && status.status == "success"),
            "afdian refresh status should be updated to success"
        );
        assert!(
            snapshot
                .afdian_candidates
                .iter()
                .all(|candidate| candidate.detail_url != "https://afdian.net/a/bluearchive/post/fixture-camellya"),
            "adopted candidate should be removed from the pending list"
        );
    }

    #[test]
    fn detach_afdian_candidate_from_snapshot_restores_candidate_and_removes_source() {
        let mut snapshot = load_dev_fixture_snapshot();
        attach_afdian_candidate_to_snapshot(
            &mut snapshot,
            "gamebanana:camellya-blue-dress",
            "https://afdian.net/a/bluearchive/post/fixture-camellya",
        )
        .expect("candidate should attach");

        let detail = detach_afdian_source_from_snapshot(&mut snapshot, "gamebanana:camellya-blue-dress")
            .expect("afdian source should detach");

        assert!(
            detail.card.sources.iter().all(|source| source.source_id != "afdian"),
            "afdian source should be removed from the unified card"
        );
        assert!(
            detail.source_details.iter().all(|source| source.source_id != "afdian"),
            "afdian source detail should be removed"
        );
        assert!(
            detail
                .source_specific_notes
                .iter()
                .all(|note| note.source_id != "afdian"),
            "afdian source note should be removed"
        );
        assert!(
            snapshot
                .afdian_candidates
                .iter()
                .any(|candidate| candidate.detail_url == "https://afdian.net/a/bluearchive/post/fixture-camellya"),
            "detached candidate should return to the pending list"
        );
    }
}
