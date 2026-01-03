import { spawn } from "child_process";

export async function POST(request: Request) {
  const { path, app } = await request.json();

  if (!path || !app) {
    return Response.json({ error: "path and app are required" }, { status: 400 });
  }

  try {
    if (app === "vscode") {
      // VSCode reuses window if directory already open, opens new otherwise
      const child = spawn("code", [path], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else if (app === "terminal") {
      // macOS: open Terminal.app at path
      const child = spawn("open", ["-a", "Terminal", path], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else {
      return Response.json({ error: "Invalid app" }, { status: 400 });
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to open" },
      { status: 500 }
    );
  }
}
