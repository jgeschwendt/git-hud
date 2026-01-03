"use client";

import { useState } from "react";
import { FolderIcon } from "@heroicons/react/24/outline";

interface EmptyStateProps {
	onClone: (url: string) => void;
}

export function EmptyState({ onClone }: EmptyStateProps) {
	const [url, setUrl] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!url.trim()) return;

		onClone(url.trim());
		setUrl("");
	};

	return (
		<div className="flex min-h-[calc(100vh-6rem)] items-center justify-center px-4">
			<div className="w-full max-w-md text-center">
				<FolderIcon className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-600" />
				<h2 className="mt-4 text-lg font-medium">No repositories</h2>
				<p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
					Clone a repository to get started
				</p>

				<form onSubmit={handleSubmit} className="mt-6">
					<input
						type="text"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="git@github.com:user/repo.git"
						className="w-full rounded border border-black/20 bg-transparent px-3 py-2 text-sm placeholder-black/40 dark:border-white/20 dark:placeholder-white/40"
					/>
				</form>
			</div>
		</div>
	);
}
