import { RepositoryTable } from "./repository-table";

// Static export - start with empty state, SSE will populate
export function RepositoriesLoader() {
  return <RepositoryTable initialRepositories={[]} />;
}
