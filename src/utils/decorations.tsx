import { Button } from "@/components/ui/button";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtom, useAtomValue } from "jotai";
import { ArrowLeftIcon, ArrowRightIcon, MinusIcon, RectangleHorizontalIcon, XIcon } from "lucide-react";
import { INIT_DONE, LEFT_SIDEBAR_OPEN, ONLINE, RIGHT_SIDEBAR_OPEN, RIGHT_SLIDEOVER_OPEN } from "./vars";
import Help from "@/_Main/components/Help";
import Updater from "@/_Main/components/Updater";
import WuwaModFixer from "@/_Main/components/WuwaModFixer";

const appWindow = getCurrentWindow();

function Decorations() {
	const [leftSidebarOpen, setLeftSidebarOpen] = useAtom(LEFT_SIDEBAR_OPEN);
	const [rightSidebarOpen, setRightSidebarOpen] = useAtom(RIGHT_SIDEBAR_OPEN);
	const [rightSlideOverOpen, setRightSlideOverOpen] = useAtom(RIGHT_SLIDEOVER_OPEN);
	const online = useAtomValue(ONLINE);
	const initDone = useAtomValue(INIT_DONE);

	return (
		<div
			data-tauri-drag-region
			className="game-font pointer-events-auto z-2000 bg-sidebar fixed top-0 left-0 right-0 flex h-8 w-screen items-center border-b select-none"
		>
			<div className="flex h-full w-full items-center">
				<div
					className="flex h-full items-center gap-1 -mr-2 text-xs duration-200"
					style={{
						minWidth: leftSidebarOpen ? "20.75rem" : "3.75rem",
						justifyContent: leftSidebarOpen ? "" : "center",
					}}
				/>
				<Button
					onClick={(e) => {
						e.stopPropagation();
						setLeftSidebarOpen((prev: boolean) => !prev);
					}}
					className="flex h-4 w-4 items-center justify-center gap-0 pointer-events-auto"
				>
					<ArrowLeftIcon
						className="max-h-3.5 stroke-1 duration-200"
						style={{
							width: leftSidebarOpen ? "1.5rem" : "0rem",
						}}
					/>
					<ArrowRightIcon
						className="max-h-3.5 stroke-1 duration-200"
						style={{
							width: leftSidebarOpen ? "0rem" : "1.5rem",
						}}
					/>
				</Button>

				<div className="relative flex h-full min-w-0 flex-1 items-center">
					<div className="pointer-events-none absolute inset-x-0 flex justify-center px-24">
						<div className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto">
							<Updater />
							<WuwaModFixer />
						</div>
					</div>
					<div className="ml-auto mr-2 flex items-center">{initDone ? <Help /> : <div />}</div>
				</div>

				<div
					style={{
						minWidth: rightSidebarOpen ? "16.25rem" : "1.5rem",
					}}
					className="mx-1 flex items-center justify-start duration-200"
				>
					<Button
						onClick={(e) => {
							e.stopPropagation();
							if (online) {
								setRightSlideOverOpen((prev: boolean) => !prev);
							} else {
								setRightSidebarOpen((prev: boolean) => !prev);
							}
						}}
						className="flex h-4 w-4 items-center justify-center gap-0 pointer-events-auto"
					>
						<ArrowRightIcon
							className="max-h-3.5 stroke-1 duration-200"
							style={{
								width: (online ? rightSlideOverOpen : rightSidebarOpen) ? "1.5rem" : "0rem",
							}}
						/>
						<ArrowLeftIcon
							className="max-h-3.5 stroke-1 duration-200"
							style={{
								width: (online ? rightSlideOverOpen : rightSidebarOpen) ? "0rem" : "1.5rem",
							}}
						/>
					</Button>
				</div>
			</div>

			<div className="z-200 flex gap-1 px-1 pointer-events-auto">
				<Button onClick={() => appWindow.minimize()} variant="warn" className="h-4 w-4">
					<MinusIcon className="max-h-3" />
				</Button>
				<Button onClick={() => appWindow.toggleMaximize()} variant="success" className="h-4 w-4">
					<RectangleHorizontalIcon className="max-h-3 scale-x-80" />
				</Button>
				<Button onClick={() => appWindow.close()} variant="destructive" className="h-4 w-4">
					<XIcon className="max-h-3" />
				</Button>
			</div>
		</div>
	);
}

export default Decorations;
