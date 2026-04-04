import { Button } from "@/components/ui/button";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { motion } from "motion/react";
// import { useEffect } from "react";
import { CHANGES, PROGRESS_OVERLAY, TEXT_DATA } from "@/utils/vars";
import { cancelRestore, verifyDirStruct } from "@/utils/filesys";
function Progress() {
	const textData = useAtomValue(TEXT_DATA);
	const [restoreInfo, setRestoreInfo] = useAtom(PROGRESS_OVERLAY);
	const setChanges = useSetAtom(CHANGES);
	// useEffect(() => {
	// 	if (restoreInfo.open && restoreInfo.finished && restoreInfo.title == "Restore Point Created") {
	// 		// updateInfo("Optimizing dir structure...");
	// 		applyChanges(true).then(() => {
	// 			setChanges((prev) => ({ ...prev, skip: true }));
	// 		});
	// 	}
	// }, [restoreInfo]);
	//info(restoreInfo);
	return (
		<motion.div
			initial={{ opacity: 0, filter: "blur(6px)" }}
			animate={{ opacity: 1, filter: "blur(0px)" }}
			exit={{ opacity: 0, filter: "blur(6px)" }}
			className="text-accent pointer-eve nts-none bg-background/50 fixed z-50 flex flex-col items-center justify-center w-full h-full duration-200"
			style={{
				backdropFilter: "blur(5px)",
			}}
		>
			<div className="min-h-fit text-accent my-6 text-3xl">
				{restoreInfo.title
					.replace("Creating Restore Point", textData._Progress.CreatingRestorePoint)
					.replace("Restore Point Created", textData._Progress.RestorePointCreated)
					.replace(
						"Restoring from",
						textData._Progress.RestoringFrom +
							(restoreInfo.title.startsWith("Restoring from") ? `: ${restoreInfo.name}` : "")
					)
					.replace("Operation Cancelled", textData._Progress.OperationCancelled)
					.replace("Restoration Completed", textData._Progress.RestorationCompleted)}
			</div>
			<div className="w-120 bg-background/50 button-like h-8 overflow-hidden border rounded-lg">
				<div
					id="restore-progress"
					className="bg-muted data-zzz:bg-accent bgaccent zzz-rounded w-0 h-full duration-100 rounded-lg opacity-75"
				/>
			</div>
			<div className="w-120 text-accent/75 flex items-center justify-between gap-2 mt-2 text-sm">
				<label className="whitespace-nowrap text-ellipsis w-full overflow-hidden">
					<span id="restore-progress-message"></span>
				</label>
				<label id="restore-progress-percentage">0%</label>
			</div>
			<Button
				variant={restoreInfo.finished ? "default" : "warn"}
				className=" w-32 my-6"
				onClick={async () => {
					setRestoreInfo((prev) => ({ ...prev, finished: true }));
					if (!restoreInfo.finished) {
						cancelRestore();
					} else {
						if (restoreInfo.title == "Restoration Completed") setChanges(await verifyDirStruct());
						setRestoreInfo((prev) => ({ ...prev, open: false }));
					}
				}}
			>
				{restoreInfo.finished ? <>{textData._Progress.Close}</> : <>{textData.Cancel}</>}
			</Button>
		</motion.div>
	);
}
export default Progress;
