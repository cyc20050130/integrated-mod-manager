import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import React from "react";
import { resetWithBackup } from "./filesys";
import { addToast } from "@/_Toaster/ToastProvider";
import { getCwd } from "./init";
import { join } from "./utils";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";
import { error } from "@/lib/logger";
import { invoke } from "@tauri-apps/api/core";
import { persistNteConfig } from "./nteConfigRevision";

const DISCORD_LINK = "https://discord.gg/QGkKzNapXZ";
const BANANA_LINK = "https://gamebanana.com/mods/593490";

type State = {
	hasError: boolean;
	error?: Error | null;
	info?: React.ErrorInfo | null;
};

type ErrorBoundaryProps = {
	children?: React.ReactNode;
};

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, State> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null, info: null };
	}

	static getDerivedStateFromError(error: Error) {
		return { hasError: true, error };
	}

	override componentDidCatch(err: Error, info: React.ErrorInfo) {
		// Save stack info for showing/copying and basic logging
		this.setState({ error: err, info });
		// Also log to console so devs can see it in logs
		// In future this could POST to a backend or a webhook
		// but currently there's no webhook configured in the repo.
		// Keep this synchronous and safe.
		try {
			error("Uncaught error:", err, info);
		} catch {
			// ignore
		}
	}

	reload = () => {
		try {
			window.location.reload();
		} catch {
			// fallback
			window.location.assign(window.location.href);
		}
	};

	openDiscord = () => {
		try {
			window.open(DISCORD_LINK, "_blank", "noopener,noreferrer");
		} catch {
			// ignore
		}
	};

	copyDetails = async () => {
		const { error, info } = this.state;
		const payload = {
			message: error?.message || "No error message",
			stack: (error && (error.stack || "")) || "",
			componentStack: (info && info.componentStack) || "",
			userAgent: navigator.userAgent,
			time: new Date().toISOString(),
		};
		const text = JSON.stringify(payload, null, 2);
		try {
			await navigator.clipboard.writeText(text);
			// provide a small visual hint by temporarily changing title? keep simple
			// We don't show toast here to avoid adding new dependencies.
		} catch {
			// ignore
		}
	};
	importer = async (error: string) => {
		try {
			const dialogOptions: NonNullable<Parameters<typeof open>[0]> = {
				title: "Import Config",
				filters: [
					{
						name: "JSON files",
						extensions: ["json", "json.bak"],
					},
				],
			};

			dialogOptions.defaultPath = join(getCwd(), "backups");

			const filePath = await open(dialogOptions);

			if (filePath) {
				const content = JSON.parse(await readTextFile(filePath as string));
				if (content && content.game && error.includes(content.game)) {
					const serialized = JSON.stringify(content, null, 2);
					if (content.game === "NTE") await persistNteConfig(serialized);
					else await writeTextFile(`config${content.game}.json`, serialized);
					window.location.reload();
				}
			}
		} catch {
			addToast({ type: "error", message: "Error importing config" });
		}
	};

	override render() {
		if (!this.state.hasError) return this.props.children as React.ReactElement;

		const { error, info } = this.state;

		return (
			<>
				<div
					className="bg-bgg fixed w-screen h-screen"
					style={{
						opacity: 0.1,
						animation: "moveDiagonal 15s linear infinite",
					}}
				></div>
				<div className="w-full font-en flex flex-col backdrop-blur-[3px] gap-2 h-screen items-center justify-center bg-background/25 game-font">
					<img src="/IMMDecor.png" style={{ objectFit: "cover", objectPosition: "0 -12px" }} />
					<div className="text-accent text-5xl">Oh no!</div>
					<div className="text-sm text-muted-foreground mb-4">Something went wrong and the app cannot continue.</div>

					{error && (
						<div className="mb-4 text-sm text-destructive flex gap-2">
							<div className="font-medium">Error:</div>
							<pre className="whitespace-pre-wrap max-w-108">{error.message}</pre>
						</div>
					)}

					<div className="flex gap-2 mb-4">
						<Button className="w-36" onClick={this.reload} aria-label="Reload application">
							Reload App
						</Button>

						{/* <button
							className="border border-accent text-accent px-3 py-1 rounded"
							onClick={this.openDiscord}
							aria-label="Open Discord report link"
						>
							Open Discord (report)
						</button> */}
						{error?.message.startsWith("Corrupted config file detected") && (
							<Button className="w-36" onClick={() => this.importer(error.message)} aria-label="Copy error details">
								Import Config
							</Button>
						)}
						<Button className="w-36" onClick={() => resetWithBackup()} aria-label="Copy error details">
							Backup & Reset
						</Button>
						<Button className="w-36" onClick={() => invoke("open_logs_folder")} aria-label="Copy error details">
							Open Logs Folder
						</Button>
					</div>
					{info?.componentStack && (
						<Dialog>
							<DialogTrigger className="text-xs text-muted hover:brightness-125 duration-200">
								Show Comp. Stack
							</DialogTrigger>
							<DialogContent>
								<div className="min-h-fit text-accent my-6 text-3xl">
									Component Stack Trace
									<Tooltip>
										<TooltipTrigger asChild>
											<span aria-hidden="true" />
										</TooltipTrigger>
										<TooltipContent className="opacity-0"></TooltipContent>
									</Tooltip>
								</div>
								<div className="max-h-[80vh] text-sm overflow-y-scroll">{info.componentStack}</div>
							</DialogContent>
						</Dialog>
					)}
					<div className="flex fixed bottom-4 items-center gap-2">
						<label className="opacity-50">Contact Developer</label>
						<a
							href={BANANA_LINK}
							target="_blank"
							rel="noreferrer noopener"
							className="hover:opacity-100 flex items-center gap-1 text-xs duration-200 opacity-50"
						>
							{" "}
							<img className="h-4" src="/GBLogo.png" /> <img className="h-3" src="/GBTitle.png" />
						</a>
						<label className="opacity-50">-</label>
						<a
							href={DISCORD_LINK}
							target="_blank"
							rel="noreferrer noopener"
							className="hover:opacity-100 flex items-center gap-1 text-xs duration-200 opacity-50"
						>
							{" "}
							<img className="h-6" src="/DCLogoTitle.svg" />
						</a>
					</div>
				</div>
			</>
		);
	}
}
