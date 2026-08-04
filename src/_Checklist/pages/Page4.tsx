import { addToast } from "@/_Toaster/ToastProvider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GAME_NAMES, GAMES, managedSRC, managedTGT } from "@/utils/consts";
import {
	applyPreset,
	ensureManagedSourceDir,
	flushRuntimeState,
	folderSelector,
	verifyDirStruct,
} from "@/utils/filesys";
import { completeRuntimeBootstrap, getCwd, getDataDir, readXXMIConfig, verifyGameDir } from "@/utils/init";
import { join } from "@/utils/utils";
import { CHANGES, GAME, NTE_REGION, SOURCE, TARGET, TEXT_DATA, XXMI_DIR, XXMI_MODE } from "@/utils/vars";
import { NteRegion } from "@/utils/types";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { CheckIcon, FolderCog2Icon, HelpCircleIcon, InfoIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { info } from "@/lib/logger";

type NteGameRootValidation = {
	valid: boolean;
	root: string;
	region: Exclude<NteRegion, "auto"> | null;
	candidates: string[];
	modsRoot: string;
	launcherPath: string;
	gameExecutablePath: string;
	evidence: string[];
	message: string;
};

const NTE_REGIONS: NteRegion[] = ["auto", "global", "cn", "tw"];
const NTE_REGION_LABELS: Record<NteRegion, string> = { auto: "Auto", global: "Global", cn: "CN", tw: "TW" };

function errorMessage(value: unknown, fallback: string) {
	if (value instanceof Error) return value.message;
	if (typeof value === "object" && value && "message" in value) return String(value.message);
	return String(value || fallback);
}

function Page4({ setPage }: { setPage: (page: number) => void }) {
	const [tgt, setTgt] = useState(getDataDir());
	const [src, setSrc] = useState(tgt);
	const [checked, setChecked] = useAtom(XXMI_MODE);
	const [checked2, setChecked2] = useState(true);
	const setSource = useSetAtom(SOURCE);
	const [xxmiDir, setXxmiDir] = useAtom(XXMI_DIR);
	const setTarget = useSetAtom(TARGET);
	const textData = useAtomValue(TEXT_DATA);
	const game = useAtomValue(GAME);
	const setChanges = useSetAtom(CHANGES);
	const [nteGameRoot, setNteGameRoot] = useState("");
	const [nteRegion, setNteRegion] = useAtom(NTE_REGION);
	const [nteBusy, setNteBusy] = useState(false);
	if (game === "NTE") {
		return (
			<div className="text-muted-foreground fixed flex flex-col items-center justify-center w-screen h-screen">
				<div className="fixed z-20 flex flex-col items-center justify-center w-full duration-200">
					<div className="text-accent flex w-full max-w-xl flex-col items-center gap-5 text-2xl">
						<h2 className="text-center text-balance">{GAME_NAMES.NTE}</h2>
						<div className="flex w-full items-center gap-2">
							<Label htmlFor="nte-game-root" className="w-28 text-sm">
								{textData._Checklist.NTEGameRoot}
							</Label>
							<Input
								id="nte-game-root"
								name="nteGameRoot"
								autoComplete="off"
								className="min-w-0 flex-1 text-ellipsis"
								readOnly
								value={nteGameRoot || "-"}
							/>
							<Button
								size="icon"
								title={textData.Browse}
								aria-label={textData.Browse}
								onClick={async () => {
									const selected = await folderSelector(nteGameRoot, textData._Checklist.NTESelectGameRoot);
									if (typeof selected === "string") setNteGameRoot(selected);
								}}
							>
								<FolderCog2Icon aria-hidden="true" className="h-4 w-4" />
							</Button>
						</div>
						<div className="flex w-full items-center gap-2">
							<Label id="nte-region-label" className="w-28 text-sm">
								{textData._Checklist.NTERegion}
							</Label>
							<div className="grid flex-1 grid-cols-4 gap-1" role="group" aria-labelledby="nte-region-label">
								{NTE_REGIONS.map((region) => (
									<Button
										key={region}
										type="button"
										aria-pressed={nteRegion === region}
										variant={nteRegion === region ? "default" : "outline"}
										onClick={() => setNteRegion(region)}
									>
										{NTE_REGION_LABELS[region]}
									</Button>
								))}
							</div>
						</div>
						<Button
							className="mt-2 w-32"
							disabled={nteBusy}
							onClick={async () => {
								if (!nteGameRoot) {
									addToast({ message: textData._Checklist.NTEGameRootNotConfigured, type: "error" });
									return;
								}
								setNteBusy(true);
								try {
									const validation = await invoke<NteGameRootValidation>("validate_nte_game_root", {
										path: nteGameRoot,
										region: nteRegion === "auto" ? null : nteRegion,
									});
									if (!validation.valid || !validation.region) {
										addToast({ message: validation.message, type: "error" });
										return;
									}
									const sourceRoot = join(getCwd(), "nte-library");
									const normalizedSource = sourceRoot.replaceAll("/", "\\").replace(/\\+$/g, "").toLowerCase();
									const normalizedGameRoot = validation.root.replaceAll("/", "\\").replace(/\\+$/g, "").toLowerCase();
									if (
										!sourceRoot ||
										normalizedSource === normalizedGameRoot ||
										normalizedSource.startsWith(`${normalizedGameRoot}\\`)
									) {
										throw new Error(textData._Checklist.NTEManagedLibraryOutside);
									}
									await flushRuntimeState("configure-nte", {
										source: sourceRoot,
										target: validation.modsRoot,
										xxmiMode: 1,
										nteRegion: validation.region,
									});
									await ensureManagedSourceDir("NTE");
									setSource(sourceRoot);
									setTarget(validation.modsRoot);
									setChecked(1);
									setNteRegion(validation.region);
									setChanges({ before: [], after: [], map: {}, skip: true, title: "" });
									setPage(4);
									completeRuntimeBootstrap("NTE");
								} catch (validationError) {
									addToast({
										message: errorMessage(validationError, textData._Checklist.NTEGameRootNotConfigured),
										type: "error",
									});
								} finally {
									setNteBusy(false);
								}
							}}
						>
							{textData.Confirm}
						</Button>
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="text-muted-foreground fixed flex flex-col items-center justify-center w-screen h-screen">
			<div className="fixed z-20 flex flex-col items-center justify-center w-full duration-200">
				{
					<div className="text-accent flex flex-col items-center gap-5 my-2 text-2xl">
						{textData._Checklist._Help.Select} {textData._Checklist[checked ? "CustomDir" : "XXMILDir"]}
						<div
							className="flex items-center gap-2"
							style={{
								opacity: checked ? 0 : 1,
								height: checked ? "0px" : "40px",
								transition: "all 0.3s ease-in-out",
								pointerEvents: checked ? "none" : "auto",
								marginTop: checked ? "-10px" : 0,
								marginBottom: checked ? "-10px" : 0,
							}}
						>
							<Dialog>
								<Tooltip>
									<DialogTrigger asChild>
										<TooltipTrigger asChild>
											<Button className="aspect-square items-center justify-center">
												<HelpCircleIcon className="hover:opacity-100 inline w-5 h-5 opacity-50" />
											</Button>
										</TooltipTrigger>
									</DialogTrigger>
									<TooltipContent>
										<p className="text-center w-20">{textData._Checklist.ClickHelp}</p>
									</TooltipContent>
								</Tooltip>
								<DialogContent className="min-h-130">
									<div className="min-h-fit text-accent my-6 text-3xl">
										{textData._Checklist.SelectingXXMIDir}
										<Tooltip>
											<TooltipTrigger asChild>
												<span aria-hidden="true" />
											</TooltipTrigger>
											<TooltipContent className="opacity-0"></TooltipContent>
										</Tooltip>
									</div>
									<div className="flex gap-4">
										<div className="w-1/2 items-center text-xs flex flex-col">
											<div className="flex  text-success items-center text-xl justify-center my-4 gap-2">
												<CheckIcon className="inline w-6 h-6" />
												{textData._Checklist.Correct}
											</div>
											<img src="/EX_COR_XX.png" className="border-2 mb-1 border-success rounded-md" />
											<label>{textData._Checklist.SelectXXMIFolder}</label>
											<img src="/EX_COR_CONFIG.png" className="border-2 mt-4 mb-1 border-success rounded-md" />
											<label>{textData._Checklist.ContainConfig}</label>
										</div>
										<div className="w-1/2 items-center text-xs flex flex-col">
											<div className="flex  text-destructive items-center text-xl justify-center my-4 gap-2">
												<XIcon className="inline w-6 h-6" />
												{textData._Checklist.Incorrect}
											</div>
											<img src="/EX_INC_GI.png" className="border-2 mb-2 border-destructive rounded-md" />
											<img src="/EX_INC_WW.png" className="border-2 mt-4 mb-2 border-destructive rounded-md" />
											<img src="/EX_INC_ZZ.png" className="border-2 mt-4 mb-1 border-destructive rounded-md" />
											<label>{textData._Checklist.DoNotSelectFolders}</label>
										</div>
									</div>
								</DialogContent>
							</Dialog>
							<Button
								className="aspect-square items-center justify-center"
								onClick={async () => {
									let path = ((await folderSelector(tgt)) as string) || "";
									path =
										(path.endsWith("MI") && GAMES.map((game) => game + "MI").includes(path.split("\\").pop() ?? "")) ||
										path.endsWith("XXMI Launcher Config.json")
											? path.split("\\").slice(0, -1).join("\\")
											: path;

									setXxmiDir(path);
								}}
							>
								<FolderCog2Icon className="inline w-4 h-4" />
							</Button>
							<Input
								type="text"
								onFocus={(e) => {
									e.currentTarget.blur();
									(e.currentTarget.previousElementSibling as HTMLElement)?.click();
								}}
								className="w-108 border-border/0 bg-input/50 text-accent/75 text-ellipsis h-10 overflow-hidden text-center cursor-default"
								value={xxmiDir?.replace("/", "\\") ?? "-"}
							/>
						</div>
						<div className=" min-w-fit flex items-center gap-2">
							<Checkbox
								checked={!checked}
								onClick={() => setChecked(checked ? 0 : 1)}
								className=" checked:bg-accent bgaccent"
							/>
							<label className="text-accent/75 min-w-fit text-sm">{textData._Checklist.UsingXXMILauncher}</label>
						</div>
						<div
							className="flex items-center gap-2 overflow-y-hidden"
							style={{
								opacity: !checked ? 0 : 1,
								height: !checked ? "0px" : "40px",
								transition: "all 0.3s ease-in-out",
								pointerEvents: !checked ? "none" : "auto",
								marginTop: !checked ? "-10px" : 0,
								marginBottom: !checked ? "-10px" : 0,
							}}
						>
							<Label className="flex items-center gap-1">
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="flex items-center justify-center">
											<InfoIcon className="hover:opacity-100 inline w-4 h-4 opacity-50" />
										</span>
									</TooltipTrigger>
									<TooltipContent>
										<p className="w-48 text-center">{textData._Checklist.ThisDirTarget}</p>
									</TooltipContent>
								</Tooltip>
								{textData._Checklist.TargetDir}
							</Label>
							<Input
								type="text"
								className="w-96 border-border/0 bg-input/50 text-accent/75 text-ellipsis h-10 overflow-hidden text-center cursor-default"
								value={tgt?.replace("/", "\\") ?? "-"}
							/>
							<Button
								className="w-32"
								onClick={async () => {
									let path = ((await folderSelector(tgt)) as string) || tgt || "";
									path = path.endsWith(managedSRC)
										? path.split(managedSRC)[0]
										: path.endsWith(managedTGT)
											? path.split(managedTGT)[0]
											: path;
									setTgt(path);
									if (checked2) {
										setSrc(path);
									}
								}}
							>
								{textData.Browse}
							</Button>
						</div>
						<div
							className="flex items-center gap-2 overflow-y-hidden"
							style={{
								opacity: !checked || checked2 ? 0 : 1,
								height: !checked || checked2 ? "0px" : "40px",
								transition: "all 0.3s ease-in-out",
								pointerEvents: !checked || checked2 ? "none" : "auto",
								marginTop: !checked || checked2 ? "-10px" : 0,
								marginBottom: !checked || checked2 ? "-10px" : 0,
							}}
						>
							<Label className="flex items-center gap-1">
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="flex items-center justify-center">
											<InfoIcon className="hover:opacity-100 inline w-4 h-4 opacity-50" />
										</span>
									</TooltipTrigger>
									<TooltipContent>
										<p className="w-48 text-center">{textData._Checklist.ThisDirSource}</p>
									</TooltipContent>
								</Tooltip>
								{textData._Checklist.SourceDir}
							</Label>
							<Input
								type="text"
								className="w-96 border-border/0 bg-input/50 text-accent/75 text-ellipsis h-10 overflow-hidden text-center cursor-default"
								value={src?.replace("/", "\\") ?? "-"}
							/>
							<Button
								className="w-32"
								onClick={async () => {
									if (checked2) return;
									let path = ((await folderSelector(src)) as string) || src || "";
									path = path.endsWith(managedSRC)
										? path.split(managedSRC)[0]
										: path.endsWith(managedTGT)
											? path.split(managedTGT)[0]
											: path;
									setSrc(path);
								}}
							>
								{textData.Browse}
							</Button>
						</div>
						<div
							className=" min-w-fit flex items-center gap-2"
							style={{
								opacity: !checked ? 0 : 1,
								height: !checked ? "0px" : "40px",
								transition: "all 0.3s ease-in-out",
								pointerEvents: !checked ? "none" : "auto",
								marginTop: !checked ? "-10px" : 0,
								marginBottom: !checked ? "-10px" : 0,
							}}
						>
							<Checkbox
								checked={checked2}
								onClick={() => setChecked2(!checked2)}
								className=" checked:bg-accent bgaccent"
							/>
							<label className="text-accent/75 min-w-fit text-sm">{textData._Checklist.SameDir}</label>
						</div>
						<Button
							className={"w-32 mt-2"}
							onClick={async () => {
								let nextSource = checked2 ? tgt : src;
								let nextTarget = tgt;
								if (checked) {
									setTarget(nextTarget);
									setSource(nextSource);
								} else {
									await flushRuntimeState("configure-xxmi-root", { xxmiDir });
									await readXXMIConfig();
									const dirs = await verifyGameDir(game);
									info("verfiying game directories", { dirs });
									if (!dirs.sourceDir || !dirs.targetDir) {
										addToast({
											message: textData._Toasts.XXMIConfErr,
											type: "error",
										});
										return;
									}
									nextSource = dirs.sourceDir;
									nextTarget = dirs.targetDir;
									setSource(nextSource);
									setTarget(nextTarget);
								}
								await flushRuntimeState("configure-game-paths", {
									source: nextSource,
									target: nextTarget,
									xxmiMode: checked,
									xxmiDir,
								});
								await applyPreset([]);
								setChanges(await verifyDirStruct());
								setPage(4);
							}}
						>
							{textData.Confirm}
						</Button>
					</div>
				}
			</div>
		</div>
	);
}
export default Page4;
