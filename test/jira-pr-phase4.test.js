const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const Run = require("../src/models/Run");
const TicketRun = require("../src/models/TicketRun");
const ResourceLock = require("../src/models/ResourceLock");
const engine = require("../src/services/executionengine");
const resourceLocks = require("../src/services/resourceLocks");
const ticketState = require("../src/services/ticketState");
const recovery = require("../src/services/recovery");
const runControl = require("../src/services/runControl");
const {
  connectTestDb,
  disconnectTestDb,
  clearTestData,
  createPublishedWorkflow,
  sleep,
} = require("../test-support/helpers");

function future(ms = 10 * 60 * 1000) {
  return new Date(Date.now() + ms);
}

function past(ms = 60 * 1000) {
  return new Date(Date.now() - ms);
}

async function gitExec(args, cwd) {
  await new Promise((resolve, reject) => {
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

async function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function makeRun(overrides = {}) {
  return Run.create({
    jobId: overrides.jobId || new mongoose.Types.ObjectId().toString(),
    status: overrides.status || "running",
    currentNodeId: overrides.currentNodeId,
    workflowId: overrides.workflowId,
    context: overrides.context,
    external: overrides.external,
    startedAt: new Date(),
  });
}

async function makeTicket(overrides = {}) {
  const run = overrides.run || (await makeRun());
  const ticket = await ticketState.createLive({
    jiraKey: overrides.jiraKey || `MF-${Date.now()}`,
    profileKey: overrides.profileKey || "MF",
    runId: String(run._id),
    state: overrides.state || "claimed",
    stage: overrides.stage || overrides.state || "claimed",
    fingerprint: overrides.fingerprint,
    testedSha: overrides.testedSha,
    checkpointSha: overrides.checkpointSha,
    worktreePath: overrides.worktreePath,
    selection: overrides.selection,
  });
  return { run, ticket };
}

describe("jira-pr phase 4 locks, recovery, cancel and retry", () => {
  let root;

  before(async () => {
    await connectTestDb();
    await TicketRun.syncIndexes();
    await ResourceLock.syncIndexes();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-phase4-"));
  });

  after(async () => {
    await disconnectTestDb();
    if (!root) return;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (err) {
      console.error("[test] cleanup failed:", err.message);
    }
  });

  beforeEach(async () => {
    await clearTestData();
  });

  test("an MF and a QUT run at the same time: one gets env:dms, the other waits as queued", async () => {
    const mf = await makeTicket({
      jiraKey: "MF-101",
      profileKey: "MF",
      state: "awaiting_approval",
      stage: "awaiting_approval",
    });
    const qut = await makeTicket({
      jiraKey: "QUT-101",
      profileKey: "QUT",
      state: "awaiting_approval",
      stage: "awaiting_approval",
    });

    const first = await resourceLocks.acquireForTicket(mf.ticket);
    const second = await resourceLocks.acquireForTicket(qut.ticket);

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.queued, true);

    const held = await ResourceLock.findById("env:dms").lean();
    assert.ok(held);
    assert.equal(held.owner, String(mf.run._id));

    const mfAfter = await TicketRun.findById(mf.ticket._id);
    const qutAfter = await TicketRun.findById(qut.ticket._id);
    assert.equal(mfAfter.state, "implementing");
    assert.equal(qutAfter.state, "queued");
  });

  test("MF and MFC at the same time both run", async () => {
    const mf = await makeTicket({
      jiraKey: "MF-102",
      profileKey: "MF",
      state: "awaiting_approval",
      stage: "awaiting_approval",
    });
    const mfc = await makeTicket({
      jiraKey: "MFC-102",
      profileKey: "MFC",
      state: "awaiting_approval",
      stage: "awaiting_approval",
    });

    const first = await resourceLocks.acquireForTicket(mf.ticket);
    const second = await resourceLocks.acquireForTicket(mfc.ticket);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    const dms = await ResourceLock.findById("env:dms").lean();
    const central = await ResourceLock.findById("env:central").lean();
    assert.equal(dms.owner, String(mf.run._id));
    assert.equal(central.owner, String(mfc.run._id));

    assert.equal((await TicketRun.findById(mf.ticket._id)).state, "implementing");
    assert.equal((await TicketRun.findById(mfc.ticket._id)).state, "implementing");
  });

  test("a failure on the second lock rolls back the first", async () => {
    await ResourceLock.create({
      _id: "port:5182",
      owner: "other-run",
      token: "other-token",
      acquiredAt: new Date(),
      expiresAt: future(),
    });

    const result = await resourceLocks.acquire("run-a", ["env:dms", "port:5182"]);
    assert.equal(result.ok, false);
    assert.equal(result.held, "port:5182");
    assert.equal(await ResourceLock.findById("env:dms"), null);
    const still = await ResourceLock.findById("port:5182").lean();
    assert.equal(still.owner, "other-run");
  });

  test("an expired lock is released only by recovery", async () => {
    await ResourceLock.create({
      _id: "env:dms",
      owner: new mongoose.Types.ObjectId().toString(),
      token: "stale",
      acquiredAt: past(10 * 60 * 1000),
      expiresAt: past(),
    });

    const steal = await resourceLocks.acquire("fresh-run", ["env:dms"]);
    assert.equal(steal.ok, false);
    assert.ok(await ResourceLock.findById("env:dms"));

    const released = await recovery.recoverExpiredLocks({ skipTicketRecovery: true });
    assert.ok(released.includes("env:dms"));
    assert.equal(await ResourceLock.findById("env:dms"), null);

    const after = await resourceLocks.acquire("fresh-run", ["env:dms"]);
    assert.equal(after.ok, true);
  });

  test("every listed transition is allowed, and an invalid one is refused", async () => {
    const { ticket } = await makeTicket({ jiraKey: "MF-103", state: "claimed", stage: "claimed" });
    for (const [from, to] of ticketState.listedTransitions()) {
      await TicketRun.updateOne({ _id: ticket._id }, { $set: { state: from } });
      const result = await ticketState.transition(ticket._id, from, to);
      assert.equal(result.ok, true, `${from} -> ${to} should be allowed`);
      assert.equal(result.ticket.state, to);
    }

    await TicketRun.updateOne({ _id: ticket._id }, { $set: { state: "implementing" } });
    const refused = await ticketState.transition(ticket._id, "implementing", "claimed");
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "invalid_transition");
    assert.equal((await TicketRun.findById(ticket._id)).state, "implementing");

    const cas = await ticketState.transition(ticket._id, "queued", "implementing");
    assert.equal(cas.ok, false);
    assert.equal(cas.reason, "cas_failed");
  });

  test("killed during implementation becomes interrupted with the worktree kept, and Cursor is not run again", async () => {
    const worktree = path.join(root, "impl-worktree");
    await initRepo(worktree, "app\n");
    const dirty = path.join(worktree, "wip.txt");
    await fs.promises.writeFile(dirty, "partial work\n");

    const { run, ticket } = await makeTicket({
      jiraKey: "MF-104",
      profileKey: "MF",
      state: "implementing",
      stage: "implementing",
      worktreePath: worktree,
      checkpointSha: (await recovery.inspectWorktree(worktree, "")).head,
    });
    await Run.updateOne(
      { _id: run._id },
      { $set: { external: { worktreePath: worktree, processes: [] } } }
    );

    let cursorCalls = 0;
    const result = await recovery.recoverTicket(ticket, {
      run: await Run.findById(run._id),
      runCursor: async () => {
        cursorCalls += 1;
      },
    });

    assert.equal(result.action, "interrupt");
    assert.equal(result.cursorInvoked, false);
    assert.equal(cursorCalls, 0);
    assert.equal((await TicketRun.findById(ticket._id)).state, "interrupted");
    assert.equal((await Run.findById(run._id)).status, "interrupted");
    assert.equal(fs.existsSync(dirty), true);
    assert.equal(fs.readFileSync(dirty, "utf8"), "partial work\n");
    assert.equal(fs.existsSync(worktree), true);
  });

  test("killed during Playwright reruns the same SHA", async () => {
    const testedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { run, ticket } = await makeTicket({
      jiraKey: "MF-105",
      profileKey: "MF",
      state: "verifying",
      stage: "playwright",
      testedSha,
      selection: ["tests/e2e/stock-transfer"],
    });

    const reruns = [];
    let cursorCalls = 0;
    const result = await recovery.recoverTicket(ticket, {
      run,
      rerunPlaywright: async (args) => {
        reruns.push(args);
      },
      runCursor: async () => {
        cursorCalls += 1;
      },
    });

    assert.equal(result.action, "rerun_playwright");
    assert.equal(result.testedSha, testedSha);
    assert.equal(reruns.length, 1);
    assert.equal(reruns[0].testedSha, testedSha);
    assert.deepEqual(reruns[0].selection, ["tests/e2e/stock-transfer"]);
    assert.equal(cursorCalls, 0);
    assert.equal((await TicketRun.findById(ticket._id)).state, "verifying");
  });

  test("cancel kills processes and releases locks", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 100000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid;
    const deadline = Date.now() + 2000;
    while (!(await isAlive(pid)) && Date.now() < deadline) await sleep(20);
    assert.equal(await isAlive(pid), true);

    const { run, ticket } = await makeTicket({
      jiraKey: "MF-106",
      profileKey: "MF",
      state: "implementing",
      stage: "implementing",
    });
    const token = "lock-token";
    await ResourceLock.create({
      _id: "env:dms",
      owner: String(run._id),
      token,
      acquiredAt: new Date(),
      expiresAt: future(),
    });
    await Run.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "running",
          external: { processes: [{ pid, startedAt: new Date(), role: "agent" }] },
        },
      }
    );

    const outcome = await runControl.cancelRun(run._id, { removeJobs: async () => {} });
    assert.equal(outcome.http, 200);
    assert.equal((await Run.findById(run._id)).status, "cancelled");
    assert.equal((await TicketRun.findById(ticket._id)).state, "cancelled");
    assert.equal(await ResourceLock.findById("env:dms"), null);

    const deadBy = Date.now() + 5000;
    while ((await isAlive(pid)) && Date.now() < deadBy) await sleep(50);
    assert.equal(await isAlive(pid), false);
  });

  test("retry re-enqueues the same jobId after recovery", async () => {
    const wf = await createPublishedWorkflow(
      [{ id: "implement", type: "delay", config: { seconds: 0 } }],
      []
    );
    const run = await makeRun({
      jobId: "mf-retry-job",
      status: "interrupted",
      currentNodeId: "implement",
      workflowId: wf._id,
    });
    await ticketState.createLive({
      jiraKey: "MF-107",
      profileKey: "MF",
      runId: String(run._id),
      state: "interrupted",
      stage: "implementing",
    });

    const enqueued = [];
    const outcome = await runControl.retryRun(run._id, {
      enqueue: async (row) => {
        enqueued.push(row.jobId);
      },
      runCursor: async () => {
        throw new Error("Cursor must not run during retry recovery");
      },
    });
    assert.equal(outcome.http, 200);
    assert.deepEqual(enqueued, ["mf-retry-job"]);
    const after = await Run.findById(run._id);
    assert.equal(after.status, "running");
    assert.equal(after.currentNodeId, "implement");
    assert.equal((await TicketRun.findOne({ runId: String(run._id) })).state, "implementing");
  });

  test("engine stops the walk when the ticket was cancelled", async () => {
    const wf = await createPublishedWorkflow(
      [
        { id: "start", type: "delay", config: { seconds: 0 } },
        { id: "done", type: "delay", config: { seconds: 0 } },
      ],
      [{ from: "start", to: "done" }]
    );
    const jobId = "mf-cancel-walk";
    const run = await Run.create({
      workflowId: wf._id,
      jobId,
      status: "running",
      startedAt: new Date(),
      logs: [],
    });
    await ticketState.createLive({
      jiraKey: "MF-108",
      profileKey: "MF",
      runId: String(run._id),
      state: "cancelled",
      stage: "implementing",
    });

    const result = await engine.executeWorkflow(wf._id, {}, jobId);
    assert.equal(result.status, "cancelled");
    const success = (result.logs || []).filter((log) => log.status === "success");
    assert.equal(success.length, 0);
  });
});
