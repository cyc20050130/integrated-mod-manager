import { addToast } from "@/_Toaster/ToastProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { MOD_LIST, GAME, SETTINGS, TEXT_DATA, WUWA_MOD_FIXER_OPEN } from "@/utils/vars";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { CircleAlert, FolderOpenIcon, Loader2Icon, RefreshCwIcon, RotateCcwIcon, WrenchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	checkWuwaModFixerUpdate,
	FIXER_LABEL,
	FIXER_RELEASES_URL,
	getWuwaModFixerMissingMessage,
	getWuwaModFixerWarning,
	installOrUpdateWuwaModFixer,
	launchWuwaModFixer,
	openWuwaModFixerFolder,
	type WuwaModFixerCheckResult,
} from "@/utils/wuwaModFixer";
import { refreshModList } from "@/utils/filesys";
import { applyLinkAuditSuggestions, runLinkIntegrityScan, runPreviewBackfill } from "@/utils/linkIntegrity";

type DialogStatus = "idle" | "checking" | "installing" | "running" | "syncing" | "error";

function WuwaModFixer() {
	const game = useAtomValue(GAME);
	const settings = useAtomValue(SETTINGS);
	const textData = useAtomValue(TEXT_DATA);
	const setModList = useSetAtom(MOD_LIST);
	const [open, setOpen] = useAtom(WUWA_MOD_FIXER_OPEN);
	const [status, setStatus] = useState<DialogStatus>("idle");
	const [result, setResult] = useState<WuwaModFixerCheckResult | null>(null);
	const [errorMessage, setErrorMessage] = useState("");
	const activeGame = settings.global.game || game;

	const installed = settings.global.wuwaModFixer;
	const copy = useMemo(() => {
		const toolText = ((textData?._Main?._components?._WuwaModFixer || {}) as Record<string, string | undefined>) || {};
		return {
			title: toolText["Title"] || FIXER_LABEL,
			description:
				toolText["Description"] ||
				"Repair older Wuthering Waves mods that stopped working after game updates using the fixer bundled inside IMM.",
			check: toolText["Check"] || "Verify Bundled Tool",
			download: toolText["Download"] || "Reinstall Bundled Tool",
			run: toolText["Run"] || "Run Fixer",
			folder: toolText["Folder"] || "Open Tool Folder",
			latest: toolText["Latest"] || "Bundled version",
			installed: toolText["Installed"] || "Installed",
			notInstalled: toolText["NotInstalled"] || "Not installed",
			upToDate: toolText["UpToDate"] || "Bundled fixer is ready to use.",
			updateAvailable: toolText["UpdateAvailable"] || "Bundled fixer is ready to use.",
			notes: toolText["Notes"] || "Release notes",
			installing: toolText["Installing"] || "Copying bundled tool files...",
			running: toolText["Running"] || "Launching fixer...",
			checking: toolText["Checking"] || "Preparing bundled fixer...",
			syncing: toolText["Syncing"] || "Refreshing mods and restoring lost links...",
			resync: toolText["Resync"] || "Refresh Mods + Restore Links",
			resyncHint:
				toolText["ResyncHint"] ||
				"After you finish repairing mods in the external fixer, click this to rescan renamed folders and restore saved source links.",
			launchFailed: toolText["LaunchFailed"] || "Failed to launch Wuwa Mod Fixer.",
			installedSuccess: toolText["InstalledSuccess"] || "Bundled Wuwa Mod Fixer is ready.",
			launchedSuccess: toolText["LaunchedSuccess"] || "Wuwa Mod Fixer launched.",
			relinked: toolText["Relinked"] || "Restored <count/> lost mod link(s).",
			noRelinks: toolText["NoRelinks"] || "No lost mod links were detected.",
			actionFailed: toolText["ActionFailed"] || "Tool action failed.",
			errorTitle: toolText["ErrorTitle"] || "Tool action failed.",
			noNotes: toolText["NoNotes"] || "No release notes available.",
			triggerIdle: toolText["TriggerIdle"] || "Fixer",
			triggerBusy: toolText["TriggerBusy"] || "Working",
			triggerUpdate: toolText["TriggerUpdate"] || "Fixer Ready",
			triggerError: toolText["TriggerError"] || "Fixer Error",
			warning: getWuwaModFixerWarning(textData),
			missing: getWuwaModFixerMissingMessage(textData),
		};
	}, [textData]);

	useEffect(() => {
		if (activeGame !== "WW" && open) {
			setOpen(false);
		}
	}, [activeGame, open, setOpen]);

	async function refresh() {
		setStatus("checking");
		setErrorMessage("");
		try {
			const next = await checkWuwaModFixerUpdate();
			setResult(next);
			setStatus("idle");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error || "Unknown release check error");
			setErrorMessage(message);
			setStatus("error");
		}
	}

	async function install() {
		setStatus("installing");
		setErrorMessage("");
		try {
			await installOrUpdateWuwaModFixer();
			addToast({ type: "success", message: copy.installedSuccess });
			await refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error || "Unknown install error");
			setErrorMessage(message);
			setStatus("error");
		}
	}

	async function runFixer() {
		setStatus("running");
		setErrorMessage("");
		try {
			await launchWuwaModFixer();
			addToast({ type: "success", message: copy.launchedSuccess });
			setStatus("idle");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error || copy.launchFailed);
			setErrorMessage(message);
			setStatus("error");
		}
	}

	async function syncModsAfterFix() {
		setStatus("syncing");
		setErrorMessage("");
		try {
			setModList(await refreshModList());
			const report = await runLinkIntegrityScan(["WW"]);
			const relinked = await applyLinkAuditSuggestions(report, ["WW"], 0.58);
			const finalReport = await runLinkIntegrityScan(["WW"]);
			if (relinked.applied > 0) {
				setModList(await refreshModList());
				addToast({
					type: "success",
					message: copy.relinked.replace("<count/>", String(relinked.applied)),
				});
			} else {
				addToast({
					type: "info",
					message: copy.noRelinks,
				});
			}
			void runPreviewBackfill(finalReport);
			setStatus("idle");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error || copy.actionFailed);
			setErrorMessage(message);
			setStatus("error");
		}
	}

	useEffect(() => {
		if (!open || activeGame !== "WW") return;
		void Promise.resolve().then(refresh);
	}, [open, activeGame]);

	if (activeGame !== "WW") return null;

	const busy = ["checking", "installing", "running", "syncing"].includes(status);
	const latestVersion = result?.latest.version || "";
	const installedVersion = installed.version || result?.installed.version || "";
	const installedExePath = installed.exePath || result?.installed.exePath || "";
	const updateAvailable = false;
	const triggerLabel =
		status === "error"
			? copy.triggerError
			: busy
				? copy.triggerBusy
				: updateAvailable
					? copy.triggerUpdate
					: copy.triggerIdle;
	const triggerIcon =
		status === "error" ? (
			<CircleAlert className="h-3.5 w-3.5 shrink-0" />
		) : busy ? (
			<Loader2Icon className="h-3.5 w-3.5 shrink-0 animate-spin" />
		) : (
			<WrenchIcon className="h-3.5 w-3.5 shrink-0" />
		);
	const statusText =
		status === "checking"
			? copy.checking
			: status === "installing"
				? copy.installing
				: status === "running"
					? copy.running
					: status === "syncing"
						? copy.syncing
						: result
							? updateAvailable
								? copy.updateAvailable
								: installedVersion
									? copy.upToDate
									: copy.missing
							: copy.checking;

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					disabled={busy}
					className="bg-sidebar flex h-6 max-w-36 items-center gap-1 border px-2 text-[10px] leading-none"
				>
					{triggerIcon}
					<span className="truncate">{triggerLabel}</span>
				</Button>
			</DialogTrigger>
			<DialogContent className="game-font w-[min(96vw,56rem)] max-w-[56rem] gap-0 overflow-hidden p-0">
				<div className="flex flex-col gap-5 px-6 pb-6 pt-8">
					<div className="space-y-2">
						<div className="text-accent text-3xl leading-tight">{copy.title}</div>
						<div className="text-muted-foreground max-w-3xl text-sm leading-6">{copy.description}</div>
					</div>

					<div className="grid gap-3 md:grid-cols-2">
						<div className="bg-sidebar/30 flex min-w-0 flex-col gap-1 rounded-md border p-3 text-sm">
							<div className="text-accent">{copy.installed}</div>
							<div className="text-muted-foreground break-all">{installedVersion || copy.notInstalled}</div>
							{installedExePath ? (
								<div className="text-muted-foreground mt-1 break-all text-[11px] opacity-70">{installedExePath}</div>
							) : null}
						</div>
						<div className="bg-sidebar/30 flex min-w-0 flex-col gap-1 rounded-md border p-3 text-sm">
							<div className="text-accent">{copy.latest}</div>
							<div className="text-muted-foreground break-all">{latestVersion || "-"}</div>
						</div>
					</div>

					<div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-sm leading-6 text-amber-100">
						{copy.warning}
					</div>

					<div className="rounded-md border px-4 py-3">
						<div className="text-muted-foreground text-sm leading-6">{statusText}</div>
						<div className="text-muted-foreground mt-2 text-xs leading-5">{copy.resyncHint}</div>
					</div>

					<Separator />

					<div className="min-h-0 max-h-[18rem] overflow-y-auto pr-1">
						{status === "error" ? (
							<div className="flex flex-col gap-3">
								<div className="text-destructive text-sm">{copy.errorTitle}</div>
								<div className="text-muted-foreground whitespace-pre-wrap break-words text-sm leading-6">
									{errorMessage || copy.actionFailed}
								</div>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								<div className="text-accent text-sm">{copy.notes}</div>
								<div className="text-muted-foreground whitespace-pre-wrap break-words text-sm leading-6">
									{result?.latest.notes?.trim() || copy.noNotes}
								</div>
							</div>
						)}
					</div>

					<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
						<Button
							variant="outline"
							className="h-auto min-h-10 whitespace-normal py-2 text-center"
							disabled={busy}
							onClick={() => void openWuwaModFixerFolder()}
						>
							<FolderOpenIcon className="mr-1 h-4 w-4 shrink-0" />
							<span className="leading-tight">{copy.folder}</span>
						</Button>
						<Button
							className="h-auto min-h-10 whitespace-normal py-2 text-center"
							disabled={busy}
							onClick={() => void refresh()}
						>
							<RotateCcwIcon className="mr-1 h-4 w-4 shrink-0" />
							<span className="leading-tight">{copy.check}</span>
						</Button>
						<Button
							className="h-auto min-h-10 whitespace-normal py-2 text-center"
							disabled={busy || !result}
							onClick={() => void install()}
						>
							<RotateCcwIcon className="mr-1 h-4 w-4 shrink-0" />
							<span className="leading-tight">{copy.download}</span>
						</Button>
						<Button
							className="h-auto min-h-10 whitespace-normal py-2 text-center"
							disabled={busy || !installedExePath}
							onClick={() => void runFixer()}
						>
							<WrenchIcon className="mr-1 h-4 w-4 shrink-0" />
							<span className="leading-tight">{copy.run}</span>
						</Button>
					</div>

					<Button
						variant="secondary"
						className="h-auto min-h-11 whitespace-normal py-3 text-center"
						disabled={busy}
						onClick={() => void syncModsAfterFix()}
					>
						<RefreshCwIcon className={`mr-2 h-4 w-4 shrink-0 ${status === "syncing" ? "animate-spin" : ""}`} />
						<span className="leading-tight">{copy.resync}</span>
					</Button>

					<div className="text-muted-foreground break-all text-xs leading-5">
						{busy
							? status === "checking"
								? copy.checking
								: status === "installing"
									? copy.installing
									: status === "running"
										? copy.running
										: copy.syncing
							: result?.latest.url || FIXER_RELEASES_URL}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export default WuwaModFixer;
