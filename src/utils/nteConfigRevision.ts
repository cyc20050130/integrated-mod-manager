import { invoke } from "@tauri-apps/api/core";

let currentRevision: string | null = null;
let nativeMutationGeneration = 0;
let saveQueue: Promise<void> = Promise.resolve();

function normalizeRevision(value: unknown) {
	return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

export function shouldAcceptNteConfigSaveResponse(generationAtCall: number, currentGeneration: number) {
	return generationAtCall === currentGeneration;
}

export function setNteConfigRevision(value: unknown) {
	currentRevision = normalizeRevision(value);
}

export function acceptNteOperationRevision(result: unknown) {
	if (!result || typeof result !== "object") return;
	const revision = normalizeRevision((result as { configRevision?: unknown }).configRevision);
	if (revision) {
		currentRevision = revision;
		nativeMutationGeneration += 1;
	}
}

export function loadNteConfigText() {
	return invoke<string>("load_nte_config");
}

export async function persistNteConfig(contents: string) {
	const parsed = JSON.parse(contents) as { updatedAt?: unknown };
	const incomingRevision = normalizeRevision(parsed.updatedAt);
	if (!incomingRevision) throw new Error("NTE configuration update has no revision.");
	const expectedAtCall = currentRevision;
	const generationAtCall = nativeMutationGeneration;
	const save = saveQueue.then(async () => {
		const expectedUpdatedAt = generationAtCall === nativeMutationGeneration ? currentRevision : expectedAtCall;
		const committedRevision = await invoke<string>("save_nte_config", {
			contents,
			expectedUpdatedAt,
		});
		if (shouldAcceptNteConfigSaveResponse(generationAtCall, nativeMutationGeneration)) {
			currentRevision = committedRevision;
		}
	});
	saveQueue = save.catch(() => undefined);
	await save;
}
