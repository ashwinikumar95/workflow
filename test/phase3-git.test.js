const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const git = require("../src/services/gitService");
const Run = require("../src/models/Run");
const { connectTestDb, disconnectTestDb, clearTestData } = require("../test-support/helpers");

function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `git ${args.join(" ")} exited ${code}`));
    });
  });
}

async function initRepo(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  await gitExec(["init", "-b", "main"], dir);
  await gitExec(["config", "user.email", "test@example.com"], dir);
  await gitExec(["config", "user.name", "Test"], dir);
  await fs.promises.writeFile(path.join(dir, "README.md"), "hello\n");
  await gitExec(["add", "README.md"], dir);
  await gitExec(["commit", "-m", "init"], dir);
}

describe("phase 3 git worktrees", () => {
  let root;
  let repo;
  let worktrees;
  const calls = [];

  before(async () => {
    await connectTestDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-git-"));
    repo = path.join(root, "repo");
    worktrees = path.join(root, "worktrees");
    await fs.promises.mkdir(worktrees);
    await initRepo(repo);
    process.env.WORKTREES_DIR = worktrees;
  });

  after(async () => {
    git.setGitRunner(null);
    await disconnectTestDb();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (err) {
      console.error("[test] cleanup failed:", err.message);
    }
  });

  beforeEach(async () => {
    await clearTestData();
    calls.length = 0;
    git.setGitRunner(null);
  });

  function recordGit() {
    const tracked = [];
    async function record(args, options) {
      tracked.push(args.slice());
      git.setGitRunner(null);
      try {
        return await git.runGit(args, options);
      } finally {
        git.setGitRunner(record);
      }
    }
    git.setGitRunner(record);
    return tracked;
  }

  test("check-ref-format rejects names the old character class allowed", async () => {
    git.setGitRunner(null);
    await assert.rejects(() => git.assertBranchName("foo..bar"));
    await assert.rejects(() => git.assertBranchName("foo.lock"));
  });

  test("createWorktree is idempotent and refuses path escapes", async () => {
    git.setGitRunner(null);
    const tracked = recordGit();

    const runId = "a".repeat(24);
    const first = await git.createWorktree({
      repoPath: repo,
      runId,
      nodeId: "git1",
      issueKey: "PROJ-1",
      baseBranch: "main",
      worktreesDir: worktrees,
    });
    const second = await git.createWorktree({
      repoPath: repo,
      runId,
      nodeId: "git1",
      issueKey: "PROJ-1",
      baseBranch: "main",
      worktreesDir: worktrees,
    });
    assert.equal(first.path, second.path);
    assert.equal(first.branch, `wf/PROJ-1/${runId}`);
    const adds = tracked.filter((args) => args.includes("worktree") && args.includes("add"));
    assert.equal(adds.length, 1);

    tracked.length = 0;
    await assert.rejects(() =>
      git.createWorktree({
        repoPath: repo,
        runId: "..",
        nodeId: "git1",
        issueKey: "PROJ-1",
        baseBranch: "main",
        worktreesDir: worktrees,
      })
    );
    await assert.rejects(() =>
      git.createWorktree({
        repoPath: repo,
        runId: "b".repeat(24),
        nodeId: "foo/bar",
        baseBranch: "main",
        worktreesDir: worktrees,
      })
    );
    assert.equal(tracked.length, 0);

    const linkRun = "c".repeat(24);
    const outside = path.join(root, "outside");
    await fs.promises.mkdir(outside);
    const link = path.join(worktrees, `${linkRun}-git1`);
    await fs.promises.symlink(outside, link, "junction");
    tracked.length = 0;
    await assert.rejects(
      () =>
        git.createWorktree({
          repoPath: repo,
          runId: linkRun,
          nodeId: "git1",
          baseBranch: "main",
          worktreesDir: worktrees,
        }),
      (err) => err.code === "WORKTREE_SYMLINK"
    );
    assert.equal(tracked.length, 0);
    assert.equal(fs.existsSync(outside), true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });

  test("a partial add is repaired and reconcile removes orphans", async () => {
    git.setGitRunner(null);
    const tracked = recordGit();
    const runId = "d".repeat(24);
    const branch = `wf/manual/${runId}`;
    await gitExec(["branch", branch], repo);
    const partial = path.join(worktrees, `${runId}-git1`);
    await fs.promises.mkdir(partial);
    await fs.promises.writeFile(path.join(partial, "partial.txt"), "x");
    const created = await git.createWorktree({
      repoPath: repo,
      runId,
      nodeId: "git1",
      baseBranch: "main",
      worktreesDir: worktrees,
    });
    assert.equal(fs.existsSync(path.join(created.path, "README.md")), true);
    const adds = tracked.filter((args) => args.includes("worktree") && args.includes("add"));
    assert.equal(adds.length, 1);

    const orphanId = "e".repeat(24);
    const orphan = path.join(worktrees, `${orphanId}-git1`);
    await fs.promises.mkdir(orphan);
    const escapeId = "f".repeat(24);
    const outside = path.join(root, "keep-me");
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, "keep.txt"), "stay");
    const escapeLink = path.join(worktrees, `${escapeId}-git1`);
    await fs.promises.symlink(outside, escapeLink, "junction");

    await Run.create({
      workflowId: new mongoose.Types.ObjectId(),
      jobId: "remove-me",
      status: "success",
      external: {
        worktreePath: created.path,
        repoPath: repo,
        worktreeState: "removing",
      },
    });
    await git.reconcileWorktrees({ repoPath: repo, worktreesDir: worktrees });
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
    assert.equal(fs.existsSync(escapeLink), true);
  });
});
