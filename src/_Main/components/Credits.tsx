import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

let timer: ReturnType<typeof setTimeout>;
function Credits() {
	return (
		<AlertDialog>
			<AlertDialogTrigger>
				<Button
					className=" max-h-7 text-sm"
					onClick={() => {
						if (timer) clearTimeout(timer);
						timer = setTimeout(() => {
							(document.getElementById("cancel-alert") as HTMLButtonElement)?.click();
						}, 50000);
					}}
				>
					Credits
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent
				className="min-w-full border-0 h-full max-h-[calc(100%-2rem)] mt-4 overflow-hidden"
				onClick={(e) => {
					(e.currentTarget.firstChild as HTMLButtonElement)?.click();
					if (timer) clearTimeout(timer);
				}}
			>
				<AlertDialogCancel id="cancel-alert" className="absolute top-4 right-4 z-10 bg-transparent " />
				<style>{`
								@keyframes crawl {
									0% { transform: rotateX(45deg) translateY(1%); margin-top:0%; }
									100% { transform: rotateX(45deg) translateY(-200%); margin-top:-50%; }
								}
							`}</style>
				<div className="absolute inset-0 flex justify-center overflow-hidden" style={{ perspective: "400px" }}>
					<div
						className="absolute w-full max-w-2xl text-center text-muted-foreground top-full"
						style={{
							animation: "crawl 100s linear",
							transformOrigin: "50% 0%",
						}}
					>
						<img src="/IMMDecor.png" alt="IMM Logo" className="mx-auto w-64 mb-8 opacity-80" />
{/* 
						<div className="text-foreground text-2xl">Integrated</div>
						<div className=" text-accent textaccent text-lg">Mod Manager</div> */}

						<div className="text-2xl mb-16 opacity-80">A long time ago in a codebase far, far away...</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">CREATOR</div>
						<div className="text-xl mb-6">YourBadLuck</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">CONTRIBUTORS</div>
						<div className="text-xl mb-2">Antonzlo (Dev,TL-ru)</div>
						<div className="text-xl mb-2">118ununoctium (TL-cn)</div>
						<div className="text-xl mb-8">EgoMaw (Dev)</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">EMERGENCY FOOD</div>
						<div className="text-xl mb-8">Paimon (allegedly)</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">OSMANTHUS WINE TASTER</div>
						<div className="text-xl mb-8">Zhongli</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">ARTIFACT RNG CONSULTANT</div>
						<div className="text-xl mb-2">Flat DEF Enthusiast</div>
						<div className="text-lg mb-8 opacity-70">Every. Single. Roll.</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">BANGBOO CARETAKER</div>
						<div className="text-xl mb-8">Belle & Wise</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">THE BEST COMMISION BROKER EVER</div>
						<div className="text-xl mb-8">Venus</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">ECHO FARMING VICTIM</div>
						<div className="text-xl mb-2">Rover</div>
						<div className="text-lg mb-8 opacity-70">2000 echoes, still no 5-cost drop</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">The Real MVPs</div>
						<div className="text-xl mb-8">Modders who actually make the mods</div>

						<div className="text-3xl font-bold textaccent text-accent mb-2">SPECIAL THANKS</div>
						<div className="text-xl mb-2">XLXZ (XX Mod Manager)</div>
						<div className="text-xl mb-2">Agulag (No Reload Mod Manager)</div>
						<div className="text-xl mb-2">The Modding & AGMG Community</div>
						<div className="text-xl mb-2">Testers & Bug Reporters at the Discord Server</div>
						<div className="text-xl mb-2">And you, the User!</div>

						<div className="text-4xl font-bold mt-16 textaccent text-accent mb-8">MAY THE MODS BE WITH YOU</div>
						<div className="text-xl mt-12 mb-2">Thank you for using</div>
						<div className="text-foreground text-2xl">Integrated</div>
						<div className=" text-accent textaccent text-lg">Mod Manager</div>

					</div>
				</div>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export default Credits;
