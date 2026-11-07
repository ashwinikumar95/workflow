const path = require("path");
const fs = require("fs");
const config = require("../../config");

function dirsToReconcile(deps = {}) {
  const cfg = deps.config || config;
  const dirs = [];
  const worktrees = deps.worktreesDir != null ? deps.worktreesDir : cfg.worktreesDir;
  const playwright =
    deps.playwrightWorktreesDir != null ? deps.playwrightWorktreesDir : cfg.playwrightWorktreesDir;
  if (worktrees) dirs.push({ kind: "worktrees", dir: worktrees, repoPath: deps.repoPath });
  if (playwright && playwright !== worktrees) {
    dirs.push({
      kind: "playwright",
      dir: playwright,
      repoPath: deps.playwrightRepoPath || deps.repoPath,
    });
  }
  return dirs;
}

async function runRetentionJobs(deps = {}) {
  const git = deps.git || require("./gitService");
  const artifacts = deps.artifacts || require("./artifactRedactor");
  const result = {
    artifacts: { removed: [] },
    worktrees: { removed: [] },
    playwright: { removed: [] },
  };

  const art = await artifacts.reconcileArtifacts(deps);
  result.artifacts = art && Array.isArray(art.removed) ? art : { removed: (art && art.removed) || [] };

  for (const entry of dirsToReconcile(deps)) {
    const reconciled = await git.reconcileWorktrees({
      repoPath: entry.repoPath,
      worktreesDir: entry.dir,
    });
    const removed = reconciled && Array.isArray(reconciled.removed) ? reconciled.removed : [];
    if (entry.kind === "playwright") result.playwright = { removed };
    else result.worktrees = { removed };
  }

  return result;
}

function retentionSidecar(runId, worktreesDir) {
  if (!runId || !worktreesDir) return "";
  return path.join(worktreesDir, String(runId));
}

async function pathExists(file) {
  try {
    await fs.promises.stat(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  dirsToReconcile,
  runRetentionJobs,
  retentionSidecar,
  pathExists,
};
