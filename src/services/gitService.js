const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../../config");
const { assertEnvAllowed } = require("./forbiddenEnv");

const SEGMENT = /^[a-f0-9]{24}-[A-Za-z0-9_-]{1,64}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const RUN_ID = /^[a-f0-9]{24}$/;

let gitRunner = null;

function setGitRunner(fn) {
  gitRunner = typeof fn === "function" ? fn : null;
}

function defaultGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      shell: false,
      windowsHide: true,
      cwd: options.cwd,
      env: options.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const err = new Error((stderr || stdout || `git exited ${code}`).trim());
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        err.args = args;
        reject(err);
      }
    });
  });
}

function runGit(args, options) {
  const runner = gitRunner || defaultGit;
  return runner(args, options);
}

function escapes(base, target) {
  const rel = path.relative(base, target);
  if (rel === "") return false;
  return rel.startsWith("..") || path.isAbsolute(rel);
}

function isInside(parent, child) {
  if (path.resolve(parent) === path.resolve(child)) return true;
  return !escapes(parent, child);
}

function isLink(stats) {
  if (!stats) return false;
  if (typeof stats.isSymbolicLink === "function" && stats.isSymbolicLink()) return true;
  return false;
}

function branchForRun(issueKey, runId) {
  const id = String(runId || "");
  if (!RUN_ID.test(id)) throw new Error("Run id must be 24 hex characters");
  if (typeof issueKey === "string" && ISSUE_KEY.test(issueKey)) {
    return `wf/${issueKey}/${id}`;
  }
  return `wf/manual/${id}`;
}

async function assertBranchName(name) {
  try {
    await runGit(["check-ref-format", "--branch", name]);
  } catch (err) {
    const refused = new Error(`Branch name rejected by git check-ref-format: ${name}`);
    refused.cause = err;
    throw refused;
  }
}

async function realDir(dir) {
  const real = await fs.promises.realpath(dir);
  const stats = await fs.promises.stat(real);
  if (!stats.isDirectory()) throw new Error("WORKTREES_DIR is not a directory");
  return real;
}

function segmentFor(runId, nodeId) {
  const segment = `${runId}-${nodeId}`;
  if (!SEGMENT.test(segment)) {
    const err = new Error("Worktree segment is not allowed");
    err.code = "WORKTREE_PATH";
    throw err;
  }
  return segment;
}

async function refuseLink(candidate) {
  let stats;
  try {
    stats = await fs.promises.lstat(candidate);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (isLink(stats)) {
    const err = new Error("Refusing to use a symlink or junction as a worktree path");
    err.code = "WORKTREE_SYMLINK";
    throw err;
  }
  return stats;
}

async function porcelainPaths(repoPath) {
  const listed = await runGit(["-C", repoPath, "worktree", "list", "--porcelain"]);
  const paths = [];
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  const real = [];
  for (const entry of paths) {
    try {
      real.push(await fs.promises.realpath(entry));
    } catch {
      real.push(path.resolve(entry));
    }
  }
  return real;
}

async function branchExists(repoPath, branch) {
  try {
    await runGit(["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function abbrevHead(worktreePath) {
  const result = await runGit(["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  return result.stdout.trim();
}

async function revParse(worktreePath) {
  const result = await runGit(["-C", worktreePath, "rev-parse", "HEAD"]);
  return result.stdout.trim();
}

async function isClean(worktreePath) {
  const result = await runGit(["-C", worktreePath, "status", "--porcelain"]);
  return result.stdout.trim() === "";
}

async function isAncestor(ancestor, descendant, worktreePath) {
  if (ancestor === descendant) return true;
  try {
    await runGit(["-C", worktreePath, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function diffIsEmpty(fromSha, toSha, worktreePath) {
  if (fromSha === toSha) return true;
  try {
    await runGit(["-C", worktreePath, "diff", "--quiet", fromSha, toSha]);
    return true;
  } catch (err) {
    if (err && err.code === 1) return false;
    throw err;
  }
}

async function readyForPlaywright(worktreePath, preAgentSha) {
  const head = await revParse(worktreePath);
  const clean = await isClean(worktreePath);
  if (!clean || !preAgentSha) return { ok: false, head };
  const descendant = await isAncestor(preAgentSha, head, worktreePath);
  const empty = await diffIsEmpty(preAgentSha, head, worktreePath);
  if (!descendant || empty || head === preAgentSha) return { ok: false, head };
  return { ok: true, head };
}

function resolveRepoPath(workflow) {
  const location = workflow && workflow.repository && workflow.repository.location;
  if (typeof location === "string" && location && fs.existsSync(location)) {
    const stats = fs.statSync(location);
    if (stats.isDirectory()) return path.resolve(location);
  }
  if (config.gitRepoPath && fs.existsSync(config.gitRepoPath)) {
    return path.resolve(config.gitRepoPath);
  }
  throw new Error("Functional repository is not available on this worker");
}

function resolveBaseBranch(workflow) {
  const configured = workflow && workflow.repository && workflow.repository.defaultBranch;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  if (config.gitBaseBranch) return config.gitBaseBranch;
  throw new Error("Functional repository default branch is not set");
}

async function createWorktree({ repoPath, runId, nodeId, issueKey, baseBranch, worktreesDir }) {
  const segment = segmentFor(runId, nodeId);
  const branch = branchForRun(issueKey, runId);
  const base = await realDir(worktreesDir || config.worktreesDir);
  const candidate = path.resolve(base, segment);
  if (escapes(base, candidate)) {
    const err = new Error("Worktree path escapes WORKTREES_DIR");
    err.code = "WORKTREE_PATH";
    throw err;
  }
  await refuseLink(candidate);
  await assertBranchName(branch);

  const repoReal = await fs.promises.realpath(repoPath);

  let stats = null;
  try {
    stats = await fs.promises.lstat(candidate);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (stats && stats.isDirectory()) {
    const real = await fs.promises.realpath(candidate);
    if (escapes(base, real) || isInside(repoReal, real)) {
      const err = new Error("Existing worktree path failed the realpath check");
      err.code = "WORKTREE_PATH";
      throw err;
    }
    const registered = await porcelainPaths(repoPath);
    let current = "";
    try {
      current = await abbrevHead(real);
    } catch {
      current = "";
    }
    if (registered.includes(real) && current === branch) {
      return { path: real, branch, repoPath: repoReal };
    }
    await fs.promises.rm(real, { recursive: true, force: true });
  }

  if (isInside(repoReal, candidate)) {
    throw new Error("Worktree must not be inside the main checkout");
  }

  const exists = await branchExists(repoPath, branch);
  if (exists) {
    await runGit(["-C", repoPath, "worktree", "add", candidate, branch]);
  } else {
    await runGit(["-C", repoPath, "worktree", "add", "-b", branch, candidate, baseBranch]);
  }

  const created = await fs.promises.realpath(candidate);
  if (escapes(base, created) || isInside(repoReal, created)) {
    throw new Error("Created worktree resolved outside WORKTREES_DIR");
  }
  return { path: created, branch, repoPath: repoReal };
}

async function removeWorktree({ repoPath, worktreePath, worktreesDir }) {
  if (!worktreePath) return;
  const base = await realDir(worktreesDir || config.worktreesDir);
  let stats;
  try {
    stats = await fs.promises.lstat(worktreePath);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (isLink(stats)) {
    const err = new Error("Refusing to remove a symlink worktree path");
    err.code = "WORKTREE_SYMLINK";
    throw err;
  }
  const real = await fs.promises.realpath(worktreePath);
  if (escapes(base, real)) {
    const err = new Error("Refusing to remove a path outside WORKTREES_DIR");
    err.code = "WORKTREE_PATH";
    throw err;
  }
  try {
    await runGit(["-C", repoPath, "worktree", "remove", "--force", real]);
  } catch (err) {
    const message = err && err.message ? err.message : "";
    if (!/not a working tree|not registered/i.test(message)) {
      try {
        await fs.promises.rm(real, { recursive: true, force: true });
      } catch (rmErr) {
        rmErr.cause = err;
        throw rmErr;
      }
    }
  }
  await runGit(["-C", repoPath, "worktree", "prune"]).catch(() => {});
}

function buildPushEnv(token, homeDir) {
  const home = homeDir || fs.mkdtempSync(path.join(os.tmpdir(), "wf-askpass-"));
  const gitConfig = path.join(home, "gitconfig");
  if (!fs.existsSync(gitConfig)) fs.writeFileSync(gitConfig, "");
  const env = {
    PATH: process.env.PATH || "",
    HOME: home,
    GIT_ASKPASS: path.join(__dirname, "..", "..", "scripts", "git-askpass.js"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_ASKPASS_TOKEN: token || "",
  };
  assertEnvAllowed(env);
  return env;
}

function pushArgs(worktreePath, testedSha, branch) {
  return ["-C", worktreePath, "push", "origin", `${testedSha}:refs/heads/${branch}`];
}

async function pushBranch({ worktreePath, branch, testedSha, token, remoteUrl }) {
  const head = await revParse(worktreePath);
  if (head !== testedSha) {
    const err = new Error("HEAD does not match the tested revision");
    err.code = "HEAD_MOVED";
    throw err;
  }
  let remote = remoteUrl;
  if (!remote) {
    const listed = await runGit(["-C", worktreePath, "remote", "get-url", "origin"]);
    remote = listed.stdout.trim();
  }
  if (!/^https:\/\//i.test(remote)) {
    throw new Error("Push remote must be HTTPS");
  }
  const args = pushArgs(worktreePath, testedSha, branch);
  if (token && args.some((arg) => String(arg).includes(token))) {
    throw new Error("Refusing to place the token in git arguments");
  }
  const env = buildPushEnv(token);
  await runGit(args, { cwd: worktreePath, env });
  return { refspec: `${testedSha}:refs/heads/${branch}` };
}

async function findEscapingSymlink(root) {
  const realRoot = await fs.promises.realpath(root);
  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await fs.promises.realpath(full);
        } catch {
          return full;
        }
        if (escapes(realRoot, target)) return full;
      } else if (entry.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(root);
}

async function reconcileWorktrees({ repoPath, worktreesDir } = {}) {
  const Run = require("../models/Run");
  const dir = worktreesDir || config.worktreesDir;
  if (!dir) return;
  let base;
  try {
    base = await realDir(dir);
  } catch {
    return;
  }
  if (repoPath && fs.existsSync(repoPath)) {
    await runGit(["-C", repoPath, "worktree", "prune"]).catch((err) => {
      console.error("[git] worktree prune failed:", err.message);
    });
  }

  const removing = await Run.find({ "external.worktreeState": "removing" });
  for (const run of removing) {
    const worktreePath = run.external && run.external.worktreePath;
    const repo = (run.external && run.external.repoPath) || repoPath;
    if (!worktreePath || !repo) continue;
    try {
      await removeWorktree({ repoPath: repo, worktreePath, worktreesDir: base });
      run.external.worktreeState = "removed";
      await Run.updateOne({ _id: run._id }, { $set: { "external.worktreeState": "removed" } });
    } catch (err) {
      console.error("[git] reconcile remove failed:", err.message);
    }
  }

  const names = await fs.promises.readdir(base);
  for (const name of names) {
    const candidate = path.resolve(base, name);
    let stats;
    try {
      stats = await fs.promises.lstat(candidate);
    } catch {
      continue;
    }
    if (isLink(stats)) continue;
    let real;
    try {
      real = await fs.promises.realpath(candidate);
    } catch {
      continue;
    }
    if (escapes(base, real)) continue;
    if (!SEGMENT.test(name)) continue;
    const runId = name.slice(0, 24);
    const run = await Run.findById(runId);
    if (run && (run.status === "running" || run.status === "waiting")) continue;
    await fs.promises.rm(real, { recursive: true, force: true }).catch((err) => {
      console.error("[git] orphan remove failed:", err.message);
    });
    if (repoPath) {
      await runGit(["-C", repoPath, "worktree", "prune"]).catch(() => {});
    }
  }
}

module.exports = {
  setGitRunner,
  runGit,
  branchForRun,
  assertBranchName,
  createWorktree,
  removeWorktree,
  buildPushEnv,
  pushArgs,
  pushBranch,
  revParse,
  isClean,
  isAncestor,
  diffIsEmpty,
  readyForPlaywright,
  resolveRepoPath,
  resolveBaseBranch,
  findEscapingSymlink,
  reconcileWorktrees,
  SEGMENT,
};
