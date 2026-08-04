import { Button } from "@/components/ui/button";
import type { AppStateBootstrapStatus } from "@/utils/appConfigRepository";
import { retryAppStateBootstrap } from "@/utils/appConfigRepository";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, RefreshCw, RotateCcw } from "lucide-react";
import { useState } from "react";

type RecoveryStatus = Extract<AppStateBootstrapStatus, { status: "recoveryRequired" }>;

export default function RecoveryCenter({ status }: { status: RecoveryStatus }) {
	const [busy, setBusy] = useState<"retry" | "reset" | "">("");
	const [error, setError] = useState(status.error);

	async function retry() {
		setBusy("retry");
		try {
			const next = await retryAppStateBootstrap();
			if (next.status === "ready") window.location.reload();
			else if (next.status === "recoveryRequired") setError(next.error);
		} catch (retryError) {
			setError(String(retryError || "Unable to retry application state recovery."));
		} finally {
			setBusy("");
		}
	}

	async function reset() {
		setBusy("reset");
		try {
			await invoke("reset_app_state_with_backup");
			window.location.reload();
		} catch (resetError) {
			setError(String(resetError || "Unable to reset application state."));
			setBusy("");
		}
	}

	return (
		<div className="bg-background/80 fixed z-100 flex h-screen w-screen items-center justify-center backdrop-blur-md">
			<div className="flex w-full max-w-2xl flex-col items-center gap-5 px-8 text-center">
				<div className="logo h-24 w-24" />
				<h1 className="text-accent text-3xl">Application State Recovery</h1>
				<p className="text-muted-foreground max-h-40 w-full overflow-auto text-sm wrap-break-word">{error}</p>
				<div className="flex flex-wrap justify-center gap-3">
					<Button onClick={() => void retry()} disabled={!!busy}>
						<RefreshCw className={busy === "retry" ? "animate-spin" : ""} />
						Retry
					</Button>
					<Button variant="outline" onClick={() => void invoke("open_app_state_folder")} disabled={!!busy}>
						<FolderOpen />
						Open Backup Folder
					</Button>
					<Button variant="destructive" onClick={() => void reset()} disabled={!!busy}>
						<RotateCcw className={busy === "reset" ? "animate-spin" : ""} />
						Backup & Reset
					</Button>
				</div>
			</div>
		</div>
	);
}
