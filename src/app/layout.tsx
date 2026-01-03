import "./globals.css";

import type { Metadata } from "next";
import type { PropsWithChildren } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "next-themes";
import { Header } from "@/app-shell/header";
import { Footer } from "@/app-shell/footer";

export const metadata: Metadata = {
	title: "grove - Worktree Manager",
	description: "Git worktree dashboard with bare repository management",
};

export default function RootLayout({ children }: PropsWithChildren) {
	return (
		<html
			className={`${GeistSans.variable} ${GeistMono.variable}`}
			lang="en"
			suppressHydrationWarning
		>
			<body className="flex min-h-screen flex-col bg-white text-black dark:bg-black dark:text-white">
				<ThemeProvider attribute="class">
					<Header />
					<main className="flex-1">{children}</main>
					<Footer />
				</ThemeProvider>
			</body>
		</html>
	);
}
