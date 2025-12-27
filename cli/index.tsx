#!/usr/bin/env bun

import { dirname, join } from "path";
import { spawn } from "child_process";
import { mkdir, rename, rm } from "fs/promises";
import { existsSync } from "fs";
import { useState, useEffect } from "react";
import { render, Text, Box } from "ink";

const VERSION = "0.1.1";
const COMMIT = process.env.BUILD_COMMIT || "dev";
const REPO = "jgeschwendt/git-hud";
const PORT = process.env.PORT || 3000;
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
        git-hud v{VERSION} ({COMMIT.slice(0, 7)})
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

    const packageName = `git-hud-${os}-${arch}.tar.gz`;
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
    const extractedDir = join(tempDir, `git-hud-${os}-${arch}`);
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

  const server = spawn("bun", ["run", serverPath], {
    cwd: binaryDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV,
    },
    stdio: "ignore",
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

  if (command) {
    console.log("Unknown command:", command);
    console.log("Usage: git-hud [version]");
    process.exit(1);
  }

  // Start server immediately
  render(<App port={Number(PORT)} onServerStarted={startServer} />);
}

main();
