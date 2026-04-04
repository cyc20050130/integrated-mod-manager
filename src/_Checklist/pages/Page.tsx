function Page({ setPage }: { setPage: (page: number) => void }) {
	return (
		<div
			className="text-muted-foreground fixed flex flex-col items-center justify-center w-screen h-screen"
			onClick={() => {
				setPage(0);
			}}></div>
	);
}
export default Page;