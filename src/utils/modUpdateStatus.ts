export type GameBananaFileLike = {
	_tsDateModified?: number;
	_tsDateAdded?: number;
};

export type GameBananaProfileLike = {
	_tsDateUpdated?: number;
	_tsDateModified?: number;
	_aFiles?: GameBananaFileLike[];
};

export function computeLatestRemoteTimestamp(profile: GameBananaProfileLike, fallbackTimestamp = 0) {
	let latest = fallbackTimestamp || 0;
	const profileUpdated = (profile._tsDateUpdated || 0) * 1000;
	const profileModified = (profile._tsDateModified || 0) * 1000;

	latest = Math.max(latest, profileUpdated, profileModified);

	for (const file of profile._aFiles || []) {
		latest = Math.max(latest, (file._tsDateModified || file._tsDateAdded || 0) * 1000);
	}

	return latest;
}

export function computeModUpdateStatus(input: {
	updatedAt: number;
	viewedAt: number;
	profile: GameBananaProfileLike;
}) {
	const latest = computeLatestRemoteTimestamp(input.profile, input.updatedAt || 0);
	if (!(input.updatedAt < latest)) {
		return { latest, modStatus: 0 as const };
	}

	return {
		latest,
		modStatus: (input.viewedAt < latest ? 2 : 1) as 1 | 2,
	};
}
