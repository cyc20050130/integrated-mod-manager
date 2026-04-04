import { GAME } from "@/utils/vars";
import { useAtomValue } from "jotai";
import Help from "./Help";
import { GAME_NAMES } from "@/utils/consts";

function Page5({ setPage }: { setPage: (page: number) => void }) {
	const game = useAtomValue(GAME);
	return (
		<div className="fixed flex font-en flex-col items-center justify-center w-screen h-screen gap-2">
			<button className="fixed hidden" id="prevPage" onClick={() => setPage(3)} />
			<div className="logo min-h-40 data-gi:min-h-44 data-gi:mb-4 aspect-square"></div>
			<div className="text-accent textaccent flex text-2xl opacity-50">
				{GAME_NAMES[game] || "Integrated"} Mod Manager
			</div>
			<Help setPage={setPage} />
		</div>
	);
}
export default Page5;
