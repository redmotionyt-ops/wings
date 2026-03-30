const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.DAEMON_PORT || 8443);
const NODE_ID = process.env.NODE_ID || "node-mumbai-01";
const DAEMON_SHARED_API_KEY =
  process.env.FLUX_WINGS_SHARED_API_KEY ||
  "astranodes_1122334455";
const PANEL_FULL_ACCESS_API_KEY =
  process.env.FLUX_PANEL_FULL_ACCESS_API_KEY ||
  "astramesh_1234567890";
const DAEMON_BIND_HOST = process.env.DAEMON_BIND_HOST || "127.0.0.1";
const DAEMON_PUBLIC_HOST = process.env.DAEMON_PUBLIC_HOST || "in-01.fluxplus.in";
const DAEMON_PUBLIC_PROTOCOL = process.env.DAEMON_PUBLIC_PROTOCOL || "https";

const ROOT_DIR = __dirname;
const SERVERS_DIR = path.join(ROOT_DIR, "servers");
const STATE_FILE = path.join(ROOT_DIR, "daemon-state.json");
const LOGS_DIR = path.join(ROOT_DIR, "daemon-logs");

app.set("trust proxy", 1);
app.use(express.json());
ensureStorage();

const runtimeProcesses = new Map();

app.use((req, res, next) => {
  const authHeader = String(req.headers.authorization || "");
  const panelKey = String(req.headers["x-panel-key"] || "");

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Missing daemon bearer token." });
  }

  const token = authHeader.slice(7).trim();
  if (token !== DAEMON_SHARED_API_KEY) {
    return res.status(403).json({ success: false, message: "Invalid daemon API token." });
  }

  if (panelKey && panelKey !== PANEL_FULL_ACCESS_API_KEY) {
    return res.status(403).json({ success: false, message: "Invalid panel access key." });
  }

  next();
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    nodeId: NODE_ID,
    status: "online",
    timestamp: new Date().toISOString()
  });
});

app.post("/wings/create-server", async (req, res) => {
  try {
    const {
      serverId,
      serverName,
      software,
      version,
      buildNumber,
      ramMb,
      cpuPercent,
      diskMb,
      startupCommand
    } = req.body || {};

    if (!serverId || !serverName || !software || !version) {
      return res.status(400).json({
        success: false,
        message: "Missing required server installation fields."
      });
    }

    if (String(software).toLowerCase() !== "paper") {
      return res.status(400).json({
        success: false,
        message: "This daemon currently auto-installs Paper only."
      });
    }

    const folderName = safeFolderName(serverName || serverId);
    const serverDir = path.join(SERVERS_DIR, folderName);
    const jarPath = path.join(serverDir, "server.jar");

    if (/[+!]/.test(serverDir)) {
      return res.status(400).json({
        success: false,
        message: "Cannot run server in a directory with ! or + in the pathname. Move the project to a cleaner path first."
      });
    }

    fs.mkdirSync(serverDir, { recursive: true });

    const downloadMeta = await downloadPaperJar({
      version: String(version),
      buildNumber: buildNumber || null,
      outputPath: jarPath
    });

    fs.writeFileSync(path.join(serverDir, "eula.txt"), "eula=true\n", "utf8");
    fs.writeFileSync(
      path.join(serverDir, "flux-server.json"),
      JSON.stringify(
        {
          serverId,
          serverName,
          software,
          version,
          buildNumber: downloadMeta.build,
          ramMb: Number(ramMb || 4096),
          cpuPercent: Number(cpuPercent || 100),
          diskMb: Number(diskMb || 10240),
          startupCommand: String(startupCommand || `java -Xms256M -Xmx${Number(ramMb || 4096)}M -jar server.jar nogui`),
          folderName,
          createdAt: new Date().toISOString()
        },
        null,
        2
      ),
      "utf8"
    );

    const state = readState();
    state[serverId] = {
      serverId,
      serverName,
      software,
      version,
      buildNumber: downloadMeta.build,
      folderName,
      serverDir,
      jarPath,
      ramMb: Number(ramMb || 4096),
      cpuPercent: Number(cpuPercent || 100),
      diskMb: Number(diskMb || 10240),
      startupCommand: String(startupCommand || `java -Xms256M -Xmx${Number(ramMb || 4096)}M -jar server.jar nogui`),
      status: "Installed",
      installedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      pendingAction: null
    };

    writeState(state);
    appendLog(serverId, `[WINGS] Server installed into ${folderName}`);
    appendLog(serverId, `[WINGS] Paper ${version} build ${downloadMeta.build} downloaded successfully`);

    return res.json({
      success: true,
      message: "Server installed successfully.",
      status: "Installed",
      folderName,
      jarPath,
      download: downloadMeta
    });
  } catch (error) {
    console.error("Create server error:", error);
    return res.status(500).json({ success: false, message: error.message || "Wings failed to install the server." });
  }
});

app.post("/wings/start-server", async (req, res) => {
  try {
    const { serverId, startupCommand } = req.body || {};
    const result = await startServerInternal(serverId, startupCommand, true);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error("Start server error:", error);
    return res.status(500).json({ success: false, message: "Wings failed to start the server." });
  }
});

app.post("/wings/stop-server/:serverId", (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    if (!serverId) {
      return res.status(400).json({ success: false, message: "serverId is required." });
    }

    const state = readState();
    const serverState = state[serverId];
    if (!serverState) {
      return res.status(404).json({ success: false, message: "Server not found on this node." });
    }

    serverState.pendingAction = "stop";
    serverState.status = "Stopping";
    serverState.lastUpdatedAt = new Date().toISOString();
    state[serverId] = serverState;
    writeState(state);

    const child = runtimeProcesses.get(serverId);
    if (!child) {
      clearServerLog(serverId);
      serverState.status = "Stopped";
      serverState.pendingAction = null;
      serverState.lastUpdatedAt = new Date().toISOString();
      state[serverId] = serverState;
      writeState(state);
      return res.json({ success: true, message: "Server was not running.", status: "Stopped" });
    }

    child.stdin.write("stop\n");
    appendLog(serverId, "[WINGS] Stop command sent to stdin");
    return res.json({ success: true, message: "Stop command sent.", status: "Stopping" });
  } catch (error) {
    console.error("Stop server error:", error);
    return res.status(500).json({ success: false, message: "Wings failed to stop the server." });
  }
});

app.post("/wings/restart-server/:serverId", async (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    if (!serverId) {
      return res.status(400).json({ success: false, message: "serverId is required." });
    }

    const state = readState();
    const serverState = state[serverId];
    if (!serverState) {
      return res.status(404).json({ success: false, message: "Server not found on this node." });
    }

    const child = runtimeProcesses.get(serverId);
    if (child) {
      serverState.pendingAction = "restart";
      serverState.status = "Restarting";
      serverState.lastUpdatedAt = new Date().toISOString();
      state[serverId] = serverState;
      writeState(state);
      child.stdin.write("stop\n");
      await waitForProcessExit(serverId, 15000);
    }

    const result = await startServerInternal(serverId, String(req.body?.startupCommand || "").trim(), true);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error("Restart server error:", error);
    return res.status(500).json({ success: false, message: "Wings failed to restart the server." });
  }
});

app.post("/wings/delete-server/:serverId", (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    if (!serverId) {
      return res.status(400).json({ success: false, message: "serverId is required." });
    }

    const child = runtimeProcesses.get(serverId);
    if (child) {
      child.kill("SIGTERM");
      runtimeProcesses.delete(serverId);
    }

    const state = readState();
    const serverState = state[serverId];
    if (serverState?.serverDir && fs.existsSync(serverState.serverDir)) {
      fs.rmSync(serverState.serverDir, { recursive: true, force: true });
    }

    delete state[serverId];
    writeState(state);

    const logFile = serverLogFile(serverId);
    if (fs.existsSync(logFile)) {
      fs.rmSync(logFile, { force: true });
    }

    return res.json({ success: true, message: "Server deleted successfully." });
  } catch (error) {
    console.error("Delete server error:", error);
    return res.status(500).json({ success: false, message: "Wings failed to delete the server." });
  }
});

app.get("/wings/status/:serverId", (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    const state = readState();
    const serverState = state[serverId];

    if (!serverState) {
      return res.status(404).json({ success: false, message: "Server not found on this node." });
    }

    return res.json({
      success: true,
      status: serverState.status || "Unknown",
      server: serverState
    });
  } catch (error) {
    console.error("Status error:", error);
    return res.status(500).json({ success: false, message: "Wings failed to read server status." });
  }
});

app.get("/wings/logs/:serverId", (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    const lines = Math.max(10, Math.min(Number(req.query.lines || 100), 500));
    const logFile = serverLogFile(serverId);

    if (!fs.existsSync(logFile)) {
      return res.json({ success: true, logs: [] });
    }

    const raw = fs.readFileSync(logFile, "utf8");
    const allLines = raw.split(/\r?\n/).filter(Boolean);
    const sliced = allLines.slice(-lines);

    return res.json({ success: true, logs: sliced });
  } catch (error) {
    console.error("Logs error:", error);
    return res.status(500).json({ success: false, message: "Wings failed to read logs." });
  }
});

app.post("/wings/command/:serverId", (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    const command = String(req.body.command || "").trim();

    if (!serverId || !command) {
      return res.status(400).json({ success: false, message: "serverId and command are required." });
    }

    const child = runtimeProcesses.get(serverId);
    if (!child) {
      return res.status(409).json({ success: false, message: "Server is not running." });
    }

    child.stdin.write(`${command}\n`);
    appendLog(serverId, `[PANEL CMD] ${command}`);
    return res.json({ success: true, message: "Command sent successfully." });
  } catch (error) {
    console.error("Command error:", error);
    return res.status(500).json({ success: false, message: "Wings failed to send command." });
  }
});


app.get("/wings/files/:serverId", (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    const requestPath = String(req.query.path || "/");
    const state = readState();
    const serverState = state[serverId];

    if (!serverState) {
      return res.status(404).json({ success: false, message: "Server not found on this node." });
    }

    const resolved = resolveServerFsPath(serverState, requestPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(404).json({ success: false, message: "Folder not found." });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .map((entry) => {
        const rel = path.relative(serverState.serverDir, path.join(resolved, entry.name));
        const webPath = "/" + rel.split(path.sep).join("/");
        return {
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          path: webPath
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return res.json({
      success: true,
      path: requestPath,
      displayPath: buildDisplayPath(serverState, requestPath),
      entries
    });
  } catch (error) {
    console.error("Files list error:", error);
    return res.status(500).json({ success: false, message: "Failed to list files." });
  }
});

app.get("/wings/file/:serverId", (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    const requestPath = String(req.query.path || "");
    const state = readState();
    const serverState = state[serverId];

    if (!serverState) {
      return res.status(404).json({ success: false, message: "Server not found on this node." });
    }

    const resolved = resolveServerFsPath(serverState, requestPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    const content = fs.readFileSync(resolved, "utf8");
    return res.json({ success: true, path: requestPath, content });
  } catch (error) {
    console.error("File read error:", error);
    return res.status(500).json({ success: false, message: "Failed to read file." });
  }
});

app.put("/wings/file/:serverId", (req, res) => {
  try {
    const serverId = String(req.params.serverId || "").trim();
    const requestPath = String(req.query.path || "");
    const content = String(req.body?.content ?? "");
    const state = readState();
    const serverState = state[serverId];

    if (!serverState) {
      return res.status(404).json({ success: false, message: "Server not found on this node." });
    }

    const resolved = resolveServerFsPath(serverState, requestPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    fs.writeFileSync(resolved, content, "utf8");
    return res.json({ success: true, message: "File written successfully." });
  } catch (error) {
    console.error("File write error:", error);
    return res.status(500).json({ success: false, message: "Failed to write file." });
  }
});

async function downloadPaperJar({ version, buildNumber, outputPath }) {
  const userAgent = process.env.FLUX_PAPER_USER_AGENT || "FluxPlusCore/1.0.0 (https://core.fluxplus.in)";
  const buildsUrl = `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`;

  const buildsResponse = await fetch(buildsUrl, {
    headers: { "User-Agent": userAgent }
  });

  if (!buildsResponse.ok) {
    throw new Error(`Paper builds request failed: ${buildsResponse.status}`);
  }

  const builds = await buildsResponse.json();
  if (!Array.isArray(builds) || !builds.length) {
    throw new Error("No Paper builds returned for requested version.");
  }

  let selectedBuild = null;
  if (buildNumber !== null && buildNumber !== undefined && buildNumber !== "") {
    selectedBuild = builds.find((item) => String(item.id) === String(buildNumber));
  }
  if (!selectedBuild) {
    selectedBuild = builds.find((item) => String(item.channel || "").toUpperCase() === "STABLE") || builds[0];
  }

  const downloadUrl = selectedBuild?.downloads?.["server:default"]?.url;
  if (!downloadUrl) {
    throw new Error("Paper build did not include a server:default download URL.");
  }

  const jarResponse = await fetch(downloadUrl, {
    headers: { "User-Agent": userAgent }
  });

  if (!jarResponse.ok) {
    throw new Error(`Paper jar download failed: ${jarResponse.status}`);
  }

  const buffer = Buffer.from(await jarResponse.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  return {
    build: selectedBuild.id,
    channel: selectedBuild.channel,
    url: downloadUrl
  };
}

function ensureStorage() {
  fs.mkdirSync(SERVERS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, "{}", "utf8");
  }
}

function readState() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.error("Failed to read daemon state:", error);
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function serverLogFile(serverId) {
  return path.join(LOGS_DIR, `${serverId}.log`);
}

function appendLog(serverId, text) {
  const line = `[${new Date().toISOString()}] ${String(text).trimEnd()}\n`;
  fs.appendFileSync(serverLogFile(serverId), line, "utf8");
}

function safeFolderName(name) {
  return String(name || "server")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function startServerInternal(serverId, startupCommand = "", clearLogsFirst = true) {
  const safeServerId = String(serverId || "").trim();
  if (!safeServerId) {
    return { success: false, message: "serverId is required." };
  }

  const state = readState();
  const serverState = state[safeServerId];
  if (!serverState) {
    return { success: false, message: "Server is not installed on this node." };
  }

  if (runtimeProcesses.has(safeServerId)) {
    return { success: true, message: "Server is already running.", status: "Running" };
  }

  if (!fs.existsSync(serverState.jarPath)) {
    return { success: false, message: "server.jar does not exist." };
  }

  if (clearLogsFirst) {
    clearServerLog(safeServerId);
  }

  const xmxValue = Math.max(1024, Number(serverState.ramMb || 4096));
  const effectiveStartupCommand = String(startupCommand || serverState.startupCommand || `java -Xms256M -Xmx${xmxValue}M -jar server.jar nogui`).trim();

  const child = spawn(effectiveStartupCommand, {
    cwd: serverState.serverDir,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  runtimeProcesses.set(safeServerId, child);
  serverState.status = "Running";
  serverState.pendingAction = null;
  serverState.startedAt = new Date().toISOString();
  serverState.lastUpdatedAt = new Date().toISOString();
  serverState.startupCommand = effectiveStartupCommand;
  state[safeServerId] = serverState;
  writeState(state);

  appendLog(safeServerId, `[WINGS] Start signal issued: ${effectiveStartupCommand}`);

  child.stdout.on("data", (chunk) => appendLog(safeServerId, chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog(safeServerId, `[STDERR] ${chunk.toString()}`));
  child.on("close", (code) => {
    runtimeProcesses.delete(safeServerId);
    const latestState = readState();
    const current = latestState[safeServerId];
    if (!current) return;

    const pending = String(current.pendingAction || "").toLowerCase();
    if (pending === "stop" || pending === "kill") {
      clearServerLog(safeServerId);
      current.status = "Stopped";
    } else if (pending === "restart") {
      current.status = "Restarting";
    } else {
      current.status = code === 0 ? "Stopped" : "Crashed";
    }

    current.pendingAction = null;
    current.exitCode = code;
    current.lastUpdatedAt = new Date().toISOString();
    latestState[safeServerId] = current;
    writeState(latestState);

    if (pending !== "stop" && pending !== "kill") {
      appendLog(safeServerId, `[WINGS] Process exited with code ${code}`);
    }
  });

  return { success: true, message: "Start signal sent successfully.", status: "Running" };
}

async function waitForProcessExit(serverId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!runtimeProcesses.has(serverId)) return true;
    await sleep(300);
  }
  return false;
}

function clearServerLog(serverId) {
  const logFile = serverLogFile(serverId);
  if (fs.existsSync(logFile)) {
    fs.rmSync(logFile, { force: true });
  }
}

function resolveServerFsPath(serverState, requestPath = "/") {
  const safeParts = String(requestPath || "/").split("/").filter(Boolean);
  const resolved = path.resolve(serverState.serverDir, ...safeParts);
  const serverRoot = path.resolve(serverState.serverDir);
  if (!resolved.startsWith(serverRoot)) {
    throw new Error("Path escaped server root.");
  }
  return resolved;
}

function buildDisplayPath(serverState, requestPath = "/") {
  const normalized = String(requestPath || "/").replace(/\\/g, "/");
  const suffix = normalized === "/" ? "" : normalized;
  const folder = serverState.folderName || serverState.serverName || serverState.serverId;
  return `/daemon/servers/${folder}${suffix}`;
}

app.listen(PORT, DAEMON_BIND_HOST, () => {
  console.log(`Flux daemon ${NODE_ID} listening on ${DAEMON_BIND_HOST}:${PORT}`);
  console.log(`Public node URL: ${DAEMON_PUBLIC_PROTOCOL}://${DAEMON_PUBLIC_HOST}`);
});
