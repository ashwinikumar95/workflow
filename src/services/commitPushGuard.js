const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const git = require("./gitService");
const { parseEnvValues, envValuesFromFiles, redactText } = require("./artifactRedactor");

const MIN_SECRET_LENGTH = 6;

function posixPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^"(.*)"$/, "$1");
}

function isEnvExample(rel) {
  return /(^|\/)\.env\.example$/.test(rel);
}

function isAuthPath(rel) {
  return rel === "playwright/.auth" || rel.startsWith("playwright/.auth/");
}

function isForbiddenPath(rel) {
  const name = posixPath(rel);
  if (!name || isEnvExample(name)) return false;
  if (/(^|\/)\.env(\.|$)/.test(name)) return true;
  if (isAuthPath(name)) return true;
  if (/\.(pem|key)$/i.test(name)) return true;
  return false;
}

function parsePorcelain(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3).trim();
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1).replace(/\\"/g, '"');
    }
    file = posixPath(file.replace(/^.* -> /, ""));
    if (file) rows.push({ code, file });
  }
  return rows;
}

function addedLines(diff) {
  const out = [];
  let file = "";
  let newLine = 0;
  for (const raw of String(diff || "").split(/\n/)) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("new file mode")) {
      continue;
    }
    if (line.startsWith("+++ b/")) {
      file = posixPath(line.slice(6).trim());
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)/);
      newLine = match ? Number(match[1]) : 0;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file = "";
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push({ file, line: newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue;
    if (file) newLine += 1;
  }
  return out;
}

function hashFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return "";
    const stats = fs.statSync(file);
    if (!stats.isFile()) return "";
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

function collectFileHashes(root) {
  const out = new Map();
  if (!root || !fs.existsSync(root)) return out;
  let stats;
  try {
    stats = fs.statSync(root);
  } catch {
    return out;
  }
  if (stats.isFile()) {
    const hashed = hashFile(root);
    if (hashed) out.set(".", hashed);
    return out;
  }
  if (!stats.isDirectory()) return out;
  const stack = [{ dir: root, prefix: "" }];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) stack.push({ dir: full, prefix: rel.replace(/\\/g, "/") });
      else if (entry.isFile()) {
        const hashed = hashFile(full);
        if (hashed) out.set(rel.replace(/\\/g, "/"), hashed);
      }
    }
  }
  return out;
}

function cookieValuesFromAuth(root) {
  const values = [];
  if (!root || !fs.existsSync(root)) return values;
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.json$/i.test(entry.name)) files.push(full);
    }
  }
  function walk(value) {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) values.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  }
  for (const file of files) {
    try {
      walk(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      // skip invalid auth JSON
    }
  }
  values.sort((a, b) => b.length - a.length);
  return [...new Set(values)];
}

function resolveInside(root, rel) {
  if (!root) return "";
  const base = path.resolve(root);
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return "";
  return resolved;
}

function secretValues({ worktreePath, sourceRepoPath, credentialFiles }) {
  const files = [];
  const listed = Array.isArray(credentialFiles) && credentialFiles.length ? credentialFiles : [".env"];
  for (const rel of listed) {
    if (isAuthPath(posixPath(rel))) continue;
    const worktreeFile = resolveInside(worktreePath, rel);
    const sourceFile = resolveInside(sourceRepoPath, rel);
    if (worktreeFile) files.push(worktreeFile);
    if (sourceFile) files.push(sourceFile);
  }
  const values = envValuesFromFiles(files);
  const authRoot = resolveInside(worktreePath, "playwright/.auth") || resolveInside(sourceRepoPath, "playwright/.auth");
  values.push(...cookieValuesFromAuth(authRoot));
  values.sort((a, b) => b.length - a.length);
  return [...new Set(values.filter((value) => value && value.length >= MIN_SECRET_LENGTH))];
}

function fail(errors) {
  const first = errors[0] || { file: "", line: 0, kind: "guard" };
  const where = first.line ? `${first.file}:${first.line}` : first.file || "worktree";
  return {
    ok: false,
    reason: "env",
    summary: `Commit/push guard failed at ${where}`,
    errors,
  };
}

function mapsDiffer(left, right) {
  if (left.size !== right.size) return true;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return true;
  }
  return false;
}

async function assertCommitPushGuard(options = {}) {
  const worktreePath = options.worktreePath;
  if (!worktreePath) {
    return fail([{ file: "", line: 0, kind: "missing-worktree" }]);
  }
  const stage = options.stage === "agent" ? "agent" : options.stage === "tests" ? "tests" : "push";
  const baseSha = typeof options.baseSha === "string" ? options.baseSha.trim() : "";
  const errors = [];

  let porcelain = "";
  try {
    const listed = await git.runGit(
      ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all", "--ignored"],
      { cwd: worktreePath }
    );
    porcelain = listed && listed.stdout ? listed.stdout : "";
  } catch (err) {
    return fail([{ file: "", line: 0, kind: err && err.message ? err.message : "status-failed" }]);
  }

  for (const row of parsePorcelain(porcelain)) {
    if (!isForbiddenPath(row.file)) continue;
    if (row.code === "!!") continue;
    errors.push({ file: row.file, line: 0, kind: "forbidden-path" });
  }

  if (baseSha) {
    let names = [];
    try {
      names = await git.diffNameOnly(baseSha, "HEAD", worktreePath);
    } catch (err) {
      return fail([{ file: "", line: 0, kind: err && err.message ? err.message : "diff-failed" }]);
    }
    for (const name of names) {
      if (isForbiddenPath(name)) errors.push({ file: posixPath(name), line: 0, kind: "forbidden-path" });
    }

    let diff = "";
    try {
      const listed = await git.runGit(["-C", worktreePath, "diff", "--unified=0", baseSha, "HEAD"]);
      diff = listed && listed.stdout ? listed.stdout : "";
    } catch (err) {
      if (!err || err.code !== 1) {
        return fail([{ file: "", line: 0, kind: err && err.message ? err.message : "diff-failed" }]);
      }
      diff = err.stdout || "";
    }
    const secrets = secretValues(options);
    for (const row of addedLines(diff)) {
      const redacted = redactText(row.text, secrets);
      if (redacted !== row.text) {
        errors.push({ file: row.file || "diff", line: row.line || 0, kind: "secret-line" });
        continue;
      }
      for (const value of secrets) {
        if (value && row.text.includes(value)) {
          errors.push({ file: row.file || "diff", line: row.line || 0, kind: "secret-line" });
          break;
        }
      }
    }
  }

  const listed = Array.isArray(options.credentialFiles) ? options.credentialFiles : [".env"];
  for (const rel of listed) {
    const name = posixPath(rel);
    const skipAuthHash = isAuthPath(name) && stage !== "agent";
    if (skipAuthHash) continue;
    const source = resolveInside(options.sourceRepoPath, rel);
    const dest = resolveInside(worktreePath, rel);
    if (!dest || !fs.existsSync(dest) || !source || !fs.existsSync(source)) continue;
    if (mapsDiffer(collectFileHashes(source), collectFileHashes(dest))) {
      errors.push({ file: name, line: 0, kind: "credential-changed" });
    }
  }

  if (errors.length) return fail(errors);
  return { ok: true, reason: "", errors: [] };
}

function classificationFrom(result) {
  const errors = Array.isArray(result && result.errors) ? result.errors : [];
  const evidence = errors.map((row) => {
    if (row.line) return `${row.file}:${row.line}`;
    return row.file || row.kind || "guard";
  });
  return {
    ok: true,
    value: {
      classification: "env",
      summary: (result && result.summary) || "Commit/push guard failed",
      evidence,
      recommendedAction: "stop_env",
      retryable: false,
    },
    routing: {
      action: "stop_env",
      classification: "env",
      retryable: false,
      block: true,
      notify: "env_failed",
      jiraComment: true,
    },
  };
}

module.exports = {
  isForbiddenPath,
  parsePorcelain,
  addedLines,
  parseEnvValues,
  assertCommitPushGuard,
  classificationFrom,
};
