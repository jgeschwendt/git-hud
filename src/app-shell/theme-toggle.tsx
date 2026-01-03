"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";

export function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	if (!mounted) {
		return (
			<button
				className="rounded-md p-2 hover:bg-gray-100 dark:hover:bg-gray-800"
				disabled
			>
				<div className="h-5 w-5" />
			</button>
		);
	}

	return (
		<button
			onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
			className="rounded-md p-2 hover:bg-gray-100 dark:hover:bg-gray-800"
			aria-label="Toggle theme"
		>
			{theme === "dark" ? (
				<SunIcon className="h-5 w-5" />
			) : (
				<MoonIcon className="h-5 w-5" />
			)}
		</button>
	);
}
