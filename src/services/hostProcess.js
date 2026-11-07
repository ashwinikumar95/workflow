const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { assertEnvAllowed } = require("./forbiddenEnv");

const HOST_ENV_ALLOW = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
  "USERDOMAIN",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PUBLIC",
  "ALLUSERSPROFILE",
  "CI",
];

const portQueues = new Map();
let pidRegistry = defaultRegisterPid;

function setPidRegistry(fn) {
  pidRegistry = typeof fn === "function" ? fn : defaultRegisterPid;
}

async function defaultRegisterPid(runId, entry, action) {
  if (!runId || !/^[a-f0-9]{24}$/.test(String(runId))) return;
  try {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState !== 1) return;
    const Run = require("../models/Run");
    if (action === "add") {
      await Run.updateOne(
        { _id: runId },
        { $push: { "external.processes": { pid: entry.pid, startedAt: entry.startedAt, role: entry.role } } }
      );
    } else {
      await Run.updateOne({ _id: runId }, { $pull: { "external.processes": { pid: entry.pid } } });
    }
  } catch {
    return;
  }
}

function resolveBin(name) {
  const dir = path.dirname(process.execPath);
  if (name === "node") return process.execPath;
  if (name === "npm") {
    return path.join(dir, process.platform === "win32" ? "npm.cmd" : "npm");
  }
  if (name === "npx") {
    return path.join(dir, process.platform === "win32" ? "npx.cmd" : "npx");
  }
  return name;
}

function quoteWindows(arg) {
  const text = String(arg);
  if (text.length === 0) return '""';
  if (!/[\s"&<>|^()]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function buildEnv(extra, allow) {
  const names = new Set(HOST_ENV_ALLOW.concat(Array.isArray(allow) ? allow : []));
  const env = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (extra && typeof extra === "object") {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null) continue;
      env[key] = String(value);
    }
  }
  assertEnvAllowed(env);
  return env;
}

function reservePort(port) {
  const key = Number(port);
  if (!Number.isInteger(key) || key <= 0) {
    throw new Error("Vite port is required");
  }
  const chain = portQueues.get(key) || Promise.resolve();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const acquired = chain.then(() => {
    let unlocked = false;
    return () => {
      if (unlocked) return;
      unlocked = true;
      release();
    };
  });
  portQueues.set(
    key,
    chain.then(() => held)
  );
  return acquired;
}

function resetPortLocks() {
  portQueues.clear();
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("close", () => resolve());
      killer.on("error", () => resolve());
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    resolve();
  });
}

function spawnChild(command, args, options) {
  const resolved = resolveBin(command);
  const spawnOpts = {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const comspec =
      process.env.ComSpec ||
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    const line = [resolved, ...args].map(quoteWindows).join(" ");
    return spawn(comspec, ["/d", "/s", "/c", line], {
      ...spawnOpts,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(resolved, args, spawnOpts);
}

async function start(options) {
  const command = options.command;
  if (!command) throw new Error("Host process command is required");
  const args = Array.isArray(options.args) ? options.args : [];
  const env = options.env || buildEnv(options.extraEnv, options.allow);
  const logFile = options.logFile;
  let logHandle = null;
  if (logFile) {
    await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
    logHandle = await fs.promises.open(logFile, "a");
  }

  let child;
  try {
    child = spawnChild(command, args, { cwd: options.cwd, env });
  } catch (err) {
    if (logHandle) logHandle.close().catch(() => {});
    throw err;
  }

  const pid = child.pid;
  const startedAt = new Date();
  const role = options.role || "process";
  const entry = { pid, startedAt, role };
  Promise.resolve(pidRegistry(options.runId, entry, "add")).catch(() => {});

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let timer = null;

  const writeLog = (chunk) => {
    if (logHandle) logHandle.write(chunk).catch(() => {});
  };
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    writeLog(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    writeLog(chunk);
  });

  let onAbort = null;
  const wait = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal && onAbort) {
        options.signal.removeEventListener("abort", onAbort);
      }
      Promise.resolve(pidRegistry(options.runId, entry, "remove")).catch(() => {});
      if (logHandle) logHandle.close().catch(() => {});
      resolve(result);
    };

    child.on("error", (err) => {
      finish({
        code: 1,
        timedOut,
        cancelled,
        stdout,
        stderr: `${stderr}${err.message}`,
        pid,
      });
    });
    child.on("close", (code) => {
      finish({
        code: timedOut || cancelled ? 1 : code == null ? 1 : code,
        timedOut,
        cancelled,
        stdout,
        stderr,
        pid,
      });
    });
  });

  const stop = async () => {
    cancelled = true;
    await killTree(pid);
    return wait;
  };

  onAbort = () => {
    stop().catch(() => {});
  };

  if (Number.isInteger(options.timeoutMs) && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      stop().catch(() => {});
    }, options.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  }
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  return { pid, wait, stop };
}

async function run(options) {
  const handle = await start(options);
  return handle.wait;
}

module.exports = {
  HOST_ENV_ALLOW,
  resolveBin,
  buildEnv,
  start,
  run,
  killTree,
  reservePort,
  resetPortLocks,
  setPidRegistry,
};
