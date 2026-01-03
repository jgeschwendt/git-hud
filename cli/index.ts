#!/usr/bin/env bun

import { dirname, join } from 'path'
import { spawn } from 'child_process'
import { mkdir, rename, rm } from 'fs/promises'
import { existsSync } from 'fs'

const VERSION = '0.1.0'
const REPO = 'jgeschwendt/git-hud'
const PORT = process.env.PORT || 3000
const NODE_ENV = process.env.NODE_ENV || 'production'

async function main() {
  const command = process.argv[2] || 'start'

  switch (command) {
    case 'start': {
      console.log(`Starting git-hud on http://localhost:${PORT}`)

      // Check for updates in background (non-blocking)
      checkAndUpdate().catch(() => {})

      // Get the directory containing the binary
      const binaryPath = process.execPath
      const binaryDir = dirname(binaryPath)
      const serverPath = join(binaryDir, 'server.js')

      // Spawn server as subprocess with bun
      const server = spawn('bun', ['run', serverPath], {
        cwd: binaryDir,
        env: {
          ...process.env,
          PORT: String(PORT),
          NODE_ENV,
        },
        stdio: 'inherit',
      })

      server.on('error', (err) => {
        console.error('Failed to start server:', err)
        process.exit(1)
      })

      process.on('SIGINT', () => {
        server.kill()
        process.exit(0)
      })

      process.on('SIGTERM', () => {
        server.kill()
        process.exit(0)
      })

      break
    }

    case 'version':
      console.log(VERSION)
      break

    default:
      console.log('Unknown command:', command)
      console.log('Available commands: start, version')
      process.exit(1)
  }
}

async function checkAndUpdate(): Promise<void> {
  try {
    // Get latest release info
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!response.ok) return

    const data = await response.json()
    const latestVersion = data.tag_name.replace(/^v/, '')

    if (latestVersion === VERSION) {
      return
    }

    console.log(`\nUpdate available: ${VERSION} → ${latestVersion}`)
    console.log('Downloading in background...\n')

    // Detect platform
    const os = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null

    if (!arch) return

    const packageName = `git-hud-${os}-${arch}.tar.gz`
    const asset = data.assets.find((a: any) => a.name === packageName)

    if (!asset) return

    // Download tarball
    const downloadResponse = await fetch(asset.browser_download_url)
    if (!downloadResponse.ok) return

    const arrayBuffer = await downloadResponse.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Get install directory
    const binaryPath = process.execPath
    const appDir = dirname(binaryPath)
    const installDir = dirname(appDir)
    const tempDir = join(installDir, 'tmp')

    // Create temp directory
    await mkdir(tempDir, { recursive: true })

    // Write tarball
    const tarballPath = join(tempDir, packageName)
    await Bun.write(tarballPath, buffer)

    // Extract
    const extractProc = Bun.spawn(['tar', '-xzf', packageName], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    await extractProc.exited

    // Backup current version
    const backupDir = join(installDir, 'app.backup')
    if (existsSync(backupDir)) {
      await rm(backupDir, { recursive: true })
    }
    await rename(appDir, backupDir)

    // Move new version
    const extractedDir = join(tempDir, `git-hud-${os}-${arch}`)
    await rename(extractedDir, appDir)

    // Cleanup
    await rm(tempDir, { recursive: true })

    console.log(`\n✓ Updated to ${latestVersion}! Restart to use new version.\n`)
  } catch (err) {
    // Silently fail - don't interrupt startup
  }
}

main()
