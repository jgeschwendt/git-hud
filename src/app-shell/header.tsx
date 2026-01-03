import { CloneButton } from "./clone-button";

export function Header() {
  return (
    <header className="border-b border-black/10 bg-black/5 dark:border-white/10 dark:bg-white/2">
      <div className="container mx-auto flex h-12 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M23 2.5L12 21.5L1 2.5H23Z" />
          </svg>

          <svg
            className="h-5 opacity-50"
            viewBox="0 0 15 24"
            fill="currentColor"
          >
            <path d="M13.5 2.5L2.5 21.5H1L12 2.5H13.5Z" />
          </svg>

          <h1 className="sr-only text-sm font-medium">grove</h1>
        </div>

        <CloneButton />
      </div>
    </header>
  );
}
