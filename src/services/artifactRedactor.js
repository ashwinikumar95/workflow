const fs = require("fs");
const path = require("path");
const config = require("../../config");
const { redactOutput } = require("./forbiddenEnv");

const TEXT_EXT = new Set([".json", ".log", ".txt", ".html", ".htm", ".md", ".css", ".js", ".xml", ".csv", ".map"]);
const PRIVATE_EXT = new Set([".zip", ".png", ".jpg", ".jpeg", ".webp", ".webm", ".mp4"]);
const PLACEHOLDER = "[redacted]";
const MIN_VALUE_LENGTH = 6;

const HEADER_PATTERNS = [
  { re: /Authorization:\s*[^\r\n]+/gi, to: "Authorization: [redacted]" },
  { re: /Proxy-Authorization:\s*[^\r\n]+/gi, to: "Proxy-Authorization: [redacted]" },
  { re: /Cookie:\s*[^\r\n]+/gi, to: "Cookie: [redacted]" },
  { re: /Set-Cookie:\s*[^\r\n]+/gi, to: "Set-Cookie: [redacted]" },
  { re: /x-api-key:\s*[^\r\n]+/gi, to: "x-api-key: [redacted]" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, to: PLACEHOLDER },
];

function artifactsRoot() {
  return config.artifactsDir || "";
}

function runDir(runId) {
  const root = artifactsRoot();
  if (!root || !runId) return "";
  return path.join(root, String(runId));
}

function parseEnvValues(text) {
  const values = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length >= MIN_VALUE_LENGTH) values.push(value);
  }
  values.sort((a, b) => b.length - a.length);
  return values;
}

function envValuesFromFiles(files) {
  const values = [];
  for (const file of files || []) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const stats = fs.statSync(file);
      if (stats.isDirectory()) continue;
      values.push(...parseEnvValues(fs.readFileSync(file, "utf8")));
    } catch {
      // skip unreadable credential files
    }
  }
  values.sort((a, b) => b.length - a.length);
  return [...new Set(values)];
}

function redactText(text, extraValues) {
  let out = redactOutput(String(text == null ? "" : text));
  const values = Array.isArray(extraValues) ? extraValues : [];
  for (const value of values) {
    if (!value) continue;
    out = out.split(value).join(PLACEHOLDER);
  }
  for (const pattern of HEADER_PATTERNS) {
    out = out.replace(pattern.re, pattern.to);
  }
  return out;
}

function isPrivateFile(rel, ext) {
  const name = path.posix.basename(rel.replace(/\\/g, "/")).toLowerCase();
  if (PRIVATE_EXT.has(ext)) return true;
  if (name.includes("trace") && ext === ".zip") return true;
  if (name.includes("screenshot") && PRIVATE_EXT.has(ext)) return true;
  return false;
}

function isTextFile(ext) {
  return TEXT_EXT.has(ext);
}

async function walkFiles(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

async function copyRedactedFile(src, dest, extraValues) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const ext = path.extname(src).toLowerCase();
  if (isTextFile(ext)) {
    const raw = await fs.promises.readFile(src, "utf8");
    await fs.promises.writeFile(dest, redactText(raw, extraValues), "utf8");
    return "public";
  }
  await fs.promises.copyFile(src, dest);
  return "binary";
}

function credentialEnvFiles(roots) {
  const files = [];
  for (const root of roots || []) {
    if (!root) continue;
    files.push(path.join(root, ".env"));
  }
  return files;
}

async function collectAttempt({
  runId,
  attempt,
  label: labelOpt,
  testCwd,
  appCwd,
  logDir,
  extraValues,
  envFiles,
} = {}) {
  const base = runDir(runId);
  if (!base) return { skipped: true, reason: "no-artifacts-dir" };
  const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const label = typeof labelOpt === "string" && labelOpt.trim() ? labelOpt.trim() : `attempt-${n}`;
  const publicDir = path.join(base, "public", label);
  const privateDir = path.join(base, "private", label);
  await fs.promises.mkdir(publicDir, { recursive: true });
  await fs.promises.mkdir(privateDir, { recursive: true });

  const values =
    extraValues ||
    envValuesFromFiles(envFiles || credentialEnvFiles([testCwd, appCwd]));

  const sources = [];
  if (testCwd) {
    sources.push({ root: path.join(testCwd, "test-results"), prefix: "test-results" });
    sources.push({ root: path.join(testCwd, "playwright-report"), prefix: "playwright-report" });
  }
  if (logDir) sources.push({ root: logDir, prefix: "logs" });
  else if (config.worktreesDir && runId) {
    sources.push({ root: path.join(config.worktreesDir, String(runId), "logs"), prefix: "logs" });
  }

  const copied = { public: [], private: [] };
  for (const source of sources) {
    const files = await walkFiles(source.root);
    for (const file of files) {
      const rel = path.relative(source.root, file);
      const posixRel = rel.replace(/\\/g, "/");
      const ext = path.extname(file).toLowerCase();
      if (isPrivateFile(posixRel, ext)) {
        const dest = path.join(privateDir, source.prefix, rel);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(file, dest);
        copied.private.push(path.join(source.prefix, posixRel));
        continue;
      }
      const dest = path.join(publicDir, source.prefix, rel);
      await copyRedactedFile(file, dest, values);
      copied.public.push(path.join(source.prefix, posixRel));
    }
  }

  const meta = {
    collectedAt: new Date().toISOString(),
    runId: String(runId),
    attempt: n,
  };
  await fs.promises.writeFile(path.join(publicDir, ".meta.json"), JSON.stringify(meta), "utf8");
  await fs.promises.writeFile(path.join(privateDir, ".meta.json"), JSON.stringify(meta), "utf8");
  return { skipped: false, publicDir, privateDir, copied, meta };
}

function keepUntilDeleted(run, ticket) {
  const status = run && run.status;
  const state = ticket && ticket.state;
  if (status === "failed" || status === "interrupted" || status === "cancelled") return true;
  if (state === "blocked" || state === "interrupted" || state === "failed" || state === "cancelled") return true;
  if (status === "running" || status === "waiting") return true;
  if (state && state !== "completed") return true;
  return false;
}

function collectedAtMs(file) {
  const meta = path.join(file, ".meta.json");
  if (!fs.existsSync(meta)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(meta, "utf8"));
    const at = parsed && parsed.collectedAt ? Date.parse(parsed.collectedAt) : NaN;
    return Number.isNaN(at) ? 0 : at;
  } catch {
    return 0;
  }
}

function ageMs(file) {
  try {
    let collected = collectedAtMs(file);
    if (!collected && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file)) {
        const child = collectedAtMs(path.join(file, name));
        if (child && child > collected) collected = child;
      }
    }
    if (collected) return Date.now() - collected;
    const stats = fs.statSync(file);
    return Date.now() - stats.mtimeMs;
  } catch {
    return 0;
  }
}

async function removeDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

async function reconcileArtifacts(deps = {}) {
  const root = deps.root || artifactsRoot();
  if (!root || !fs.existsSync(root)) return { removed: [] };
  const Run = deps.Run || require("../models/Run");
  const TicketRun = deps.TicketRun || require("../models/TicketRun");
  const publicMs = (deps.publicDays != null ? deps.publicDays : config.artifactRetentionPublicDays) * 24 * 60 * 60 * 1000;
  const privateMs = (deps.privateDays != null ? deps.privateDays : config.artifactRetentionPrivateDays) * 24 * 60 * 60 * 1000;
  const removed = [];
  const names = await fs.promises.readdir(root);
  for (const name of names) {
    const dir = path.join(root, name);
    let stats;
    try {
      stats = await fs.promises.stat(dir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    let run = null;
    let ticket = null;
    try {
      run = await Run.findById(name).lean();
    } catch {
      run = null;
    }
    try {
      ticket = await TicketRun.findOne({ runId: String(name) }).lean();
    } catch {
      ticket = null;
    }
    if (keepUntilDeleted(run, ticket)) continue;
    const publicRoot = path.join(dir, "public");
    const privateRoot = path.join(dir, "private");
    if (fs.existsSync(privateRoot) && ageMs(privateRoot) > privateMs) {
      await removeDir(privateRoot);
      removed.push(privateRoot);
    }
    if (fs.existsSync(publicRoot) && ageMs(publicRoot) > publicMs) {
      await removeDir(publicRoot);
      removed.push(publicRoot);
    }
    const leftover = fs.existsSync(dir) ? await fs.promises.readdir(dir) : [];
    if (!leftover.length) {
      await removeDir(dir);
      removed.push(dir);
    }
  }
  return { removed };
}

module.exports = {
  parseEnvValues,
  envValuesFromFiles,
  redactText,
  collectAttempt,
  reconcileArtifacts,
  keepUntilDeleted,
  runDir,
};
