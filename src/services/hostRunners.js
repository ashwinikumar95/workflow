const fs = require("fs");
const http = require("http");
const path = require("path");
const config = require("../../config");
const git = require("./gitService");
const hostProcess = require("./hostProcess");
const { agentReceiptPath, receiptPathForWorktree } = require("./agentAttempt");

const VITE_PORTS = { fuji: 5182, central: 5181 };
const AGENT_ENTRY = path.join(__dirname, "..", "..", "scripts", "agent-sandbox-entry.mjs");
const VITE_ATTEMPTS = 3;
const VITE_READY_MS = 30000;

function logFileFor(data, role) {
  const base = config.worktreesDir || path.join(require("os").tmpdir(), "workflow-logs");
  const runId = data && data.runId ? String(data.runId) : "unknown";
  return path.join(base, runId, "logs", `${role}.log`);
}

function isAuthPath(rel) {
  return String(rel || "").replace(/\\/g, "/").replace(/\/+$/, "") === "playwright/.auth";
}

function resolveInside(root, rel) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Credential path escapes repository");
  }
  return resolved;
}

function envFailure(reason) {
  return {
    code: 1,
    timedOut: false,
    reportPresent: false,
    failureClass: "env",
    reason: reason || "env",
    stdout: "",
    stderr: "",
  };
}

async function addExclude(worktree, files) {
  if (!worktree || !files.length) return;
  const listed = await git.runGit(["rev-parse", "--git-path", "info/exclude"], { cwd: worktree });
  const rel = String(listed.stdout || "").trim();
  const exclude = path.isAbsolute(rel) ? rel : path.join(worktree, rel);
  await fs.promises.mkdir(path.dirname(exclude), { recursive: true });
  let current = "";
  try {
    current = await fs.promises.readFile(exclude, "utf8");
  } catch {
    current = "";
  }
  const lines = current.split(/\r?\n/);
  let changed = false;
  for (const file of files) {
    const entry = String(file).replace(/\\/g, "/");
    if (!lines.includes(entry)) {
      lines.push(entry);
      changed = true;
    }
  }
  if (changed) {
    const body = lines.join("\n").replace(/\n+$/, "") + "\n";
    await fs.promises.writeFile(exclude, body);
  }
}

async function copyCredentialFiles({ sourceRepoPath, destWorktree, credentialFiles }) {
  const files = Array.isArray(credentialFiles) ? credentialFiles : [];
  const needsAuth = files.some(isAuthPath);
  if (needsAuth && !sourceRepoPath) {
    return envFailure("env");
  }
  for (const rel of files) {
    if (!sourceRepoPath) break;
    const src = resolveInside(sourceRepoPath, rel);
    const dest = resolveInside(destWorktree, rel);
    if (!fs.existsSync(src)) {
      if (isAuthPath(rel)) return envFailure("env");
      continue;
    }
    const stats = await fs.promises.stat(src);
    if (stats.isDirectory()) {
      await fs.promises.cp(src, dest, { recursive: true, force: true });
    } else {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(src, dest);
    }
  }
  if (needsAuth) {
    const authDest = destWorktree
      ? resolveInside(destWorktree, "playwright/.auth")
      : "";
    const authSrc = sourceRepoPath ? resolveInside(sourceRepoPath, "playwright/.auth") : "";
    if (!authSrc || !fs.existsSync(authSrc) || (authDest && !fs.existsSync(authDest))) {
      return envFailure("env");
    }
  }
  if (destWorktree && files.length) await addExclude(destWorktree, files);
  return { ok: true };
}

function portFromArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const index = list.indexOf("--port");
  if (index < 0 || index === list.length - 1) return null;
  const port = Number(list[index + 1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

function resolveVitePort(appCommand, app) {
  const fromCmd = portFromArgs(appCommand);
  const key = String(app || "").toLowerCase();
  let expected = null;
  if (key === "fuji" || key === "fuji-vue3") expected = VITE_PORTS.fuji;
  if (key === "central" || key === "mt-fuji-central") expected = VITE_PORTS.central;
  if (expected && fromCmd && fromCmd !== expected) {
    throw new Error(`Vite port ${fromCmd} does not match ${expected}`);
  }
  const port = fromCmd || expected;
  if (!port) throw new Error("Vite port is required");
  if (expected) return expected;
  return port;
}

function withPortFlags(appCommand, port) {
  const args = Array.isArray(appCommand) ? appCommand.slice() : [];
  if (!args.includes("--port")) args.push("--port", String(port));
  if (!args.includes("--strictPort")) args.push("--strictPort");
  return args;
}

function pollReady(port, readiness, timeoutMs) {
  const suffix = !readiness || readiness === "/" ? "/" : readiness.startsWith("/") ? readiness : `/${readiness}`;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      const req = http.get(
        { host: "127.0.0.1", port, path: suffix, timeout: 1000 },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.on("error", () => setTimeout(attempt, 200));
      req.on("timeout", () => {
        req.destroy();
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function acquirePortLock(runId, port) {
  if (!runId || !/^[a-f0-9]{24}$/.test(String(runId))) return null;
  try {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState !== 1) return null;
    const resourceLocks = require("./resourceLocks");
    const got = await resourceLocks.acquire(runId, [`port:${port}`]);
    if (!got.ok) {
      const err = new Error("Vite port is busy");
      err.code = "PORT_BUSY";
      throw err;
    }
    return got;
  } catch (err) {
    if (err && err.code === "PORT_BUSY") throw err;
    return null;
  }
}

async function startViteHost(opts) {
  const data = opts.data || opts;
  const appCommand = opts.appCommand || data.appCommand;
  if (!Array.isArray(appCommand) || appCommand.length === 0) {
    throw new Error("Vite appCommand is required");
  }
  const port = resolveVitePort(appCommand, opts.app || data.app);
  const cwd = opts.cwd || opts.appCwd;
  const readiness = opts.readiness || data.readiness || "/";
  const unlock = await hostProcess.reservePort(port);
  let portLock = null;
  try {
    portLock = await acquirePortLock(data.runId, port);
  } catch (err) {
    unlock();
    throw err;
  }
  const argv = withPortFlags(appCommand, port);
  let lastErr = new Error("Vite failed to become ready");
  let unlocked = false;
  const release = () => {
    if (unlocked) return;
    unlocked = true;
    unlock();
    if (portLock && portLock.token) {
      const resourceLocks = require("./resourceLocks");
      resourceLocks.release(data.runId, portLock.token, [`port:${port}`]).catch(() => {});
    }
  };
  try {
    for (let attempt = 1; attempt <= VITE_ATTEMPTS; attempt++) {
      const handle = await hostProcess.start({
        command: argv[0],
        args: argv.slice(1),
        cwd,
        extraEnv: { CI: "1" },
        logFile: logFileFor(data, "vite"),
        role: "vite",
        runId: data.runId,
      });
      const ready = await Promise.race([
        pollReady(port, readiness, opts.readyMs || VITE_READY_MS),
        handle.wait.then((result) => {
          if (result.stderr) lastErr = new Error(result.stderr);
          else lastErr = new Error(`Vite exited ${result.code}`);
          return false;
        }),
      ]);
      if (ready) {
        return {
          baseUrl: `http://localhost:${port}`,
          port,
          async stop() {
            await handle.stop();
            release();
          },
        };
      }
      await handle.stop();
    }
    release();
    throw lastErr;
  } catch (err) {
    release();
    throw err;
  }
}

async function startAgentHost(_spec, data) {
  const worktree = data && data.worktreePath;
  if (!worktree) throw new Error("Agent host run requires a worktree");
  const runId = data.runId;
  const promptFile = path.join(
    config.worktreesDir || path.dirname(worktree),
    String(runId || "unknown"),
    "receipts",
    "prompt.txt"
  );
  await fs.promises.mkdir(path.dirname(promptFile), { recursive: true });
  await fs.promises.writeFile(promptFile, data.prompt || "");
  const receiptFile =
    receiptPathForWorktree(worktree) ||
    (runId ? agentReceiptPath(config.worktreesDir || path.dirname(worktree), runId) : "");
  const entry = data.entry || AGENT_ENTRY;
  const result = await hostProcess.run({
    command: "node",
    args: [entry],
    cwd: worktree,
    extraEnv: {
      WORKFLOW_CWD: worktree,
      WORKFLOW_PROMPT_PATH: promptFile,
      WORKFLOW_RECEIPT_PATH: receiptFile,
      WORKFLOW_AGENT_EXECUTION_ID: data.agentExecutionId || "",
      CURSOR_API_KEY: config.cursorApiKey || "",
      CURSOR_MODEL: data.model || config.cursorModel || "composer-2.5",
    },
    timeoutMs: data.timeoutMs || config.agentTimeoutMs,
    logFile: logFileFor(data, "agent"),
    role: "agent",
    runId,
  });
  if (result.timedOut) {
    const err = new Error("agent timed out");
    err.timedOut = true;
    throw err;
  }
  if (result.code === 75) {
    const err = new Error("agent retryable");
    err.retryable = true;
    throw err;
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || `agent exited ${result.code}`);
  }
  return { status: "finished" };
}

async function installHost(opts) {
  const command = opts.command;
  const argv = Array.isArray(command) ? command : [];
  if (!argv.length) return { code: 0, stdout: "", stderr: "" };
  return hostProcess.run({
    command: argv[0],
    args: argv.slice(1),
    cwd: opts.cwd,
    extraEnv: { CI: "1" },
    timeoutMs: config.playwrightTimeoutMs,
    logFile: logFileFor(opts.data, "install"),
    role: "install",
    runId: opts.data && opts.data.runId,
  });
}

async function browsersHost(opts) {
  return hostProcess.run({
    command: "npx",
    args: ["playwright", "install"],
    cwd: opts.cwd,
    extraEnv: { CI: "1" },
    timeoutMs: config.playwrightTimeoutMs,
    logFile: logFileFor(opts.data, "browsers"),
    role: "browsers",
    runId: opts.data && opts.data.runId,
  });
}

async function runSuiteHost(opts) {
  const data = opts.data || {};
  const testCwd = opts.testCwd;
  const copied = await copyCredentialFiles({
    sourceRepoPath: data.sourceRepoPath,
    destWorktree: testCwd,
    credentialFiles: data.credentialFiles,
  });
  if (copied && copied.failureClass === "env") return copied;

  if (opts.appCwd && data.appSourceRepoPath && path.resolve(opts.appCwd) !== path.resolve(testCwd)) {
    const appCopied = await copyCredentialFiles({
      sourceRepoPath: data.appSourceRepoPath,
      destWorktree: opts.appCwd,
      credentialFiles: Array.isArray(data.appCredentialFiles) && data.appCredentialFiles.length
        ? data.appCredentialFiles
        : [".env"],
    });
    if (appCopied && appCopied.failureClass === "env") return appCopied;
  }

  let vite = null;
  try {
    const appCommand = data.appCommand;
    if (Array.isArray(appCommand) && appCommand.length > 0) {
      vite = await startViteHost({
        cwd: opts.appCwd || testCwd,
        appCommand,
        app: data.app,
        readiness: data.readiness || "/",
        data,
      });
      if (opts.env) opts.env.BASE_URL = vite.baseUrl;
    }
    const command = Array.isArray(opts.command) && opts.command.length
      ? opts.command.slice()
      : ["node", "scripts/playwright-test.js"];
    if (data.testPath) command.push(data.testPath);
    const extraEnv = { ...(opts.env || {}), CI: "1" };
    if (vite) extraEnv.BASE_URL = vite.baseUrl;
    const result = await hostProcess.run({
      command: command[0],
      args: command.slice(1),
      cwd: testCwd,
      extraEnv,
      timeoutMs: config.playwrightTimeoutMs,
      logFile: logFileFor(data, "playwright"),
      role: "playwright",
      runId: data.runId,
    });
    const reportPresent = fs.existsSync(path.join(testCwd, "test-results", "report.json"));
    return { ...result, reportPresent };
  } finally {
    if (vite) await vite.stop();
  }
}

module.exports = {
  VITE_PORTS,
  copyCredentialFiles,
  resolveVitePort,
  startAgentHost,
  installHost,
  browsersHost,
  runSuiteHost,
  startViteHost,
  reserveAppPort: hostProcess.reservePort,
  resetPortLocks: hostProcess.resetPortLocks,
};
