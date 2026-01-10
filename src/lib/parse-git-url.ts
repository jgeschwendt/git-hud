export interface ParsedGitUrl {
  provider: string;
  username: string;
  name: string;
  url: string;
}

export function parseGitUrl(url: string): ParsedGitUrl | null {
  // SSH format: git@github.com:user/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      provider: sshMatch[1],
      username: sshMatch[2],
      name: sshMatch[3],
      url,
    };
  }

  // HTTPS format: https://github.com/user/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      provider: httpsMatch[1],
      username: httpsMatch[2],
      name: httpsMatch[3],
      url,
    };
  }

  return null;
}
