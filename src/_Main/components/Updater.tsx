import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { BANANA_LINK, DISCORD_LINK, VERSION } from "@/utils/consts";
import { flushRuntimeState } from "@/utils/filesys";
import { refreshAppUpdateCheck } from "@/utils/init";
import { getPortableUpdateUrl } from "@/utils/updateMode";
import { getTimeDifference } from "@/utils/utils";
import { IMM_UPDATE, TEXT_DATA, UPDATER_OPEN } from "@/utils/vars";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useAtomValue } from "jotai";
import { CircleAlert, DownloadIcon, Loader2Icon, RotateCcwIcon, UploadIcon } from "lucide-react";
import { useMemo, useState } from "react";
import Credits from "./Credits";

type ParsedUpdateBody = {
	major?: string[];
	minor?: string[];
	patch?: string[];
};

function Updater() {
	const textData = useAtomValue(TEXT_DATA);
	const [update, setUpdate] = useAtom(IMM_UPDATE);
	const [updaterOpen, setUpdaterOpen] = useAtom(UPDATER_OPEN);
	const [progress, setProgress] = useState(0);
	const [renderedAtSeconds] = useState(() => Date.now() / 1000);
	const updateBody = update?.body;

	const parsedBody = useMemo<ParsedUpdateBody>(() => {
		if (!updateBody) return {};
		try {
			return JSON.parse(updateBody) as ParsedUpdateBody;
		} catch {
			return {};
		}
	}, [updateBody]);

	const major = parsedBody.major || [];
	const minor = parsedBody.minor || [];
	const patch = parsedBody.patch || [];
	const busy =
		update?.status === "checking" ||
		update?.status === "downloading" ||
		update?.status === "installing" ||
		update?.status === "relaunching";

	async function triggerCheck(openDialog = true) {
		setProgress(0);
		await refreshAppUpdateCheck(openDialog);
	}

	async function installUpdate() {
		if (!update?.raw) {
			await triggerCheck(true);
			return;
		}

		let downloaded = 0;
		let contentLength = 0;
		try {
			await flushRuntimeState("before-update-install");
			setProgress(0);
			setUpdate((prev) => (prev ? { ...prev, status: "downloading", error: "" } : prev));
			const installContext = await invoke<{
				currentExePath: string;
				currentExeDir: string;
				managedInstallDir: string;
				portable: boolean;
			}>("get_update_install_context");
			const portableUpdateUrl = getPortableUpdateUrl(update.raw.rawJson);
			if (installContext.portable) {
				if (!portableUpdateUrl) {
					throw new Error("Portable update asset URL is missing from the updater manifest.");
				}
				setUpdate((prev) => (prev ? { ...prev, status: "installing" } : prev));
				await invoke("install_portable_update", {
					downloadUrl: portableUpdateUrl,
					version: update.version,
				});
				return;
			}
			await update.raw.download((event) => {
				switch (event.event) {
					case "Started":
						contentLength = Number(event.data?.contentLength || 0);
						downloaded = 0;
						setProgress(0);
						break;
					case "Progress":
						downloaded += Number(event.data?.chunkLength || 0);
						if (contentLength > 0) {
							setProgress(Math.max(0, Math.min(100, Math.floor((downloaded / contentLength) * 100))));
						}
						break;
					case "Finished":
						setProgress(100);
						setUpdate((prev) => (prev ? { ...prev, status: "installing" } : prev));
						break;
				}
			});
			await update.raw.install();
			setUpdate((prev) => (prev ? { ...prev, status: "relaunching" } : prev));
			await invoke("request_app_restart");
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error || "Update install failed");
			setUpdate((prev) =>
				prev
					? {
							...prev,
							status: "error",
							error: message,
						}
					: {
							version: VERSION,
							date: "",
							body: "{}",
							status: "error",
							raw: null,
							error: message,
						}
			);
		}
	}

	let header = null as React.ReactNode;
	if (update?.status === "available") {
		header = (
			<div className="min-w-fit text-background button-like bg-accent flex items-center justify-center w-full h-5 gap-1 px-2 rounded-sm pointer-events-none">
				<UploadIcon className="max-h-3.5" />
				<Label className="w-fit text-xs pointer-events-none">{textData.Update}</Label>
			</div>
		);
	} else if (update?.status === "downloading") {
		header = (
			<div className="min-w-fit text-background button-like bg-accent flex items-center justify-center w-full h-5 gap-1 px-2 rounded-sm pointer-events-none">
				<Loader2Icon className="max-h-3.5 animate-spin" />
				<Label className="w-fit text-xs pointer-events-none">{`${textData._Main._components._Updater.Downloading} ${progress}%`}</Label>
			</div>
		);
	} else if (update?.status === "installing") {
		header = (
			<div className="min-w-fit text-background button-like bg-accent flex items-center justify-center w-full h-5 gap-1 px-2 rounded-sm pointer-events-none">
				<Loader2Icon className="max-h-3.5 animate-spin" />
				<Label className="w-fit text-xs pointer-events-none">Installing</Label>
			</div>
		);
	} else if (update?.status === "relaunching") {
		header = (
			<div className="min-w-fit text-background button-like bg-accent flex items-center justify-center w-full h-5 gap-1 px-2 rounded-sm pointer-events-none">
				<Loader2Icon className="max-h-3.5 animate-spin" />
				<Label className="w-fit text-xs pointer-events-none">Restarting</Label>
			</div>
		);
	} else if (update?.status === "error") {
		header = (
			<div className="min-w-fit text-background button-like bg-destructive flex items-center justify-center w-full h-5 gap-1 px-2 rounded-sm pointer-events-none">
				<CircleAlert className="max-h-3.5" />
				<Label className="w-fit text-xs pointer-events-none">{textData._Main._components._Updater.Error}</Label>
			</div>
		);
	}

	return (
		<Dialog open={updaterOpen} onOpenChange={setUpdaterOpen}>
			<DialogTrigger asChild>
				<Button
					disabled={busy}
					className="text-ellipsis bg-sidebar flex h-6 p-0 overflow-hidden text-xs pointer-events-auto"
				>
					<img src="IMMDecor.png" className="h-6.5 min-w-fit p-2 pr-0" />
					{header || <div className="mr-1">{`v${VERSION}`}</div>}
				</Button>
			</DialogTrigger>
			<DialogContent className="game-font">
				<div className="min-h-fit text-accent mt-6 text-3xl">{textData._Main._components._Updater.Updater}</div>
				<div className="min-h-fit text-muted-foreground -mt-4">v{VERSION}</div>
				<div className="min-h-fit text-muted-foreground -mt-4">
					<Credits />
				</div>

				{update?.status === "available" ||
				update?.status === "downloading" ||
				update?.status === "installing" ||
				update?.status === "relaunching" ? (
					<>
						<div className="min-h-2 text-accent w-full text-xl">
							Version {update.version}{" "}
							<span className="text-muted-foreground text-base">
								(
								{getTimeDifference(
									renderedAtSeconds,
									new Date(update.date || renderedAtSeconds * 1000).getTime() / 1000
								)}{" "}
								{textData._Main._components._Updater.ago})
							</span>
						</div>
						<Separator className="my-2" />
					</>
				) : null}

				<div className="h-72 max-h-72 flex flex-col w-full px-4 overflow-x-hidden overflow-y-auto">
					{update?.status === "available" ||
					update?.status === "downloading" ||
					update?.status === "installing" ||
					update?.status === "relaunching" ? (
						<>
							{major.length > 0 && (
								<div className="min-h-6 text-accent">{textData._Main._components._Updater.Maj}:</div>
							)}
							{major.map((item: string, index: number) => (
								<div
									key={`major_${index}`}
									className="min-h-fit text-muted-foreground flex items-center gap-2 mt-1 text-lg"
								>
									<div className="min-w-1 min-h-1 aspect-square bg-accent self-start mt-3 rounded-full"></div>
									<div>{item}</div>
								</div>
							))}
							{minor.length > 0 && (
								<div className="min-h-6 text-accent mt-4">{textData._Main._components._Updater.Min}:</div>
							)}
							{minor.map((item: string, index: number) => (
								<div
									key={`minor_${index}`}
									className="min-h-fit text-base text-muted-foreground flex items-center mt-0.5 gap-2"
								>
									<div className="min-w-1 min-h-1 self-start mt-2.5 aspect-square bg-accent rounded-full"></div>
									<div>{item}</div>
								</div>
							))}
							{patch.length > 0 && (
								<div className="min-h-6 text-accent mt-4">{textData._Main._components._Updater.Patch}:</div>
							)}
							{patch.map((item: string, index: number) => (
								<div key={`patch_${index}`} className="min-h-fit text-muted-foreground flex items-center gap-2 mt-0.5">
									<div className="min-w-1 min-h-1 self-start mt-2.5 aspect-square bg-accent rounded-full"></div>
									<div>{item}</div>
								</div>
							))}
						</>
					) : update?.status === "error" ? (
						<div className="text-muted-foreground flex flex-col justify-center w-full h-full gap-3">
							<div className="text-destructive">Update check or install failed.</div>
							<div className="text-sm whitespace-pre-wrap">{update.error || "Unknown updater error"}</div>
						</div>
					) : update?.status === "checking" ? (
						<div className="text-muted-foreground flex flex-col items-center justify-center w-full h-full gap-3">
							<Loader2Icon className="w-6 h-6 animate-spin" />
							<div>Checking for updates...</div>
						</div>
					) : (
						<div className="text-muted-foreground flex flex-col items-center justify-center w-full h-full">
							{textData._Main._components._Updater.Lat}
							<div className="mt-124 absolute flex items-center gap-2">
								<label className="opacity-40">{textData.BFR}</label>
								<label>:</label>
								<a
									href={BANANA_LINK}
									target="_blank"
									rel="noreferrer noopener"
									className="hover:opacity-100 flex items-center gap-1 text-xs duration-200 opacity-50"
								>
									<img className="h-4" src="/GBLogo.png" /> <img className="h-3" src="/GBTitle.png" />
								</a>
								|
								<a
									href={DISCORD_LINK}
									target="_blank"
									rel="noreferrer noopener"
									className="hover:opacity-100 flex items-center gap-1 text-xs duration-200 opacity-50"
								>
									<img className="h-6" src="/DCLogoTitle.svg" />
								</a>
							</div>
						</div>
					)}
				</div>

				<div className="flex items-center justify-end w-full h-10 mt-2">
					<div className="text-muted-foreground w-full text-xs">
						{update?.status === "downloading"
							? `${textData._Main._components._Updater.Downloading} ${progress}%`
							: update?.status === "installing"
								? "Installing update package..."
								: update?.status === "relaunching"
									? "Restarting into the new version..."
									: update?.status === "error"
										? "Retry the updater check."
										: update?.status === "available"
											? textData._Main._components._Updater.Use
											: "Run an update check now."}
					</div>
					<Button
						className="w-32"
						disabled={busy}
						onClick={() => void (update?.status === "available" ? installUpdate() : triggerCheck(true))}
					>
						{update?.status === "available" ? (
							<>
								<DownloadIcon className="w-4 h-4 mr-1" />
								{textData.Update}
							</>
						) : (
							<>
								<RotateCcwIcon className="w-4 h-4 mr-1" />
								Check Again
							</>
						)}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export default Updater;
