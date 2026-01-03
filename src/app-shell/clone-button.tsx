"use client";

import { useState, useRef, useEffect } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

export function CloneButton() {
	const [isOpen, setIsOpen] = useState(false);
	const [url, setUrl] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isOpen && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isOpen]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!url.trim()) return;

		// Dispatch event for table to handle with optimistic UI
		window.dispatchEvent(new CustomEvent("grove:clone", { detail: { url: url.trim() } }));
		setUrl("");
		setIsOpen(false);
	};

	const handleClose = () => {
		setIsOpen(false);
		setUrl("");
	};

	if (!isOpen) {
		return (
			<button
				onClick={() => setIsOpen(true)}
				className="flex h-7 w-7 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10"
				title="Clone repository"
			>
				<PlusIcon className="h-4 w-4" />
			</button>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="flex items-center gap-2">
			<input
				ref={inputRef}
				type="text"
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				placeholder="git@github.com:user/repo.git"
				className="h-7 w-64 rounded border border-black/20 bg-transparent px-2 text-sm placeholder-black/40 dark:border-white/20 dark:placeholder-white/40"
				onKeyDown={(e) => {
					if (e.key === "Escape") handleClose();
				}}
			/>
			<button
				type="button"
				onClick={handleClose}
				className="flex h-7 w-7 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10"
			>
				<XMarkIcon className="h-4 w-4" />
			</button>
		</form>
	);
}
