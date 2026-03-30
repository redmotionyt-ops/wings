const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const cors = require("cors");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const FRONTEND_ROOT = path.join(__dirname, "frontend");
const LOGIN_UI_PATH = path.join(FRONTEND_ROOT, "Login UI");
const MAIN_UI_PATH = path.join(FRONTEND_ROOT, "Main UI");
const MAIN_PANEL_PATH = path.join(FRONTEND_ROOT, "Main Panel");
const USERS_FILE = path.join(__dirname, "users.json");
const NODES_FILE = path.join(__dirname, "nodes.json");

const DEFAULT_PLAN = "Beta User";
const USD_INR_RATE = 93.8;
const SESSION_SECRET = process.env.FLUX_SESSION_SECRET || "fluxplus_super_secret_session_key";
const FLUX_PANEL_FULL_ACCESS_API_KEY =
  process.env.FLUX_PANEL_FULL_ACCESS_API_KEY ||
  "astramesh_1234567890";
const FLUX_WINGS_SHARED_API_KEY =
  process.env.FLUX_WINGS_SHARED_API_KEY ||
  "astranodes_1122334455";
const PANEL_BIND_HOST = process.env.PANEL_BIND_HOST || "127.0.0.1";
const PANEL_PUBLIC_URL = process.env.PANEL_PUBLIC_URL || "https://core.fluxplus.in";
const PANEL_PUBLIC_ORIGIN = process.env.PANEL_PUBLIC_ORIGIN || PANEL_PUBLIC_URL;
const PANEL_SECURE_COOKIE = String(process.env.PANEL_SECURE_COOKIE || "true").toLowerCase() === "true";

const MODRINTH_API_BASE = "https://api.modrinth.com/v2";
const CURSEFORGE_API_BASE = "https://api.curseforge.com/v1";
const CURSEFORGE_API_KEY = process.env.CURSEFORGE_API_KEY || "";
const CURSEFORGE_MINECRAFT_GAME_ID = Number(process.env.CURSEFORGE_MINECRAFT_GAME_ID || 432);

const REGION_OPTIONS = {
  India: {
    nodeId: "node-mumbai-01",
    name: "India",
    location: "Mumbai",
    flag: "IN",
    pingRange: [18, 42],
    publicLabel: "India • Mumbai"
  },
  USA: {
    nodeId: "node-losangeles-01",
    name: "USA",
    location: "Los Angeles",
    flag: "US",
    pingRange: [118, 164],
    publicLabel: "USA • Los Angeles"
  },
  Japan: {
    nodeId: "node-tokyo-01",
    name: "Japan",
    location: "Tokyo",
    flag: "JP",
    pingRange: [52, 88],
    publicLabel: "Japan • Tokyo"
  }
};

const SOFTWARE_OPTIONS = {
  BungeeCord: { key: "BungeeCord", short: "BC", description: "Proxy layer for linking multiple Minecraft servers." },
  Spigot: { key: "Spigot", short: "SP", description: "Classic optimized plugin server." },
  Paper: { key: "Paper", short: "PP", description: "High-performance plugin server with strong compatibility." },
  Velocity: { key: "Velocity", short: "VE", description: "Modern high-performance proxy network software." },
  Vanilla: { key: "Vanilla", short: "VN", description: "Pure default Minecraft server runtime." },
  Forge: { key: "Forge", short: "FG", description: "Forge-based modded server platform." },
  Fabric: { key: "Fabric", short: "FB", description: "Lightweight modern mod loader for modded servers." }
};

app.set("trust proxy", 1);
app.use(cors({ origin: PANEL_PUBLIC_ORIGIN, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: PANEL_SECURE_COOKIE,
    sameSite: "lax",
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

ensureUsersFile();
ensureNodesFile();

app.use(express.static(LOGIN_UI_PATH));
app.use("/dashboard-assets", express.static(MAIN_UI_PATH));
app.use("/panel-assets", express.static(MAIN_PANEL_PATH));
app.use("/Login UI", express.static(LOGIN_UI_PATH));
app.use("/Main UI", express.static(MAIN_UI_PATH));
app.use("/Main Panel", express.static(MAIN_PANEL_PATH));
app.use("/frontend", express.static(FRONTEND_ROOT));

app.get("/", (req, res) => {
  res.sendFile(path.join(LOGIN_UI_PATH, "index.html"));
});

app.get("/dashboard", requireAuthPage, (req, res) => {
  res.sendFile(path.join(MAIN_UI_PATH, "dashboard.html"));
});

app.get("/panel", requireAuthPage, (req, res) => {
  res.sendFile(path.join(MAIN_PANEL_PATH, "panel.html"));
});

/* =========================
   AUTH API
========================= */

app.post("/api/auth/register", (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: "All fields are required." });
    }

    if (!isAllowedEmail(email)) {
      return res.status(400).json({ success: false, message: "Email must end with @fluxplus.in or @gmail.com." });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters long." });
    }

    const users = readUsers();
    const deviceIp = getClientIp(req);
    const normalizedUsername = String(username).trim();
    const normalizedEmail = String(email).trim().toLowerCase();

    if (users.some((user) => String(user.Username).toLowerCase() === normalizedUsername.toLowerCase())) {
      return res.status(409).json({ success: false, message: "Username already exists." });
    }

    if (users.some((user) => String(user.Email).toLowerCase() === normalizedEmail)) {
      return res.status(409).json({ success: false, message: "Email already exists." });
    }

    if (users.some((user) => String(user["Device Ip address"]) === String(deviceIp))) {
      return res.status(409).json({
        success: false,
        message: "Unable to register. This device or network is already linked to another account."
      });
    }

    const newUser = fillMissingUserFields({
      "User ID": generateUserId(),
      Username: normalizedUsername,
      Email: normalizedEmail,
      Password: hashPassword(password),
      Plan: DEFAULT_PLAN,
      "Allocated region": "India",
      Admin: false,
      "Tickets Count": 0,
      "Device Ip address": deviceIp,
      "Assigned servers": [],
      Utilization: getDefaultUtilization(),
      Network: {
        "Ping Ms": getRandomPingForRegion("India"),
        "Last Sync": nowIso()
      },
      "Account Status": "active",
      "Email Verified": false,
      "Created At": nowIso(),
      "Updated At": nowIso(),
      "Last Login At": nowIso(),
      "Login Count": 1,
      Preferences: {
        Theme: "core-edge",
        Notifications: true
      },
      "Service Access": {
        Panel: true,
        Docs: true,
        "Status Page": true,
        "Main Website": true,
        Discord: true
      },
      Notes: ""
    });

    users.push(newUser);
    writeUsers(users);
    req.session.user = buildSessionUser(newUser);

    return res.status(201).json({
      success: true,
      message: "Registration successful.",
      user: req.session.user
    });
  } catch (error) {
    console.error("Register error:", error);
    return res.status(500).json({ success: false, message: "Server error during registration." });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { identifier, password, rememberMe } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: "Identifier and password are required." });
    }

    const users = readUsers();
    const input = String(identifier).trim().toLowerCase();
    const deviceIp = getClientIp(req);

    const foundUser = users.find((user) =>
      String(user.Username).toLowerCase() === input ||
      String(user.Email).toLowerCase() === input
    );

    if (!foundUser) {
      return res.status(401).json({ success: false, message: "Invalid username/email or password." });
    }

    const ipOwner = users.find((user) => String(user["Device Ip address"]) === String(deviceIp));
    if (ipOwner && String(ipOwner.Email).toLowerCase() !== String(foundUser.Email).toLowerCase()) {
      return res.status(403).json({
        success: false,
        message: "This device or network is already linked to another account."
      });
    }

    if (foundUser.Password !== hashPassword(password)) {
      return res.status(401).json({ success: false, message: "Invalid username/email or password." });
    }

    if (rememberMe) {
      req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
    }

    foundUser["Device Ip address"] = deviceIp;
    foundUser["Updated At"] = nowIso();
    foundUser["Last Login At"] = nowIso();
    foundUser["Login Count"] = toNonNegativeInt(foundUser["Login Count"], 0) + 1;
    foundUser.Network = {
      ...(foundUser.Network || {}),
      "Ping Ms": clampNumber(Number(foundUser.Network?.["Ping Ms"] || getRandomPingForRegion(foundUser["Allocated region"] || "India")), 10, 198),
      "Last Sync": nowIso()
    };

    writeUsers(users);
    req.session.user = buildSessionUser(foundUser);

    return res.json({ success: true, message: "Login successful.", user: req.session.user });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ success: false, message: "Server error during login." });
  }
});

app.get("/api/auth/session", (req, res) => {
  try {
    if (!req.session.user?.email) {
      return res.status(401).json({ success: false, message: "No active session." });
    }

    const users = readUsers();
    const freshUser = users.find(
      (user) => String(user.Email).toLowerCase() === String(req.session.user.email).toLowerCase()
    );

    if (!freshUser) {
      req.session.destroy(() => {});
      return res.status(401).json({ success: false, message: "No active session." });
    }

    req.session.user = buildSessionUser(freshUser);
    return res.json({ success: true, user: req.session.user });
  } catch (error) {
    console.error("Session error:", error);
    return res.status(500).json({ success: false, message: "Server error while checking session." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true, message: "Logged out successfully." });
  });
});

/* =========================
   NODES API
========================= */

app.get("/api/nodes/public", requireAuthApi, (req, res) => {
  try {
    const nodes = readNodes().map((node) => ({
      nodeId: node["Node ID"],
      name: node.Name,
      region: node.Region,
      location: node.Location,
      flag: node.Flag,
      host: node.Host,
      protocol: node.Protocol,
      sslEnabled: Boolean(node["SSL Enabled"]),
      pingMs: node["Ping Ms"],
      status: node.Status
    }));

    return res.json({ success: true, nodes });
  } catch (error) {
    console.error("Nodes public error:", error);
    return res.status(500).json({ success: false, message: "Unable to load node data." });
  }
});

/* =========================
   SERVER DEPLOY / DELETE
========================= */

app.post("/api/servers/deploy", requireAuthApi, async (req, res) => {
  try {
    const {
      serverName,
      region,
      software,
      version,
      ramGb,
      cpuPercent,
      diskGb,
      databases,
      allocations,
      backups,
      notes
    } = req.body;

    if (!serverName || !region || !software || !version) {
      return res.status(400).json({ success: false, message: "Missing required deployment fields." });
    }

    if (!REGION_OPTIONS[region]) {
      return res.status(400).json({ success: false, message: "Invalid region." });
    }

    if (!SOFTWARE_OPTIONS[software]) {
      return res.status(400).json({ success: false, message: "Invalid software." });
    }

    const users = readUsers();
    const user = findUserBySessionEmail(users, req.session.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (getRealAssignedServers(user).length >= 1) {
      return res.status(409).json({ success: false, message: "Only one server is allowed for this account right now." });
    }

    const parsedRam = clampNumber(Number(ramGb), 1, 12);
    const parsedCpu = clampNumber(Number(cpuPercent), 100, 300);
    const parsedDisk = clampNumber(Number(diskGb), 10, 35);
    const parsedDatabases = clampNumber(Number(databases), 0, 20);
    const parsedAllocations = clampNumber(Number(allocations), 1, 20);

    const planLimits = getPlanLimits(user.Plan);
    if (
      parsedRam > planLimits.ramGb ||
      parsedCpu > planLimits.cpuPercent ||
      parsedDisk > planLimits.diskGb
    ) {
      return res.status(403).json({
        success: false,
        message: `${user.Plan} allows up to ${planLimits.ramGb} GB RAM, ${planLimits.cpuPercent}% CPU, and ${planLimits.diskGb} GB disk on the current tier.`
      });
    }

    const nodes = readNodes();
    const regionMeta = REGION_OPTIONS[region];
    const selectedNode =
      nodes.find((node) => node["Node ID"] === regionMeta.nodeId) ||
      nodes.find((node) => String(node.Region).toLowerCase() === String(regionMeta.name).toLowerCase());

    if (!selectedNode) {
      return res.status(503).json({ success: false, message: "No node is available for the selected region." });
    }

    const pricing = calculateServerPrice({ ramGb: parsedRam, cpuPercent: parsedCpu, diskGb: parsedDisk });
    const serverId = generateServerId();
    const pingMs = clampNumber(Number(selectedNode["Ping Ms"] || getRandomPingForRegion(region)), 10, 198);

    const newServer = normalizeAssignedServer({
      "Server ID": serverId,
      "Server Name": String(serverName).trim(),
      Region: regionMeta.name,
      Location: regionMeta.location,
      Flag: regionMeta.flag,
      "Node ID": selectedNode["Node ID"],
      "Node Name": selectedNode.Name,
      "Server Software": software,
      Version: String(version).trim(),
      Status: "Deploying",
      Backups: backups ? "Enabled" : "Disabled",
      Notes: String(notes || "").trim(),
      "Server Ram": `${parsedRam} GB`,
      Cpu: `${parsedCpu}%`,
      Disk: `${parsedDisk} GB NVMe`,
      "Database limit": String(parsedDatabases),
      Allocations: String(parsedAllocations),
      "Database limit & Allocations(Should be same digits)": String(Math.max(parsedDatabases, parsedAllocations)),
      Pricing: pricing,
      "Created At": nowIso()
    });

    user["Assigned servers"] = [newServer];
    user["Allocated region"] = regionMeta.name;
    user["Updated At"] = nowIso();
    user.Network = {
      "Ping Ms": pingMs,
      "Last Sync": nowIso()
    };
    user.Utilization = calculateUtilizationFromServer(newServer);
    writeUsers(users);

    const installResult = await installAndStartServerOnNode(user, newServer, selectedNode);

    if (!installResult.success) {
      setServerStatus(user, serverId, installResult.status || "Install Failed");
      user["Updated At"] = nowIso();
      writeUsers(users);
      req.session.user = buildSessionUser(user);

      return res.status(502).json({
        success: false,
        message: installResult.message || "Server deployment failed while talking to Wings.",
        user: req.session.user,
        server: findServerById(user, serverId),
        daemon: installResult
      });
    }

    req.session.user = buildSessionUser(user);
    return res.json({
      success: true,
      message: "Server deployed successfully.",
      user: req.session.user,
      server: findServerById(user, serverId),
      daemon: installResult
    });
  } catch (error) {
    console.error("Deploy server error:", error);
    return res.status(500).json({ success: false, message: "Failed to deploy server." });
  }
});

app.post("/api/servers/delete", requireAuthApi, async (req, res) => {
  try {
    const users = readUsers();
    const user = findUserBySessionEmail(users, req.session.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const primaryServer = getRealAssignedServers(user)[0];

    if (primaryServer) {
      const node = resolveNodeForServer(primaryServer);
      if (node) {
        await fluxNodeFetch(node, `/wings/delete-server/${encodeURIComponent(primaryServer["Server ID"])}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ panelApiKey: FLUX_PANEL_FULL_ACCESS_API_KEY })
        }).catch(() => null);
      }
    }

    user["Assigned servers"] = [];
    user.Utilization = getDefaultUtilization();
    user["Updated At"] = nowIso();
    user.Network = {
      "Ping Ms": getRandomPingForRegion(user["Allocated region"] || "India"),
      "Last Sync": nowIso()
    };

    writeUsers(users);
    req.session.user = buildSessionUser(user);

    return res.json({
      success: true,
      message: "Server deleted successfully.",
      user: req.session.user
    });
  } catch (error) {
    console.error("Delete server error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete server." });
  }
});

/* =========================
   PANEL <-> WINGS API
========================= */

app.post("/api/panel/server/:serverId/install-and-start", requireAuthApi, async (req, res) => {
  try {
    const users = readUsers();
    const user = findUserBySessionEmail(users, req.session.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const serverId = String(req.params.serverId || "").trim();
    const server = findServerById(user, serverId);
    if (!server) {
      return res.status(404).json({ success: false, message: "Server not found for this account." });
    }

    const node = resolveNodeForServer(server);
    if (!node) {
      return res.status(503).json({ success: false, message: "No matching node found for this server region." });
    }

    const result = await installAndStartServerOnNode(user, server, node);
    req.session.user = buildSessionUser(user);

    return res.status(result.success ? 200 : 502).json({
      success: result.success,
      message: result.message,
      user: req.session.user,
      server: findServerById(user, serverId),
      daemon: result
    });
  } catch (error) {
    console.error("Install and start error:", error);
    return res.status(500).json({ success: false, message: "Panel failed to communicate with Wings." });
  }
});

app.get("/api/panel/server/:serverId/status", requireAuthApi, async (req, res) => {
  try {
    const users = readUsers();
    const user = findUserBySessionEmail(users, req.session.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const serverId = String(req.params.serverId || "").trim();
    const server = findServerById(user, serverId);
    if (!server) {
      return res.status(404).json({ success: false, message: "Server not found for this account." });
    }

    const node = resolveNodeForServer(server);
    if (!node) {
      return res.status(503).json({ success: false, message: "Node not found." });
    }

    const statusResponse = await fluxNodeFetch(node, `/wings/status/${encodeURIComponent(serverId)}`, { method: "GET" });

    if (statusResponse.success && statusResponse.status) {
      setServerStatus(user, serverId, statusResponse.status);
      user["Updated At"] = nowIso();
      writeUsers(users);
      req.session.user = buildSessionUser(user);
    }

    return res.json({
      success: true,
      server: findServerById(user, serverId),
      node: { id: node["Node ID"], name: node.Name },
      daemon: statusResponse
    });
  } catch (error) {
    console.error("Status proxy error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch server status from Wings." });
  }
});

app.get("/api/panel/server/:serverId/logs", requireAuthApi, async (req, res) => {
  try {
    const users = readUsers();
    const user = findUserBySessionEmail(users, req.session.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const serverId = String(req.params.serverId || "").trim();
    const server = findServerById(user, serverId);
    if (!server) {
      return res.status(404).json({ success: false, message: "Server not found for this account." });
    }

    const node = resolveNodeForServer(server);
    if (!node) {
      return res.status(503).json({ success: false, message: "Node not found." });
    }

    const lines = Math.max(10, Math.min(Number(req.query.lines || 100), 500));
    const logsResponse = await fluxNodeFetch(node, `/wings/logs/${encodeURIComponent(serverId)}?lines=${lines}`, { method: "GET" });
    return res.json(logsResponse);
  } catch (error) {
    console.error("Logs proxy error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch logs from Wings." });
  }
});

app.post("/api/panel/server/:serverId/command", requireAuthApi, async (req, res) => {
  try {
    const command = String(req.body.command || "").trim();
    if (!command) {
      return res.status(400).json({ success: false, message: "Command is required." });
    }

    const users = readUsers();
    const user = findUserBySessionEmail(users, req.session.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const serverId = String(req.params.serverId || "").trim();
    const server = findServerById(user, serverId);
    if (!server) {
      return res.status(404).json({ success: false, message: "Server not found for this account." });
    }

    const node = resolveNodeForServer(server);
    if (!node) {
      return res.status(503).json({ success: false, message: "Node not found." });
    }

    const commandResponse = await fluxNodeFetch(node, `/wings/command/${encodeURIComponent(serverId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, panelApiKey: FLUX_PANEL_FULL_ACCESS_API_KEY })
    });

    return res.json(commandResponse);
  } catch (error) {
    console.error("Command proxy error:", error);
    return res.status(500).json({ success: false, message: "Failed to send command to Wings." });
  }
});

app.post("/api/panel/server/:serverId/stop", requireAuthApi, async (req, res) => {
  try {
    const users = readUsers();
    const user = findUserBySessionEmail(users, req.session.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const serverId = String(req.params.serverId || "").trim();
    const server = findServerById(user, serverId);
    if (!server) {
      return res.status(404).json({ success: false, message: "Server not found for this account." });
    }

    const node = resolveNodeForServer(server);
    if (!node) {
      return res.status(503).json({ success: false, message: "Node not found." });
    }

    const stopResponse = await fluxNodeFetch(node, `/wings/stop-server/${encodeURIComponent(serverId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ panelApiKey: FLUX_PANEL_FULL_ACCESS_API_KEY })
    });

    if (stopResponse.success) {
      setServerStatus(user, serverId, stopResponse.status || "Stopped");
      user["Updated At"] = nowIso();
      writeUsers(users);
      req.session.user = buildSessionUser(user);
    }

    return res.json(stopResponse);
  } catch (error) {
    console.error("Stop proxy error:", error);
    return res.status(500).json({ success: false, message: "Failed to stop server via Wings." });
  }
});

app.post("/api/panel/server/:serverId/restart", requireAuthApi, async (req, res) => {
  try {
    const users = readUsers();
    const user = findUserBySessionEmail(users, req.session.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const serverId = String(req.params.serverId || "").trim();
    const server = findServerById(user, serverId);
    if (!server) {
      return res.status(404).json({ success: false, message: "Server not found for this account." });
    }

    const node = resolveNodeForServer(server);
    if (!node) {
      return res.status(503).json({ success: false, message: "Node not found." });
    }

    const restartResponse = await fluxNodeFetch(node, `/wings/restart-server/${encodeURIComponent(serverId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startupCommand: buildStartupCommand(server),
        panelApiKey: FLUX_PANEL_FULL_ACCESS_API_KEY
      })
    });

    if (restartResponse.success) {
      setServerStatus(user, serverId, restartResponse.status || "Running");
      user["Updated At"] = nowIso();
      writeUsers(users);
      req.session.user = buildSessionUser(user);
    }

    return res.json(restartResponse);
  } catch (error) {
    console.error("Restart proxy error:", error);
    return res.status(500).json({ success: false, message: "Failed to restart server via Wings." });
  }
});


app.get("/api/panel/server/:serverId/files", requireAuthApi, async (req, res) => {
  try {
    const owned = getOwnedServerAndNode(req);
    if (!owned.success) {
      return res.status(owned.status).json({ success: false, message: owned.message });
    }

    const { server, node } = owned;
    const requestPath = String(req.query.path || "/");
    const daemonResponse = await fluxNodeFetch(
      node,
      `/wings/files/${encodeURIComponent(server["Server ID"])}?path=${encodeURIComponent(requestPath)}`,
      { method: "GET" }
    );

    return res.json(daemonResponse);
  } catch (error) {
    console.error("Files proxy error:", error);
    return res.status(500).json({ success: false, message: "Failed to open server folder." });
  }
});

app.get("/api/panel/server/:serverId/file", requireAuthApi, async (req, res) => {
  try {
    const owned = getOwnedServerAndNode(req);
    if (!owned.success) {
      return res.status(owned.status).json({ success: false, message: owned.message });
    }

    const { server, node } = owned;
    const requestPath = String(req.query.path || "").trim();
    if (!requestPath) {
      return res.status(400).json({ success: false, message: "File path is required." });
    }

    const daemonResponse = await fluxNodeFetch(
      node,
      `/wings/file/${encodeURIComponent(server["Server ID"])}?path=${encodeURIComponent(requestPath)}`,
      { method: "GET" }
    );

    return res.json(daemonResponse);
  } catch (error) {
    console.error("File read proxy error:", error);
    return res.status(500).json({ success: false, message: "Failed to read file." });
  }
});

app.put("/api/panel/server/:serverId/file", requireAuthApi, async (req, res) => {
  try {
    const owned = getOwnedServerAndNode(req);
    if (!owned.success) {
      return res.status(owned.status).json({ success: false, message: owned.message });
    }

    const { server, node } = owned;
    const requestPath = String(req.query.path || "").trim();
    const content = String(req.body?.content ?? "");

    if (!requestPath) {
      return res.status(400).json({ success: false, message: "File path is required." });
    }

    const daemonResponse = await fluxNodeFetch(
      node,
      `/wings/file/${encodeURIComponent(server["Server ID"])}?path=${encodeURIComponent(requestPath)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      }
    );

    return res.json(daemonResponse);
  } catch (error) {
    console.error("File write proxy error:", error);
    return res.status(500).json({ success: false, message: "Failed to write file." });
  }
});

app.get("/api/panel/server/:serverId/plugins/search", requireAuthApi, async (req, res) => {
  try {
    const owned = getOwnedServerAndNode(req);
    if (!owned.success) {
      return res.status(owned.status).json({ success: false, message: owned.message });
    }

    const q = String(req.query.q || "").trim();
    const source = String(req.query.source || "all").trim().toLowerCase();
    const loader = String(req.query.loader || "").trim().toLowerCase();
    const gameVersion = String(req.query.gameVersion || "").trim();

    if (!q) {
      return res.status(400).json({ success: false, message: "Search query is required." });
    }

    const results = [];

    if (source === "all" || source === "modrinth") {
      results.push(...await searchModrinthPlugins({ q, loader, gameVersion }));
    }

    if ((source === "all" || source === "curseforge") && CURSEFORGE_API_KEY) {
      results.push(...await searchCurseForgePlugins({ q, gameVersion }));
    }

    return res.json({ success: true, results: results.slice(0, 20) });
  } catch (error) {
    console.error("Plugin search error:", error);
    return res.status(500).json({ success: false, message: "Plugin search failed." });
  }
});

/* =========================
   HELPERS
========================= */

function requireAuthPage(req, res, next) {
  if (!req.session.user?.email) {
    return res.redirect("/");
  }
  next();
}

function requireAuthApi(req, res, next) {
  if (!req.session.user?.email) {
    return res.status(401).json({ success: false, message: "Not authenticated." });
  }
  next();
}

function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, "[]", "utf8");
  }
}

function ensureNodesFile() {
  if (!fs.existsSync(NODES_FILE)) {
    fs.writeFileSync(NODES_FILE, JSON.stringify(getDefaultNodes(), null, 2), "utf8");
  }
}

function readUsers() {
  ensureUsersFile();
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const users = Array.isArray(parsed) ? parsed : [];
    const normalized = users.map(fillMissingUserFields);

    if (JSON.stringify(users) !== JSON.stringify(normalized)) {
      writeUsers(normalized);
    }

    return normalized;
  } catch (error) {
    console.error("Failed to read users.json:", error);
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function readNodes() {
  ensureNodesFile();
  try {
    const raw = fs.readFileSync(NODES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : getDefaultNodes();
  } catch (error) {
    console.error("Failed to read nodes.json:", error);
    return getDefaultNodes();
  }
}

function getDefaultNodes() {
  return [
    {
      "Node ID": "node-mumbai-01",
      Name: "Mumbai Edge 01",
      Region: "India",
      Location: "Mumbai",
      Flag: "IN",
      Host: "in-01.fluxplus.in",
      IP: "",
      Port: 443,
      Protocol: "https",
      "SSL Enabled": true,
      "Daemon Token": FLUX_WINGS_SHARED_API_KEY,
      Status: "online",
      "Max Ram GB": 64,
      "Max Cpu Percent": 1600,
      "Max Disk GB": 1000,
      "Used Ram GB": 0,
      "Used Cpu Percent": 0,
      "Used Disk GB": 0,
      "Ping Ms": 28,
      "Created At": nowIso()
    }
  ];
}

function buildSessionUser(user) {
  return {
    userId: user["User ID"],
    username: user.Username,
    email: user.Email,
    plan: user.Plan,
    allocatedRegion: user["Allocated region"],
    admin: Boolean(user.Admin),
    ticketsCount: toNonNegativeInt(user["Tickets Count"], 0),
    assignedServers: getRealAssignedServers(user),
    utilization: user.Utilization || getDefaultUtilization(),
    network: user.Network || {
      "Ping Ms": getRandomPingForRegion(user["Allocated region"] || "India"),
      "Last Sync": nowIso()
    },
    accountStatus: user["Account Status"] || "active",
    preferences: user.Preferences || { Theme: "core-edge", Notifications: true },
    serviceAccess: user["Service Access"] || {
      Panel: true,
      Docs: true,
      "Status Page": true,
      "Main Website": true,
      Discord: true
    }
  };
}

function fillMissingUserFields(user = {}) {
  const plan = String(user.Plan || DEFAULT_PLAN);
  const region = String(user["Allocated region"] || "India");
  const assignedServers = normalizeAssignedServers(user["Assigned servers"]);
  const utilization = user.Utilization || {};

  return {
    "User ID": user["User ID"] || generateUserId(),
    Username: String(user.Username || "").trim(),
    Email: String(user.Email || "").trim().toLowerCase(),
    Password: String(user.Password || ""),
    Plan: plan,
    "Allocated region": region,
    Admin: toBoolean(user.Admin, false),
    "Tickets Count": toNonNegativeInt(user["Tickets Count"], 0),
    "Device Ip address": String(user["Device Ip address"] || "Unknown"),
    "Assigned servers": assignedServers,
    Utilization: {
      "Cpu Usage": normalizePercent(utilization["Cpu Usage"], "0%"),
      "Ram Usage": normalizePercent(utilization["Ram Usage"], "0%"),
      "IP&DBs Usage": normalizePercent(utilization["IP&DBs Usage"], "0%"),
      "Node Load usage": normalizePercent(utilization["Node Load usage"], "0%")
    },
    Network: {
      "Ping Ms": clampNumber(Number(user.Network?.["Ping Ms"] || getRandomPingForRegion(region)), 10, 198),
      "Last Sync": user.Network?.["Last Sync"] || nowIso()
    },
    "Account Status": String(user["Account Status"] || "active"),
    "Email Verified": toBoolean(user["Email Verified"], false),
    "Created At": user["Created At"] || nowIso(),
    "Updated At": user["Updated At"] || nowIso(),
    "Last Login At": user["Last Login At"] || null,
    "Login Count": toNonNegativeInt(user["Login Count"], 0),
    Preferences: {
      Theme: String(user.Preferences?.Theme || "core-edge"),
      Notifications: typeof user.Preferences?.Notifications === "boolean" ? user.Preferences.Notifications : true
    },
    "Service Access": {
      Panel: user["Service Access"]?.Panel !== false,
      Docs: user["Service Access"]?.Docs !== false,
      "Status Page": user["Service Access"]?.["Status Page"] !== false,
      "Main Website": user["Service Access"]?.["Main Website"] !== false,
      Discord: user["Service Access"]?.Discord !== false
    },
    Notes: String(user.Notes || "")
  };
}

function normalizeAssignedServers(servers) {
  if (!Array.isArray(servers) || !servers.length) {
    return [];
  }
  return servers.map(normalizeAssignedServer).filter((server) => isRealAssignedServer(server));
}

function normalizeAssignedServer(server = {}) {
  const combined = server["Database limit & Allocations(Should be same digits)"] || "0";
  return {
    "Server ID": String(server["Server ID"] || "").trim(),
    "Server Name": String(server["Server Name"] || "").trim(),
    Region: String(server.Region || "").trim(),
    Location: String(server.Location || "").trim(),
    Flag: String(server.Flag || "").trim(),
    "Node ID": String(server["Node ID"] || "").trim(),
    "Node Name": String(server["Node Name"] || "").trim(),
    "Server Software": String(server["Server Software"] || "").trim(),
    Version: String(server.Version || "").trim(),
    Status: String(server.Status || "").trim(),
    Backups: String(server.Backups || "").trim(),
    Notes: String(server.Notes || "").trim(),
    "Server Ram": String(server["Server Ram"] || "").trim(),
    Cpu: String(server.Cpu || "").trim(),
    Disk: String(server.Disk || "").trim(),
    "Database limit": String(server["Database limit"] ?? extractNumber(combined) ?? 0),
    Allocations: String(server.Allocations ?? extractNumber(combined) ?? 0),
    "Database limit & Allocations(Should be same digits)": String(combined),
    Pricing: server.Pricing || null,
    "Created At": server["Created At"] || null
  };
}

function isRealAssignedServer(server = {}) {
  return Boolean(
    String(server["Server ID"] || "").trim() ||
    String(server["Server Name"] || "").trim() ||
    String(server["Server Ram"] || "").trim() ||
    String(server.Cpu || "").trim() ||
    String(server.Disk || "").trim()
  );
}

function getRealAssignedServers(user) {
  const servers = Array.isArray(user["Assigned servers"]) ? user["Assigned servers"] : [];
  return servers.filter(isRealAssignedServer);
}

function findUserBySessionEmail(users, email) {
  return users.find((user) => String(user.Email || "").toLowerCase() === String(email || "").toLowerCase());
}

function findServerById(user, serverId) {
  return getRealAssignedServers(user).find((server) => String(server["Server ID"] || "") === String(serverId || ""));
}

function setServerStatus(user, serverId, nextStatus) {
  const servers = Array.isArray(user["Assigned servers"]) ? user["Assigned servers"] : [];
  user["Assigned servers"] = servers.map((server) => {
    if (String(server["Server ID"] || "") !== String(serverId || "")) {
      return server;
    }
    return {
      ...server,
      Status: nextStatus
    };
  });
}

function resolveNodeForServer(server) {
  const nodes = readNodes();
  const wantedNodeId = String(server["Node ID"] || "");
  const wantedRegion = String(server.Region || "");
  return (
    nodes.find((node) => String(node["Node ID"] || "") === wantedNodeId) ||
    nodes.find((node) => String(node.Region || "").toLowerCase() === wantedRegion.toLowerCase()) ||
    null
  );
}

function getPlanLimits(plan = DEFAULT_PLAN) {
  if (String(plan).toLowerCase() === "beta user") {
    return { ramGb: 6, cpuPercent: 200, diskGb: 25 };
  }
  return { ramGb: 12, cpuPercent: 300, diskGb: 35 };
}

function calculateServerPrice({ ramGb, cpuPercent, diskGb }) {
  const ramRs = ramGb * 68;
  const cpuRs = (cpuPercent / 100) * 123;
  const diskRs = (diskGb / 10) * 214;
  const totalRs = ramRs + cpuRs + diskRs;
  return {
    "RAM Rs": roundCurrency(ramRs),
    "CPU Rs": roundCurrency(cpuRs),
    "Disk Rs": roundCurrency(diskRs),
    "Total Rs": roundCurrency(totalRs),
    "RAM USD": roundCurrency(ramRs / USD_INR_RATE),
    "CPU USD": roundCurrency(cpuRs / USD_INR_RATE),
    "Disk USD": roundCurrency(diskRs / USD_INR_RATE),
    "Total USD": roundCurrency(totalRs / USD_INR_RATE)
  };
}

function calculateUtilizationFromServer(server) {
  const ram = extractNumber(server["Server Ram"]);
  const cpu = extractNumber(server.Cpu);
  const disk = extractNumber(server.Disk);
  const db = extractNumber(server["Database limit"]);
  const alloc = extractNumber(server.Allocations);

  return {
    "Cpu Usage": `${clampNumber(18 + cpu * 0.3, 0, 100)}%`,
    "Ram Usage": `${clampNumber(16 + ram * 7, 0, 100)}%`,
    "IP&DBs Usage": `${clampNumber(12 + (db + alloc) * 9, 0, 100)}%`,
    "Node Load usage": `${clampNumber(24 + cpu * 0.2 + ram * 3 + disk * 0.4, 0, 100)}%`
  };
}

function getDefaultUtilization() {
  return {
    "Cpu Usage": "0%",
    "Ram Usage": "0%",
    "IP&DBs Usage": "0%",
    "Node Load usage": "0%"
  };
}

function isAllowedEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  return normalized.endsWith("@fluxplus.in") || normalized.endsWith("@gmail.com");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return "Unknown";
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function generateUserId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function generateServerId() {
  return `srv_${crypto.randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePercent(value, fallback = "0%") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const match = String(value).match(/(\d+(\.\d+)?)/);
  if (!match) return fallback;
  return `${clampNumber(Number(match[1]), 0, 100)}%`;
}

function extractNumber(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const match = String(value).match(/(\d+(\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function toNonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.round(number);
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(Math.round(Number(value) || 0), min), max);
}

function roundCurrency(value) {
  return Math.round(Number(value) * 100) / 100;
}

function getRandomInt(min, max) {
  const safeMin = Math.ceil(min);
  const safeMax = Math.floor(max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function getRandomPingForRegion(region) {
  const regionMeta = REGION_OPTIONS[region] || REGION_OPTIONS.India;
  return getRandomInt(regionMeta.pingRange[0], regionMeta.pingRange[1]);
}

function buildStartupCommand(server) {
  const ramMb = extractMemoryMb(server["Server Ram"]);
  return `java -Xms256M -Xmx${ramMb}M -jar server.jar nogui`;
}

function extractMemoryMb(value) {
  const gb = extractNumber(value) || 4;
  return Math.max(1024, Math.round(gb * 1024));
}

function extractCpuPercent(value) {
  return Math.max(100, extractNumber(value) || 100);
}

function extractDiskMb(value) {
  const gb = extractNumber(value) || 10;
  return Math.max(1024, Math.round(gb * 1024));
}

function buildNodeBaseUrl(node) {
  const protocol = String(node.Protocol || "https").toLowerCase();
  const rawHost = String(node.Host || node.IP || "in-01.fluxplus.in").trim();
  const hasExplicitPort = /:\d+$/.test(rawHost);
  const nodePort = Number(node.Port || (protocol === "https" ? 443 : 80));
  const shouldAppendPort = !hasExplicitPort && !((protocol === "https" && nodePort === 443) || (protocol === "http" && nodePort === 80));
  const host = shouldAppendPort ? `${rawHost}:${nodePort}` : rawHost;
  return `${protocol}://${host}`;
}

async function fluxNodeFetch(node, routePath, options = {}) {
  const baseUrl = buildNodeBaseUrl(node);
  const response = await fetch(`${baseUrl}${routePath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${FLUX_WINGS_SHARED_API_KEY}`,
      "X-Panel-Key": FLUX_PANEL_FULL_ACCESS_API_KEY,
      ...(options.headers || {})
    }
  });

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = { success: false, message: `Node returned non-JSON response (${response.status}).` };
  }

  if (!response.ok) {
    return { success: false, status: response.status, ...parsed };
  }

  return parsed;
}

async function installAndStartServerOnNode(user, server, node) {
  const serverId = server["Server ID"];
  const startupCommand = buildStartupCommand(server);

  setServerStatus(user, serverId, "Deploying");
  user["Updated At"] = nowIso();
  writeUsers(readUsers().map((item) => item.Email === user.Email ? user : item));

  const createResponse = await fluxNodeFetch(node, "/wings/create-server", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId,
      serverName: server["Server Name"],
      software: server["Server Software"] || "Paper",
      version: server.Version || "1.20.1",
      buildNumber: server["Build Number"] || null,
      ramMb: extractMemoryMb(server["Server Ram"]),
      cpuPercent: extractCpuPercent(server.Cpu),
      diskMb: extractDiskMb(server.Disk),
      startupCommand,
      panelApiKey: FLUX_PANEL_FULL_ACCESS_API_KEY
    })
  });

  if (!createResponse.success) {
    return { success: false, status: "Install Failed", message: createResponse.message || "Wings failed to install the server." };
  }

  setServerStatus(user, serverId, createResponse.status || "Installed");
  user["Updated At"] = nowIso();
  writeUsers(readUsers().map((item) => item.Email === user.Email ? user : item));

  const startResponse = await fluxNodeFetch(node, "/wings/start-server", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId,
      startupCommand,
      panelApiKey: FLUX_PANEL_FULL_ACCESS_API_KEY
    })
  });

  if (!startResponse.success) {
    return { success: false, status: "Installed", message: startResponse.message || "Server was installed but failed to start." };
  }

  setServerStatus(user, serverId, startResponse.status || "Running");
  user["Updated At"] = nowIso();
  writeUsers(readUsers().map((item) => item.Email === user.Email ? user : item));

  return {
    success: true,
    message: "Server installed and started successfully.",
    createResponse,
    startResponse,
    status: startResponse.status || "Running"
  };
}


function getOwnedServerAndNode(req) {
  const users = readUsers();
  const user = findUserBySessionEmail(users, req.session.user.email);
  if (!user) {
    return { success: false, status: 404, message: "User not found." };
  }

  const serverId = String(req.params.serverId || "").trim();
  const server = findServerById(user, serverId);
  if (!server) {
    return { success: false, status: 404, message: "Server not found for this account." };
  }

  const node = resolveNodeForServer(server);
  if (!node) {
    return { success: false, status: 503, message: "Node not found." };
  }

  return { success: true, user, server, node };
}

async function searchModrinthPlugins({ q, loader, gameVersion }) {
  const facets = [];
  const normalizedLoader = String(loader || "").toLowerCase();
  if (normalizedLoader === "fabric" || normalizedLoader === "forge") {
    facets.push(["project_type:mod"]);
  } else {
    facets.push(["project_type:plugin"]);
  }
  if (gameVersion) {
    facets.push([`versions:${gameVersion}`]);
  }
  if (normalizedLoader) {
    facets.push([`categories:${normalizedLoader}`]);
  }

  const searchUrl = new URL(`${MODRINTH_API_BASE}/search`);
  searchUrl.searchParams.set("query", q);
  searchUrl.searchParams.set("limit", "10");
  searchUrl.searchParams.set("index", "relevance");
  searchUrl.searchParams.set("facets", JSON.stringify(facets));

  const response = await fetch(searchUrl.toString(), {
    headers: {
      "User-Agent": "FluxPlusCore/1.0.0 (https://core.fluxplus.in)"
    }
  });
  if (!response.ok) return [];

  const data = await response.json();
  const hits = Array.isArray(data.hits) ? data.hits : [];
  return hits.map((item) => ({
    source: "Modrinth",
    id: item.project_id || item.slug,
    name: item.title,
    summary: item.description,
    loader: normalizedLoader || null,
    gameVersion: gameVersion || null,
    downloadCount: item.downloads || 0,
    url: item.slug ? `https://modrinth.com/project/${item.slug}` : null
  }));
}

async function searchCurseForgePlugins({ q, gameVersion }) {
  const searchUrl = new URL(`${CURSEFORGE_API_BASE}/mods/search`);
  searchUrl.searchParams.set("gameId", String(CURSEFORGE_MINECRAFT_GAME_ID));
  searchUrl.searchParams.set("searchFilter", q);
  searchUrl.searchParams.set("pageSize", "10");
  if (gameVersion) {
    searchUrl.searchParams.set("gameVersion", gameVersion);
  }

  const response = await fetch(searchUrl.toString(), {
    headers: {
      Accept: "application/json",
      "x-api-key": CURSEFORGE_API_KEY
    }
  });
  if (!response.ok) return [];

  const data = await response.json();
  const items = Array.isArray(data.data) ? data.data : [];
  return items.map((item) => ({
    source: "CurseForge",
    id: item.id,
    name: item.name,
    summary: item.summary,
    gameVersion: gameVersion || null,
    downloadCount: item.downloadCount || 0,
    url: item.links?.websiteUrl || null
  }));
}

app.listen(PORT, PANEL_BIND_HOST, () => {
  console.log(`Flux+ server running on ${PANEL_BIND_HOST}:${PORT}`);
  console.log(`Public panel URL: ${PANEL_PUBLIC_URL}`);
});
