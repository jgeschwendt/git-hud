import { Suspense } from "react";
import { RepositoriesLoader } from "./components/repositories-loader";

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center">
          <div className="text-sm opacity-40">Loading...</div>
        </div>
      }
    >
      <RepositoriesLoader />
    </Suspense>
  );
}
