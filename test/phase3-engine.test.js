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
const { settleWait, enqueuePendingResumes, failWaitingExternal, setResumeEnqueue } = require("../src/services/waitCompletion");
const { setAgentEnqueue } = require("../src/services/cursorAgentService");
const { setPlaywrightEnqueue } = require("../src/services/playwrightService");
const { prepareExternalSettle } = require("../src/services/externalSettle");
const { triggerWebhook } = require("../src/services/triggerService");
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
      else reject(new Error(stderr || `git exited ${code}`));
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

function successNodes(run) {
  return (run.logs || []).filter((log) => log.status === "success").map((log) => log.nodeId);
}

describe("phase 3 lifecycle", () => {
  let root;
  let repo;
  let worktrees;
  let resumes;
  let agents;
  let suites;
  let opened;

  before(async () => {
    await connectTestDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-phase3-"));
    repo = path.join(root, "repo");
    worktrees = path.join(root, "worktrees");
    await fs.promises.mkdir(worktrees);
    await initRepo(repo);
    process.env.WORKTREES_DIR = worktrees;
    process.env.GITHUB_TOKEN = "github-phase3-secret";
    process.env.GITHUB_OWNER = "acme";
    process.env.GITHUB_REPO = "app";
    process.env.JIRA_WEBHOOK_SECRET = "jira-hook-secret";
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
  });

  after(async () => {
    setResumeEnqueue(null);
    setAgentEnqueue(null);
    setPlaywrightEnqueue(null);
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
    git.setGitRunner(null);
    resumes = [];
    agents = [];
    suites = [];
    opened = 0;
    setResumeEnqueue(async (run) => {
      resumes.push(run.pendingResume.resumeJobId);
    });
    setAgentEnqueue(async (_name, data) => {
      agents.push(data.externalJobId);
      return { id: data.externalJobId };
    });
    setPlaywrightEnqueue(async (_name, data) => {
      suites.push(data.externalJobId);
      return { id: data.externalJobId };
    });
  });

  async function published(nodes, edges, trigger) {
    return Workflow.create({
      name: "phase3",
      status: "published",
      userId: new mongoose.Types.ObjectId(),
      repository: { location: repo, defaultBranch: "main", credentialRef: "GITHUB_TOKEN" },
      nodes,
      edges,
      trigger: trigger || { type: "webhook", enabled: true, config: {} },
    });
  }

  test("duplicate, late, and crashed external completions resume once", async () => {
    const wf = await published(
      [
        { id: "git1", type: "gitBranch", config: { title: "Branch" } },
        { id: "agent1", type: "cursorAgent", config: { title: "Agent" } },
        { id: "yes", type: "delay", config: { seconds: 0 } },
        { id: "no", type: "delay", config: { seconds: 0 } },
      ],
      [
        { from: "git1", to: "agent1" },
        { from: "agent1", to: "yes", condition: "true" },
        { from: "agent1", to: "no", condition: "false" },
      ]
    );
    const waiting = await engine.executeWorkflow(wf._id, { jira: { key: "PROJ-1" } }, "agent-job");
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.executionClaim, null);
    assert.equal(agents.length, 1);
    const again = await engine.executeWorkflow(wf._id, { jira: { key: "PROJ-1" } }, "agent-job");
    assert.equal(String(again._id), String(waiting._id));
    assert.equal(agents.length, 1);
    assert.equal(opened, 0);

    const args = {
      runId: waiting._id,
      kind: "agent",
      nodeId: "agent1",
      externalJobId: waiting.wait.externalJobId,
      result: { branch: "true", status: "finished" },
    };
    const playwrightArgs = { ...args, kind: "playwright", externalJobId: "playwright-other", nodeId: "pw" };
    const latePlaywright = await settleWait(playwrightArgs);
    assert.equal(latePlaywright.matched, false);
    assert.equal(resumes.length, 0);
    const first = await settleWait(args);
    const second = await settleWait(args);
    assert.equal(first.matched, true);
    assert.equal(second.matched, false);
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0], `resume-agent-${waiting._id}-agent1`);

    setResumeEnqueue(async () => {
      throw new Error("queue down");
    });
    const crashWf = await published(
      [
        { id: "git1", type: "gitBranch", config: { title: "Branch" } },
        { id: "agent1", type: "cursorAgent", config: { title: "Agent" } },
        { id: "yes", type: "delay", config: { seconds: 0 } },
        { id: "no", type: "delay", config: { seconds: 0 } },
      ],
      [
        { from: "git1", to: "agent1" },
        { from: "agent1", to: "yes", condition: "true" },
        { from: "agent1", to: "no", condition: "false" },
      ]
    );
    const crashed = await engine.executeWorkflow(crashWf._id, { jira: { key: "PROJ-2" } }, "crash-job");
    const crashedSettle = await settleWait({
      runId: crashed._id,
      kind: "agent",
      nodeId: "agent1",
      externalJobId: crashed.wait.externalJobId,
      result: { branch: "true" },
    });
    assert.equal(crashedSettle.enqueued, false);
    assert.equal(crashedSettle.run.wait.state, "completing");
    resumes.length = 0;
    setResumeEnqueue(async (run) => {
      resumes.push(run.pendingResume.resumeJobId);
    });
    await enqueuePendingResumes();
    assert.deepEqual(resumes, [`resume-agent-${crashed._id}-agent1`]);
    const begun = await engine.beginResume(crashed._id, resumes[0]);
    assert.ok(begun);
    const secondBegin = await engine.beginResume(crashed._id, resumes[0]);
    assert.equal(secondBegin, null);

    const resumedRow = await Run.findById(waiting._id);
    const beforeLate = resumedRow.currentNodeId;
    await settleWait(args);
    const afterLate = await Run.findById(waiting._id);
    assert.equal(afterLate.currentNodeId, beforeLate);
  });

  test("two agent waits and two jira runs stay isolated", async () => {
    const wf = await published(
      [
        { id: "git1", type: "gitBranch", config: { title: "Branch" } },
        { id: "agent1", type: "cursorAgent", config: { title: "One" } },
        { id: "agent2", type: "cursorAgent", config: { title: "Two" } },
        { id: "yes", type: "delay", config: { seconds: 0 } },
        { id: "no", type: "delay", config: { seconds: 0 } },
      ],
      [
        { from: "git1", to: "agent1" },
        { from: "agent1", to: "agent2", condition: "true" },
        { from: "agent1", to: "no", condition: "false" },
        { from: "agent2", to: "yes", condition: "true" },
        { from: "agent2", to: "no", condition: "false" },
      ]
    );
    const first = await engine.executeWorkflow(wf._id, { jira: { key: "PROJ-1" } }, "jira_10001_evt1");
    const repeat = await engine.executeWorkflow(wf._id, { jira: { key: "PROJ-1" } }, "jira_10001_evt1");
    const second = await engine.executeWorkflow(wf._id, { jira: { key: "PROJ-1" } }, "jira_10001_evt2");
    assert.equal(String(first._id), String(repeat._id));
    assert.notEqual(String(first._id), String(second._id));
    assert.equal(first.external.branch, `wf/PROJ-1/${first._id}`);
    assert.equal(second.external.branch, `wf/PROJ-1/${second._id}`);
    assert.notEqual(first.external.worktreePath, second.external.worktreePath);
    assert.equal(fs.existsSync(first.external.worktreePath), true);
    assert.equal(fs.existsSync(second.external.worktreePath), true);

    await settleWait({
      runId: first._id,
      kind: "agent",
      nodeId: "agent1",
      externalJobId: first.wait.externalJobId,
      result: { branch: "true" },
    });
    const continued = await engine.resumeWorkflow(
      { runId: String(first._id), input: first.context },
      first.wait.resumeJobId
    );
    assert.equal(continued.status, "waiting");
    assert.equal(continued.currentNodeId, "agent2");
    assert.notEqual(continued.wait.externalJobId, first.wait.externalJobId);
    const ignored = await settleWait({
      runId: first._id,
      kind: "agent",
      nodeId: "agent1",
      externalJobId: first.wait.externalJobId,
      result: { branch: "true" },
    });
    assert.equal(ignored.matched, false);
    const still = await Run.findById(first._id);
    assert.equal(still.wait.nodeId, "agent2");
    assert.equal(still.wait.state, "pending");
  });

  test("a finished agent with no new commit and a moved HEAD do not open a pull request", async () => {
    const wf = await published(
      [{ id: "git1", type: "gitBranch", config: { title: "Branch" } }],
      []
    );
    const run = await engine.executeWorkflow(wf._id, {}, "sha-job");
    const prepared = await prepareExternalSettle({
      runId: run._id,
      kind: "agent",
      nodeId: "git1",
      externalJobId: "agent-unused",
      worktreePath: run.external.worktreePath,
      preAgentSha: await git.revParse(run.external.worktreePath),
      result: { status: "finished", branch: "true" },
    });
    assert.equal(prepared.result.branch, "false");

    const original = github.openPullRequest;
    const pushes = [];
    github.openPullRequest = async () => {
      opened += 1;
      return "https://github.com/acme/app/pull/1";
    };
    git.setGitRunner(async (args) => {
      pushes.push(args);
      if (args.includes("rev-parse")) return { stdout: "deadbeef\n", stderr: "", code: 0 };
      if (args.includes("push")) throw new Error("push should not run");
      return { stdout: "", stderr: "", code: 0 };
    });
    try {
      for (const status of ["failed", "timed-out", "bootstrap-failed"]) {
        await assert.rejects(() =>
          lifecycle.githubPr(
            {},
            {},
            {
              predecessorId: "pw",
              workflow: { repository: { defaultBranch: "main", credentialRef: "GITHUB_TOKEN" } },
              external: {
                worktreePath: run.external.worktreePath,
                testedSha: "abc",
                branch: "wf/manual/branch",
                repoPath: repo,
                playwrightByNode: {
                  pw: { status, reportPresent: status === "failed", testedSha: "abc" },
                },
              },
              checkpointExternal: async () => {},
            }
          )
        );
      }
      await assert.rejects(() =>
        lifecycle.githubPr(
          {},
          {},
          {
            predecessorId: "other",
            workflow: { repository: { defaultBranch: "main", credentialRef: "GITHUB_TOKEN" } },
            external: {
              worktreePath: run.external.worktreePath,
              testedSha: "abc",
              branch: "wf/manual/branch",
              playwrightByNode: {
                pw: { status: "passed", reportPresent: true, testedSha: "abc" },
              },
            },
            checkpointExternal: async () => {},
          }
        )
      );
    } finally {
      github.openPullRequest = original;
      git.setGitRunner(null);
    }
    assert.equal(opened, 0);
    assert.equal(pushes.some((args) => args.includes("push")), false);
  });

  test("jira webhook does not enqueue an invalid delivery", async () => {
    const wf = await published(
      [{ id: "start", type: "delay", config: { seconds: 0 } }],
      [],
      { type: "webhook", enabled: true, config: { provider: "jira" } }
    );
    let enqueued = 0;
    const enqueue = async () => {
      enqueued += 1;
      return { id: "should-not" };
    };
    const http = { async get() { throw new Error("axios should not be called"); } };
    await assert.rejects(
      () =>
        triggerWebhook(
          wf._id,
          { body: { issueKey: "nope", eventId: "evt1" }, headers: { "x-webhook-secret": "jira-hook-secret" } },
          { enqueue, http }
        ),
      (err) => err.statusCode === 400
    );
    await assert.rejects(
      () =>
        triggerWebhook(
          wf._id,
          { body: { issueKey: "PROJ-1" }, headers: { "x-webhook-secret": "jira-hook-secret" } },
          { enqueue, http }
        ),
      (err) => err.statusCode === 400
    );
    await assert.rejects(
      () =>
        triggerWebhook(
          wf._id,
          { body: { issueKey: "PROJ-1", eventId: "evt1" }, headers: { "x-webhook-secret": "wrong" } },
          { enqueue, http }
        ),
      (err) => err.statusCode === 401
    );
    assert.equal(enqueued, 0);
  });

  test("prepareExternalSettle honors a finished agent-error instead of throwing start", async () => {
    const sha = await git.revParse(repo);
    const prepared = await prepareExternalSettle({
      kind: "agent",
      mode: "implement",
      worktreePath: repo,
      preAgentSha: sha,
      result: { branch: "false", reason: "agent-error" },
    });
    assert.equal(prepared.result.branch, "false");
    assert.equal(prepared.result.reason, "agent-error");
  });

  test("prepareExternalSettle still waits when the agent job has not decided", async () => {
    const sha = await git.revParse(repo);
    await assert.rejects(
      () =>
        prepareExternalSettle({
          kind: "agent",
          mode: "implement",
          worktreePath: repo,
          preAgentSha: sha,
          result: {},
        }),
      /agent settle is not ready/
    );
  });

  test("failWaitingExternal marks a parked agent wait failed so Retry works", async () => {
    const runId = new mongoose.Types.ObjectId();
    const nodeId = "agentImpl";
    const externalJobId = `agent-${String(runId)}-${nodeId}`;
    await Run.create({
      _id: runId,
      workflowId: new mongoose.Types.ObjectId(),
      jobId: `fail-wait-${String(runId)}`,
      status: "waiting",
      currentNodeId: nodeId,
      wait: {
        kind: "agent",
        nodeId,
        state: "pending",
        externalJobId,
        resumeJobId: `resume-${externalJobId}`,
      },
    });
    const outcome = await failWaitingExternal({
      runId,
      kind: "agent",
      nodeId,
      externalJobId,
      error: new Error("agent settle is not ready"),
    });
    assert.equal(outcome.matched, true);
    assert.equal(outcome.run.status, "failed");
    const stored = await Run.findById(runId);
    assert.equal(stored.status, "failed");
    assert.equal(stored.logs[stored.logs.length - 1].error, "agent settle is not ready");
  });
});
