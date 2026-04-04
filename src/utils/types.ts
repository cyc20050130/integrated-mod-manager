export type Games = "WW" | "ZZ" | "GI" | "SR" | "EF" | ""; //| "GI" ;
export type Language = "en" | "cn" | "ru" | "jp" | "kr" | "";
export interface DirEntry {
	name: string;
	isDirectory: boolean;
	icon?: string;
	children?: DirEntry[];
}
export interface GlobalSettings {
	bgOpacity: number;
	winOpacity: number;
	winType: 0 | 1 | 2;
	bgType: 0 | 1 | 2;
	listType: 0;
	nsfw: 0 | 1 | 2;
	toggleClick: 0 | 2;
	ignore: string;
	clientDate: string;
	XXMI: string;
	lang: Language;
	game: Games;
	version?: string;
	updatedAt?: string;
	notice?: number;
	preReleases: boolean;
	chkModUpdates: boolean;
}
export interface GameSettings {
	launch: 0 | 1 | 2;
	hotReload: 0 | 1 | 2;
	onlineType: string;
	customCategories: { [key: string]: CustomCategory };
	download: DownloadSettings;
}
export interface Settings {
	global: GlobalSettings;
	game: GameSettings;
}
export interface DownloadSettings {
	maxConcurrentDownloads: number;
	maxConcurrentExtracts: number;
	requestRetries: number;
	connectTimeoutSec: number;
	stallTimeoutSec: number;
	maxRequeueRounds: number;
	progressIntervalMs: number;
	progressBytesThresholdKB: number;
	backoffBaseMs: number;
}
export interface CustomCategory {
	_sIconUrl: string;
	_sAltIconUrl?: string;
}

export interface Category {
	_idRow: number;
	_sName: string;
	_nItemCount: number;
	_nCategoryCount: number;
	_sUrl: string;
	_sIconUrl: string;
	_sAltIconUrl?: string;
	_special?: boolean;
}
export interface ModData {
	source?: string;
	updatedAt?: number;
	viewedAt?: number;
	tags?: string[];
	note?: string;
	namespace?: string;
	// state?: { [key: string]: any };
	vars?: { [key: string]: any };
	crop?: {
		scale?: number;
		x?: number;
		y?: number;
		vertical?: boolean;
	};
}
export interface ModDataObj {
	[key: string]: ModData;
}
export interface Preset {
	name: string;
	data: string[];
	hotkey?: string;
}
export interface GameConfig {
	version: string;
	game: Games;
	custom: 0 | 1;
	sourceDir: string;
	targetDir: string;
	settings: GameSettings;
	data: ModDataObj;
	presets: Preset[];
	categories: Category[];
	downloads?: DownloadList;
	updatedAt: string;
}
export interface DownloadItem {
	status: "pending" | "downloading" | "completed" | "failed" | "extracting";
	addon: boolean;
	preview: string;
	category: string;
	source: string;
	file: string;
	updated: number;
	name: string;
	displayName?: string;
	safeName?: string;
	fname: string;
	key?: string;
	path?: string;
	dlPath?: string;
	updatedAt?: number;
	requeueRounds?: number;
	lastError?: string;
	createdAt?: number;
	lastTriedAt?: number;
}
export interface DownloadList {
	queue: DownloadItem[];
	downloading: DownloadItem[];
	completed: DownloadItem[];
	extracting: DownloadItem[];
	failed: DownloadItem[];
}
export interface ModHotKeys {
	key: string;
	type: string;
	target: string;
	name: string;
	values: string[];
	default: string;
	file: string;
	namespace: string;
	pref: string | null;
	reset: string | null;
}
export interface Mod {
	isDir: boolean;
	name: string;
	parent: string;
	path: string;
	keys: ModHotKeys[];
	files?: Record<string, ModHotKeys[]>;
	namespace?: string;
	enabled: boolean;
	children: Mod[];
	depth: number;
	icon?: string;
	source?: string;
	updatedAt?: number;
	viewedAt?: number;
	note?: string;
	tags?: string[];
	hashes?: string[];
	crop?: {
		scale?: number;
		x?: number;
		y?: number;
		vertical?: boolean;
	};
}
export interface ProgressData {
	title: string;
	finished: boolean;
	button: string;
	open: boolean;
	name: string;
}
export interface InstalledItem {
	name: string;
	source: string;
	updated: number;
	viewed: number;
	modStatus: number;
}
export interface OnlineModImage {
	_sType: string;
	_sBaseUrl: string;
	_sFile: string;
	_sFile220?: string;
	_hFile220?: number;
	_wFile220?: number;
	_sFile530?: string;
	_hFile530?: number;
	_wFile530?: number;
	_sFile100: string;
	_hFile100: number;
	_wFile100: number;
}
export interface OnlineModPreviewMedia {
	_aImages: OnlineModImage[];
}
export interface OnlineModSubmitter {
	_idRow: number;
	_sName: string;
	_bIsOnline: boolean;
	_bHasRipe?: boolean;
	_sProfileUrl: string;
	_sAvatarUrl: string;
	_sHdAvatarUrl: string;
	_sUpicUrl?: string;
	_sMoreByUrl?: string;
}
export interface OnlineModCategory {
	_sName: string;
	_sProfileUrl: string;
	_sIconUrl: string;
}
export interface OnlineMod {
	_idRow: number;
	_sModelName: string;
	_sSingularTitle?: string;
	_sIconClasses?: string;
	_sName: string;
	_sProfileUrl: string;
	_tsDateAdded?: number;
	_tsDateModified?: number;
	_tsDateUpdated?: number;
	_bHasFiles?: boolean;
	_aTags?: any[];
	_aFiles?: any[];
	_aPreviewMedia?: OnlineModPreviewMedia;
	_aSubmitter: OnlineModSubmitter;
	_aRootCategory: OnlineModCategory;
	_sVersion?: string;
	_bIsObsolete?: boolean;
	_sInitialVisibility: string;
	_bHasContentRatings?: boolean;
	_nLikeCount: number;
	_nPostCount: number;
	_bWasFeatured?: boolean;
	_nViewCount?: number;
	_bIsOwnedByAccessor?: boolean;
	_sImageUrl?: string;
	_aComments?: any[];
	_sPeriod?: "today" | "yesterday" | "week" | "month" | "3month" | "6month" | "year" | "alltime";
}
export interface OnlineData {
	[key: string]: OnlineMod[] | OnlineMod;
}
export interface ChangeInfo {
	before: DirEntry[];
	after: DirEntry[];
	map: Record<string, DirEntry>;
	title: string;
	skip: boolean;
}

export interface LinkAuditModEntry {
	path: string;
	category: string;
	name: string;
	hasDataRecord: boolean;
	source?: string;
}

export interface LinkAuditOrphanEntry {
	path: string;
	category: string;
	name: string;
	source: string;
}

export interface LinkAuditSuggestion {
	game: Games;
	localPath: string;
	candidateDataPath: string;
	source: string;
	confidence: number;
	reason: string;
}

export interface LinkAuditGameReport {
	game: Games;
	configPath: string;
	sourceDir: string;
	modRoot: string;
	scannedAt: string;
	matched: LinkAuditModEntry[];
	unlinked: LinkAuditModEntry[];
	orphans: LinkAuditOrphanEntry[];
	suggestedMappings: LinkAuditSuggestion[];
	warnings: string[];
}

export interface LinkAuditSummary {
	matched: number;
	unlinked: number;
	orphans: number;
	suggestedMappings: number;
}

export interface LinkAuditReport {
	generatedAt: string;
	scope: Games[];
	games: LinkAuditGameReport[];
	summary: LinkAuditSummary;
}

export interface PreviewBackfillState {
	running: boolean;
	queued: number;
	completed: number;
	failed: number;
	skippedCooldown: number;
	lastRunAt: number;
	lastError?: string;
}
