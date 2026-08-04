import { refreshAppConfigRevision } from "./appConfigRepository.ts";

function normalizeRevision(value: unknown) {
	return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

export function shouldAcceptNteConfigSaveResponse(generationAtCall: number, currentGeneration: number) {
	return generationAtCall === currentGeneration;
}

export function acceptNteOperationRevision(result: unknown) {
	if (!result || typeof result !== "object") return;
	const revision = normalizeRevision((result as { configRevision?: unknown }).configRevision);
	if (revision) {
		void refreshAppConfigRevision("NTE");
	}
}
