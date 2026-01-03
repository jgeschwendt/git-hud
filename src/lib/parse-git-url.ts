export function parseGitUrl(url: string): {
  provider: string;
  username: string;
  name: string;
} | null {
  // SSH: git@github.com:user/repo.git
  // HTTPS: https://github.com/user/repo.git

  let match;
  if (url.startsWith("git@")) {
    match = url.match(/git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
    if (match) {
      return {
        provider: match[1].split(".")[0],
        username: match[2],
        name: match[3],
      };
    }
  } else if (url.startsWith("http")) {
    match = url.match(/https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (match) {
      return {
        provider: match[1].split(".")[0],
        username: match[2],
        name: match[3],
      };
    }
  }

  return null;
}
