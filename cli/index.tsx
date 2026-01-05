#!/usr/bin/env bun

import { dirname, join, resolve } from "path";
import { spawn } from "child_process";
import { mkdir, rename, rm, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { useState, useEffect } from "react";
import { render, Text, Box } from "ink";
import { harvest } from "../src/lib/seed";

const VERSION = "0.1.1";
const COMMIT = process.env.BUILD_COMMIT || "dev";
const REPO = "jgeschwendt/grove";
const PORT = process.env.PORT || 7777;
const NODE_ENV = process.env.NODE_ENV || "production";

type UpdateStatus =
  | "checking"
  | "downloading"
  | "installing"
  | "complete"
  | "none"
  | "error";

interface AppProps {
  port: number;
  onServerStarted: () => void;
}

function App({ port, onServerStarted }: AppProps) {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("checking");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    onServerStarted();
    checkAndUpdate(setUpdateStatus, setLatestVersion).catch(() => {});
  }, []);

  return (
    <Box flexDirection="column">
      <Text color="green">
        grove v{VERSION} ({COMMIT.slice(0, 7)})
      </Text>
      <Text color="cyan">Server running on http://localhost:{port}</Text>

      {updateStatus === "checking" && (
        <Text color="gray">Checking for updates...</Text>
      )}

      {updateStatus === "downloading" && latestVersion && (
        <Text color="yellow">
          Update available: {VERSION} → {latestVersion}
        </Text>
      )}

      {updateStatus === "installing" && (
        <Text color="yellow">Installing update...</Text>
      )}

      {updateStatus === "complete" && latestVersion && (
        <Box marginTop={1}>
          <Text color="green">
            ✓ Updated to {latestVersion}! Restart to use new version.
          </Text>
        </Box>
      )}
    </Box>
  );
}

async function checkAndUpdate(
  setStatus: (status: UpdateStatus) => void,
  setVersion: (version: string) => void
): Promise<void> {
  try {
    // Get latest release info
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`
    );
    if (!response.ok) {
      setStatus("none");
      return;
    }

    const data = await response.json();
    const latestVersion = data.tag_name.replace(/^v/, "");

    if (latestVersion === VERSION) {
      setStatus("none");
      return;
    }

    setVersion(latestVersion);
    setStatus("downloading");

    // Detect platform
    const os = process.platform === "darwin" ? "darwin" : "linux";
    const arch =
      process.arch === "x64"
        ? "x64"
        : process.arch === "arm64"
        ? "arm64"
        : null;

    if (!arch) {
      setStatus("error");
      return;
    }

    const packageName = `${os}-${arch}.tar.gz`;
    const asset = data.assets.find((a: any) => a.name === packageName);

    if (!asset) {
      setStatus("error");
      return;
    }

    // Download tarball
    const downloadResponse = await fetch(asset.browser_download_url);
    if (!downloadResponse.ok) {
      setStatus("error");
      return;
    }

    const arrayBuffer = await downloadResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    setStatus("installing");

    // Get install directory
    const binaryPath = process.execPath;
    const appDir = dirname(binaryPath);
    const installDir = dirname(appDir);
    const tempDir = join(installDir, "tmp");

    // Create temp directory
    await mkdir(tempDir, { recursive: true });

    // Write tarball
    const tarballPath = join(tempDir, packageName);
    await Bun.write(tarballPath, buffer);

    // Extract
    const extractProc = Bun.spawn(["tar", "-xzf", packageName], {
      cwd: tempDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await extractProc.exited;

    // Backup current version
    const backupDir = join(installDir, "app.backup");
    if (existsSync(backupDir)) {
      await rm(backupDir, { recursive: true });
    }
    await rename(appDir, backupDir);

    // Move new version
    const extractedDir = join(tempDir, `${os}-${arch}`);
    await rename(extractedDir, appDir);

    // Cleanup
    await rm(tempDir, { recursive: true });

    setStatus("complete");
  } catch (err) {
    setStatus("error");
  }
}

function startServer() {
  const binaryPath = process.execPath;
  const binaryDir = dirname(binaryPath);
  const serverPath = join(binaryDir, "server.js");
  const bunPath = join(binaryDir, "bun");

  const server = spawn(bunPath, ["--bun", serverPath], {
    cwd: binaryDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV,
    },
    stdio: "inherit",
  });

  server.on("error", (err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    server.kill();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.kill();
    process.exit(0);
  });
}

async function main() {
  const command = process.argv[2];

  if (command === "version") {
    console.log(`${VERSION} (${COMMIT})`);
    return;
  }

  if (command === "harvest") {
    const filePath = process.argv[3];
    if (!filePath) {
      console.error("Usage: grove harvest <path/to/seed.jsonl>");
      process.exit(1);
    }

    const content = harvest();
    const lines = content.split("\n").filter(Boolean);

    await writeFile(resolve(filePath), content);
    console.log(`Exported ${lines.length} repositories to ${filePath}`);
    return;
  }

  if (command === "grow") {
    const filePath = process.argv[3];
    if (!filePath) {
      console.error("Usage: grove grow <path/to/seed.jsonl>");
      process.exit(1);
    }

    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const content = await readFile(resolve(filePath), "utf-8");
    const entries = content.split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);

    console.log(`Importing ${entries.length} repositories via server API\n`);

    const serverUrl = `http://localhost:${PORT}`;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      console.log(`[${i + 1}/${entries.length}] Cloning ${entry.url}...`);

      // Call server API to clone
      const cloneRes = await fetch(`${serverUrl}/api/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: entry.url }),
      });

      if (!cloneRes.ok) {
        console.log(`  ✗ Clone request failed`);
        continue;
      }

      console.log(`  ✓ Clone started (watch UI for progress)`);

      // If worktrees specified, we need the repo_id - poll until clone completes
      if (entry.worktrees?.length > 0) {
        console.log(`  Waiting for clone to complete...`);

        let repoId: string | null = null;
        for (let attempt = 0; attempt < 120; attempt++) { // 2 min timeout
          await new Promise((r) => setTimeout(r, 1000));

          const stateRes = await fetch(`${serverUrl}/api/repositories`);
          const repos = await stateRes.json();
          const repo = repos.find((r: any) => r.clone_url === entry.url);

          if (repo) {
            // Check if main worktree is ready
            const mainWt = repo.worktrees?.find((w: any) => w.path.endsWith("/.main"));
            if (mainWt?.status === "ready") {
              repoId = repo.id;
              break;
            }
          }
        }

        if (!repoId) {
          console.log(`  ✗ Timeout waiting for clone`);
          continue;
        }

        console.log(`  ✓ Clone complete`);

        // Create worktrees
        for (const branch of entry.worktrees) {
          console.log(`  Creating worktree: ${branch}...`);

          await fetch(`${serverUrl}/api/worktree`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo_id: repoId, branch }),
          });

          console.log(`    ✓ Started (watch UI for progress)`);
        }
      }
    }

    console.log(`\nDone. Watch the UI for real-time progress.`);
    return;
  }

  if (command === "start" || !command) {
    // Start server
    render(<App port={Number(PORT)} onServerStarted={startServer} />);
    return;
  }

  console.log("Unknown command:", command);
  console.log("Usage: grove [command]");
  console.log("");
  console.log("Commands:");
  console.log("  start              Start the grove server (default)");
  console.log("  harvest <file>     Export repositories to seed.jsonl");
  console.log("  grow <file>        Import repositories from seed.jsonl");
  console.log("  version            Show version");
  process.exit(1);
}

main();
