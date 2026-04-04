import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import Page1 from "./pages/Page1";
import Page2 from "./pages/Page2";
import Page3 from "./pages/Page3";
import Page4 from "./pages/Page4";
import Page5 from "./pages/Page5";
function Checklist() {
	const [page, setPage] = useState(0);
	const pages = [
		<Page1 setPage={setPage} />,
		<Page2 setPage={setPage} />,
		<Page3 setPage={setPage} />,
		<Page4 setPage={setPage} />,
		<Page5 setPage={setPage} />
	];
	return (
		<motion.div
			key="intro"
			initial={{ opacity: page !== 0 ? 1 : 0, filter: "blur(6px)", pointerEvents: "none" }}
			animate={{ opacity: 1, filter: "blur(0px)", pointerEvents: "auto" }}
			exit={{ opacity: 0, filter: "blur(6px)", pointerEvents: "none" }}
			className="bg-background/50 backdrop-blur-md fixed z-10 w-screen h-screen"
		>
			<AnimatePresence mode="wait">
				<motion.div
					key={page}
					initial={{ opacity: 0, pointerEvents: "none" }}
					animate={{ opacity: 1, pointerEvents: "auto" }}
					exit={{ opacity: 0, pointerEvents: "none" }}
					transition={{
						duration: 0.3,
						ease: "easeInOut",
					}}
					className="w-full h-full"
				>
					{pages[page]}
				</motion.div>
			</AnimatePresence>
		</motion.div>
	);
}
export default Checklist;
