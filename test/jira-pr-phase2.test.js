const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const Workflow = require("../src/models/workflow");
const Run = require("../src/models/Run");
const engine = require("../src/services/executionengine");
const git = require("../src/services/gitService");
const github = require("../src/services/githubPrService");
const lifecycle = require("../src/nodes/lifecycle");
const nodes = require("../src/nodes");
const { defaultInspect, agentReceiptPath } = require("../src/services/agentAttempt");
const { connectTestDb, disconnectTestDb, clearTestData } = require("../test-support/helpers");

const DAY = 24 * 60 * 60 * 1000;

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
      else reject(new Error(stderr || `git exited ${code}`));
    });
  });
}

async function initRepo(dir, content) {
  await fs.promises.mkdir(dir, { recursive: true });
  await gitExec(["init", "-b", "main"], dir);
  await gitExec(["config", "user.email", "test@example.com"], dir);
  await gitExec(["config", "user.name", "Test"], dir);
  await fs.promises.writeFile(path.join(dir, "README.md"), content);
  await gitExec(["add", "README.md"], dir);
  await gitExec(["commit", "-m", "init"], dir);
}

describe("jira-pr phase 2 engine", () => {
  let root;
  let appRepo;
  let autoRepo;
  let worktrees;
  let previousWorktrees;

  before(async () => {
    await connectTestDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-phase2-"));
    appRepo = path.join(root, "app");
    autoRepo = path.join(root, "auto");
    worktrees = path.join(root, "worktrees");
    await fs.promises.mkdir(worktrees);
    await initRepo(appRepo, "app\n");
    await initRepo(autoRepo, "automation\n");
    previousWorktrees = process.env.WORKTREES_DIR;
    process.env.WORKTREES_DIR = worktrees;
  });

  after(async () => {
    git.setGitRunner(null);
    if (previousWorktrees === undefined) delete process.env.WORKTREES_DIR;
    else process.env.WORKTREES_DIR = previousWorktrees;
    await disconnectTestDb();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (err) {
      console.error("[test] cleanup failed:", err.message);
    }
  });

  beforeEach(async () => {
    await clearTestData();
    git.setGitRunner(null);
  });

  test("run status accepts interrupted and cancelled", async () => {
    const workflowId = new mongoose.Types.ObjectId();
    const interrupted = await Run.create({
      workflowId,
      jobId: "phase2-interrupted",
      status: "interrupted",
    });
    const cancelled = await Run.create({
      workflowId,
      jobId: "phase2-cancelled",
      status: "cancelled",
    });
    assert.equal(interrupted.status, "interrupted");
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(() =>
      Run.create({ workflowId, jobId: "phase2-bad-status", status: "blocked" })
    );
  });

  test("retries 1 runs once and the default stays 3", async () => {
    const original = nodes.executeNode;
    let calls = 0;
    nodes.executeNode = async (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      const once = await Workflow.create({
        name: "phase2-once",
        status: "published",
        nodes: [{ id: "n", type: "missing", config: { retries: 1 } }],
        edges: [],
        trigger: { type: "webhook", enabled: true, config: {} },
      });
      await assert.rejects(() => engine.executeWorkflow(once._id, {}, "phase2-once"));
      assert.equal(calls, 1);

      calls = 0;
      const thrice = await Workflow.create({
        name: "phase2-thrice",
        status: "published",
        nodes: [{ id: "n", type: "missing", config: {} }],
        edges: [],
        trigger: { type: "webhook", enabled: true, config: {} },
      });
      await assert.rejects(() => engine.executeWorkflow(thrice._id, {}, "phase2-thrice"));
      assert.equal(calls, 3);
    } finally {
      nodes.executeNode = original;
    }
  });

  test("a receipt outside the worktree leaves the tree clean", async () => {
    const runId = "a".repeat(24);
    const created = await git.createWorktree({
      repoPath: appRepo,
      runId,
      nodeId: "git1",
      baseBranch: "main",
      worktreesDir: worktrees,
    });
    const receipt = agentReceiptPath(worktrees, runId);
    const { runSandbox } = await import("../scripts/agent-sandbox-lib.mjs");
    await runSandbox({
      Agent: {
        async create() {
          return {
            agentId: "agent-1",
            async send() {
              return {
                id: "run-1",
                async wait() {
                  return { status: "finished" };
                },
              };
            },
            async [Symbol.asyncDispose]() {},
          };
        },
      },
      apiKey: "cursor-key",
      cwd: created.path,
      prompt: "leave the tree alone",
      writeReceipt: async (body) => {
        await fs.promises.mkdir(path.dirname(receipt), { recursive: true });
        await fs.promises.writeFile(receipt, JSON.stringify(body));
      },
    });
    assert.equal(fs.existsSync(path.join(created.path, ".workflow", "agent-execution.json")), false);
    assert.equal(await git.isClean(created.path), true);
    const observed = await defaultInspect(created.path, await git.revParse(created.path));
    assert.equal(observed.hasReceipt, true);
    assert.equal(observed.clean, true);
  });

  test("openExistingWorktree never deletes a partial directory", async () => {
    const runId = "1".repeat(24);
    const created = await git.createWorktree({
      repoPath: appRepo,
      runId,
      nodeId: "git1",
      baseBranch: "main",
      worktreesDir: worktrees,
    });
    const opened = await git.openExistingWorktree({
      repoPath: appRepo,
      runId,
      nodeId: "git1",
      worktreesDir: worktrees,
    });
    assert.equal(opened.path, created.path);
    assert.equal(opened.branch, `wf/manual/${runId}`);

    const partialId = "2".repeat(24);
    const partial = path.join(worktrees, `${partialId}-git1`);
    await fs.promises.mkdir(partial);
    await fs.promises.writeFile(path.join(partial, "partial.txt"), "keep");
    await assert.rejects(
      () =>
        git.openExistingWorktree({
          repoPath: appRepo,
          runId: partialId,
          nodeId: "git1",
          worktreesDir: worktrees,
        }),
      (err) => err.code === "WORKTREE_MISMATCH"
    );
    assert.equal(fs.existsSync(path.join(partial, "partial.txt")), true);
  });

  test("two repos in one run keep separate SHAs", async () => {
    const wf = await Workflow.create({
      name: "phase2-two-repos",
      status: "published",
      repository: { location: appRepo, defaultBranch: "main" },
      nodes: [
        { id: "appGit", type: "gitBranch", config: { role: "app" } },
        {
          id: "autoGit",
          type: "gitBranch",
          config: {
            role: "automation",
            repository: { location: autoRepo, defaultBranch: "main" },
          },
        },
      ],
      edges: [{ from: "appGit", to: "autoGit" }],
      trigger: { type: "webhook", enabled: true, config: {} },
    });
    const run = await engine.executeWorkflow(wf._id, { jira: { key: "MF-1" } }, "phase2-two-repos");
    const app = run.external.repos.app;
    const automation = run.external.repos.automation;
    assert.equal(run.external.worktreePath, undefined);
    assert.notEqual(app.worktreePath, automation.worktreePath);
    assert.equal(app.repoPath, await fs.promises.realpath(appRepo));
    assert.equal(automation.repoPath, await fs.promises.realpath(autoRepo));
    const appSha = await git.revParse(app.worktreePath);
    const autoSha = await git.revParse(automation.worktreePath);
    assert.notEqual(appSha, autoSha);

    async function saveExternal(patch) {
      let current = await Run.findById(run._id);
      let saved = await engine.persistRun(current._id, current.executionClaim, {
        context: current.context,
        currentNodeId: current.currentNodeId,
        status: current.status,
        external: patch,
      });
      if (!saved) {
        const claimed = await engine.acquireExecutionClaim(current._id, 30000);
        assert.ok(claimed);
        saved = await engine.persistRun(claimed._id, claimed.executionClaim, {
          context: current.context,
          currentNodeId: current.currentNodeId,
          status: current.status,
          external: patch,
        });
      }
      assert.ok(saved);
      return saved;
    }

    const stored = run.external.toObject ? run.external.toObject() : run.external;
    await lifecycle.cursorAgent(
      { id: "agentApp", type: "cursorAgent", config: { role: "app" } },
      {},
      {
        runId: String(run._id),
        nodeId: "agentApp",
        workflowId: String(wf._id),
        workflow: wf,
        external: stored,
        checkpointExternal: saveExternal,
      }
    );
    await lifecycle.cursorAgent(
      { id: "agentAuto", type: "cursorAgent", config: { role: "automation" } },
      {},
      {
        runId: String(run._id),
        nodeId: "agentAuto",
        workflowId: String(wf._id),
        workflow: wf,
        external: stored,
        checkpointExternal: saveExternal,
      }
    );
    const saved = await Run.findById(run._id);
    assert.equal(saved.external.repos.app.preAgentSha, appSha);
    assert.equal(saved.external.repos.automation.preAgentSha, autoSha);
    assert.equal(saved.external.repos.app.worktreePath, app.worktreePath);
    assert.equal(saved.external.repos.automation.worktreePath, automation.worktreePath);
  });

  test("githubPr uses the node repository owner and repo", async () => {
    const savedOwner = process.env.GITHUB_OWNER;
    const savedRepo = process.env.GITHUB_REPO;
    process.env.GITHUB_OWNER = "global-owner";
    process.env.GITHUB_REPO = "global-repo";
    process.env.PHASE2_GITHUB_TOKEN = "phase2-token";
    const original = github.openPullRequest;
    const seen = [];
    github.openPullRequest = async (args) => {
      seen.push(args);
      return "https://github.com/Vxceed-IN/Fuji-Vue3/pull/9";
    };
    git.setGitRunner(async (args) => {
      if (args.includes("rev-parse")) return { stdout: "abc123\n", stderr: "", code: 0 };
      if (args.includes("get-url")) {
        return { stdout: "https://github.com/Vxceed-IN/Fuji-Vue3.git\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    try {
      const result = await lifecycle.githubPr(
        {
          config: {
            role: "automation",
            repository: {
              owner: "Vxceed-IN",
              repo: "Fuji-Vue3",
              defaultBranch: "main",
              credentialRef: "PHASE2_GITHUB_TOKEN",
            },
          },
        },
        { jira: { summary: "Fix the form" } },
        {
          predecessorId: "pw",
          workflow: {
            repository: { defaultBranch: "develop", credentialRef: "GITHUB_TOKEN" },
          },
          external: {
            testedSha: "wrong",
            branch: "wf/flat",
            worktreePath: path.join(worktrees, "missing-flat"),
            repoPath: appRepo,
            playwrightByNode: {
              pw: { status: "failed", reportPresent: false, testedSha: "wrong" },
            },
            repos: {
              automation: {
                testedSha: "abc123",
                branch: "wf/QUT-1/branch",
                worktreePath: path.join(worktrees, "missing-auto"),
                repoPath: autoRepo,
                playwrightByNode: {
                  pw: { status: "passed", reportPresent: true, testedSha: "abc123" },
                },
              },
            },
          },
          checkpointExternal: async () => {},
        }
      );
      assert.equal(result.prUrl, "https://github.com/Vxceed-IN/Fuji-Vue3/pull/9");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].owner, "Vxceed-IN");
      assert.equal(seen[0].repo, "Fuji-Vue3");
      assert.equal(seen[0].base, "main");
      assert.equal(seen[0].head, "wf/QUT-1/branch");
    } finally {
      github.openPullRequest = original;
      git.setGitRunner(null);
      if (savedOwner === undefined) delete process.env.GITHUB_OWNER;
      else process.env.GITHUB_OWNER = savedOwner;
      if (savedRepo === undefined) delete process.env.GITHUB_REPO;
      else process.env.GITHUB_REPO = savedRepo;
      delete process.env.PHASE2_GITHUB_TOKEN;
    }
  });

  test("keepWorktreeOnFailure retains a failed worktree and reconcile leaves it", async () => {
    const flagged = await Workflow.create({
      name: "phase2-keep",
      status: "published",
      repository: { location: appRepo, defaultBranch: "main" },
      retention: { keepWorktreeOnFailure: true },
      nodes: [
        { id: "git1", type: "gitBranch", config: {} },
        { id: "pr", type: "githubPr", config: {} },
      ],
      edges: [{ from: "git1", to: "pr" }],
      trigger: { type: "webhook", enabled: true, config: {} },
    });
    await assert.rejects(() =>
      engine.executeWorkflow(flagged._id, { jira: { key: "MF-2" } }, "phase2-keep")
    );
    const failed = await Run.findOne({ jobId: "phase2-keep" });
    assert.equal(failed.status, "failed");
    const failedPath = failed.external.worktreePath;
    assert.equal(fs.existsSync(failedPath), true);

    let marked = false;
    await lifecycle.cursorAgent(
      { config: {} },
      {},
      {
        resumed: true,
        completion: { branch: "false" },
        workflow: flagged,
        node: { config: {} },
        external: failed.external,
        checkpointExternal: async () => {
          marked = true;
        },
      }
    );
    assert.equal(marked, false);
    assert.equal(fs.existsSync(failedPath), true);

    const plain = await Workflow.create({
      name: "phase2-drop",
      status: "published",
      repository: { location: appRepo, defaultBranch: "main" },
      nodes: [
        { id: "git1", type: "gitBranch", config: {} },
        { id: "pr", type: "githubPr", config: {} },
      ],
      edges: [{ from: "git1", to: "pr" }],
      trigger: { type: "webhook", enabled: true, config: {} },
    });
    await assert.rejects(() =>
      engine.executeWorkflow(plain._id, { jira: { key: "MF-3" } }, "phase2-drop")
    );
    const dropped = await Run.findOne({ jobId: "phase2-drop" });
    assert.equal(dropped.status, "failed");
    assert.equal(fs.existsSync(dropped.external.worktreePath), false);

    async function parked(status, endedAt, suffix) {
      const row = await Run.create({
        workflowId: flagged._id,
        jobId: `phase2-park-${suffix}`,
        status,
        endedAt,
        startedAt: endedAt || new Date(),
      });
      const dir = path.join(worktrees, `${row._id}-git1`);
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, "keep.txt"), "x");
      return dir;
    }

    const oldDir = await parked("success", new Date(Date.now() - 8 * DAY), "old");
    const recentDir = await parked("success", new Date(), "recent");
    const interruptedDir = await parked("interrupted", null, "interrupted");
    const cancelledDir = await parked("cancelled", null, "cancelled");
    const unflagged = await Run.create({
      workflowId: plain._id,
      jobId: "phase2-park-unflagged",
      status: "failed",
    });
    const unflaggedDir = path.join(worktrees, `${unflagged._id}-git1`);
    await fs.promises.mkdir(unflaggedDir);
    const orphan = path.join(worktrees, `${"e".repeat(24)}-git1`);
    await fs.promises.mkdir(orphan);

    await git.reconcileWorktrees({ repoPath: appRepo, worktreesDir: worktrees });
    assert.equal(fs.existsSync(failedPath), true);
    assert.equal(fs.existsSync(recentDir), true);
    assert.equal(fs.existsSync(interruptedDir), true);
    assert.equal(fs.existsSync(cancelledDir), true);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(unflaggedDir), false);
    assert.equal(fs.existsSync(orphan), false);
  });
});
