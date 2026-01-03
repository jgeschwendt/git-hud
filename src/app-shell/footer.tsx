import { ThemeToggle } from "./theme-toggle";

export function Footer() {
  return (
    <footer className="border-t border-black/10 bg-black/5 dark:border-white/10 dark:bg-white/2">
      <div className="container mx-auto flex h-12 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="font-mono text-xs leading-none text-white/50">
          grove@0.1.1
        </div>
        <ThemeToggle />
      </div>
    </footer>
  );
}
