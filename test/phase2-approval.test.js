const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const config = require("../config");
const Run = require("../src/models/Run");
const Workflow = require("../src/models/workflow");
const nodes = require("../src/nodes");
const engine = require("../src/services/executionengine");
const { recordDecision } = require("../src/services/approvalService");
const {
  settleWait,
  enqueuePendingResumes,
  setResumeEnqueue,
} = require("../src/services/waitCompletion");
const { decideRun } = require("../src/controllers/RunController");
const {
  connectTestDb,
  disconnectTestDb,
  clearTestData,
  createPublishedWorkflow,
} = require("../test-support/helpers");

function approvalGraph() {
  return {
    nodes: [
      { id: "start", type: "delay", config: { seconds: 0 } },
      { id: "approve", type: "approval", config: { title: "Review" } },
      { id: "yes", type: "delay", config: { seconds: 0 } },
      { id: "no", type: "delay", config: { seconds: 0 } },
    ],
    edges: [
      { from: "start", to: "approve" },
      { from: "approve", to: "yes", condition: "true" },
      { from: "approve", to: "no", condition: "false" },
    ],
  };
}

function twoApprovalGraph() {
  return {
    nodes: [
      { id: "a1", type: "approval", config: { title: "First" } },
      { id: "a2", type: "approval", config: { title: "Second" } },
      { id: "done", type: "delay", config: { seconds: 0 } },
      { id: "no1", type: "delay", config: { seconds: 0 } },
      { id: "no2", type: "delay", config: { seconds: 0 } },
    ],
    edges: [
      { from: "a1", to: "a2", condition: "true" },
      { from: "a1", to: "no1", condition: "false" },
      { from: "a2", to: "done", condition: "true" },
      { from: "a2", to: "no2", condition: "false" },
    ],
  };
}

function successNodes(run) {
  return (run.logs || []).filter((log) => log.status === "success").map((log) => log.nodeId);
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function decide(runId, userId, decision) {
  const res = mockRes();
  await decideRun(
    { params: { runId: String(runId) }, body: { decision }, user: { id: String(userId) } },
    res
  );
  return res;
}

describe("phase 2 human approval", () => {
  let enqueued;

  before(async () => {
    await connectTestDb();
  });

  after(async () => {
    setResumeEnqueue(null);
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestData();
    enqueued = [];
    setResumeEnqueue(async (run) => {
      enqueued.push(run.pendingResume.resumeJobId);
    });
  });

  test("approval pauses, survives redelivery, and resumes from the saved node", async () => {
    const graph = approvalGraph();
    const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
    const jobId = "approval-job";
    const input = { ticket: "T-1" };

    const waiting = await engine.executeWorkflow(wf._id, input, jobId);
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.currentNodeId, "approve");
    assert.equal(waiting.context.ticket, "T-1");
    assert.equal(waiting.executionClaim, null);
    assert.equal(waiting.executionClaimExpiresAt, null);
    assert.equal(waiting.wait.kind, "approval");
    assert.equal(waiting.wait.state, "pending");
    assert.equal(waiting.wait.externalJobId, `approval-${waiting._id}-approve`);
    assert.equal(waiting.wait.resumeJobId, `resume-approval-${waiting._id}-approve`);
    assert.equal(successNodes(waiting).filter((id) => id === "start").length, 1);

    let nodeCalls = 0;
    let claimCalls = 0;
    const originalNode = nodes.executeNode;
    const originalClaim = engine.acquireExecutionClaim;
    nodes.executeNode = async (...args) => {
      nodeCalls += 1;
      return originalNode(...args);
    };
    engine.acquireExecutionClaim = async (...args) => {
      claimCalls += 1;
      return originalClaim(...args);
    };
    try {
      const again = await engine.executeWorkflow(wf._id, input, jobId);
      assert.equal(again.status, "waiting");
      assert.equal(nodeCalls, 0);
      assert.equal(claimCalls, 0);
      assert.equal(enqueued.length, 0);
    } finally {
      nodes.executeNode = originalNode;
      engine.acquireExecutionClaim = originalClaim;
    }

    const owner = new mongoose.Types.ObjectId();
    await Workflow.updateOne({ _id: wf._id }, { $set: { userId: owner } });
    const decision = await decide(waiting._id, owner, "approved");
    assert.equal(decision.statusCode, 200);
    assert.deepEqual(enqueued, [`resume-approval-${waiting._id}-approve`]);

    const finished = await engine.resumeWorkflow(
      { runId: String(waiting._id), workflowId: String(wf._id) },
      waiting.wait.resumeJobId
    );
    const reloaded = await Run.findById(waiting._id).lean();
    assert.equal(finished.status, "success");
    assert.equal(reloaded.status, "success");
    assert.equal(successNodes(reloaded).filter((id) => id === "start").length, 1);
    assert.ok(successNodes(reloaded).includes("yes"));
    assert.equal(successNodes(reloaded).includes("no"), false);
    assert.equal(reloaded.currentNodeId, null);
  });

  test("rejection follows the false edge and does not open later lifecycle side effects", async () => {
    const graph = approvalGraph();
    const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
    const owner = new mongoose.Types.ObjectId();
    await Workflow.updateOne({ _id: wf._id }, { $set: { userId: owner } });
    const waiting = await engine.executeWorkflow(wf._id, { ticket: "T-2" }, "reject-job");
    const decision = await decide(waiting._id, owner, "rejected");
    assert.equal(decision.statusCode, 200);

    const stored = await Run.findById(waiting._id).lean();
    assert.equal(stored.approval.decision, "rejected");
    assert.equal(stored.context.branch, "false");

    const finished = await engine.resumeWorkflow(
      { runId: String(waiting._id) },
      waiting.wait.resumeJobId
    );
    const reloaded = await Run.findById(waiting._id).lean();
    assert.equal(finished.status, "success");
    assert.ok(successNodes(reloaded).includes("no"));
    assert.equal(successNodes(reloaded).includes("yes"), false);
    assert.equal(reloaded.external, undefined);
    assert.ok(enqueued.every((id) => id.startsWith("resume-approval-")));
    assert.equal(enqueued.some((id) => id.includes("agent")), false);
  });

  test("a non-owner decision is forbidden and does not enqueue resume", async () => {
    const graph = approvalGraph();
    const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    await Workflow.updateOne({ _id: wf._id }, { $set: { userId: owner } });
    const waiting = await engine.executeWorkflow(wf._id, { ticket: "T-3" }, "unauth-job");

    const denied = await decide(waiting._id, stranger, "approved");
    assert.equal(denied.statusCode, 403);
    assert.equal(enqueued.length, 0);
    const reloaded = await Run.findById(waiting._id).lean();
    assert.equal(reloaded.status, "waiting");
    assert.equal(reloaded.approval, null);
    assert.equal(reloaded.wait.state, "pending");
  });

  test("overlapping approve and reject produce one winner and one resume job", async () => {
    const graph = approvalGraph();
    const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
    const owner = new mongoose.Types.ObjectId();
    await Workflow.updateOne({ _id: wf._id }, { $set: { userId: owner } });
    const waiting = await engine.executeWorkflow(wf._id, { ticket: "T-4" }, "race-job");

    const [approved, rejected] = await Promise.all([
      decide(waiting._id, owner, "approved"),
      decide(waiting._id, owner, "rejected"),
    ]);
    const codes = [approved.statusCode, rejected.statusCode].sort();
    assert.deepEqual(codes, [200, 409]);
    const winner = approved.statusCode === 200 ? "approved" : "rejected";
    const stored = await Run.findById(waiting._id).lean();
    assert.equal(stored.approval.decision, winner);
    assert.deepEqual(enqueued, [`resume-approval-${waiting._id}-approve`]);
  });

  test("a repeated decision returns 409 and does not enqueue again", async () => {
    const graph = approvalGraph();
    const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
    const owner = new mongoose.Types.ObjectId();
    await Workflow.updateOne({ _id: wf._id }, { $set: { userId: owner } });
    const waiting = await engine.executeWorkflow(wf._id, { ticket: "T-5" }, "repeat-job");

    const first = await decide(waiting._id, owner, "approved");
    assert.equal(first.statusCode, 200);
    const same = await decide(waiting._id, owner, "approved");
    const opposite = await decide(waiting._id, owner, "rejected");
    assert.equal(same.statusCode, 409);
    assert.equal(opposite.statusCode, 409);
    assert.deepEqual(enqueued, [`resume-approval-${waiting._id}-approve`]);
    const stored = await Run.findById(waiting._id).lean();
    assert.equal(stored.approval.decision, "approved");
  });

  test("waiting releases the claim so resume can continue immediately", async () => {
    const previous = config.executionClaimLeaseMs;
    config.executionClaimLeaseMs = 60000;
    try {
      const graph = approvalGraph();
      const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
      const owner = new mongoose.Types.ObjectId();
      await Workflow.updateOne({ _id: wf._id }, { $set: { userId: owner } });
      const waiting = await engine.executeWorkflow(wf._id, { ticket: "T-6" }, "immediate-job");
      const reloaded = await Run.findById(waiting._id).lean();
      assert.equal(reloaded.status, "waiting");
      assert.equal(reloaded.executionClaim, null);
      assert.equal(reloaded.executionClaimExpiresAt, null);

      const started = Date.now();
      const decision = await decide(waiting._id, owner, "approved");
      assert.equal(decision.statusCode, 200);
      const finished = await engine.resumeWorkflow(
        { runId: String(waiting._id) },
        waiting.wait.resumeJobId
      );
      assert.ok(Date.now() - started < 5000);
      assert.equal(finished.status, "success");
      assert.notEqual(finished.executionClaim, null);
      assert.ok(successNodes(finished).includes("yes"));
      assert.equal(successNodes(finished).filter((id) => id === "start").length, 1);

      const seeded = await Run.create({
        workflowId: wf._id,
        jobId: "stale-wait-claim",
        status: "running",
        executionClaim: "owner-token",
        executionClaimExpiresAt: new Date(Date.now() + 120000),
        currentNodeId: "approve",
        context: { v: 1 },
        logs: [],
      });
      const wrongToken = await engine.persistWaitingRun(seeded._id, "other-token", {
        context: { v: 2 },
        currentNodeId: "approve",
        wait: {
          kind: "approval",
          nodeId: "approve",
          state: "pending",
          externalJobId: "approval-x-approve",
          resumeJobId: "resume-approval-x-approve",
        },
      });
      assert.equal(wrongToken, null);
      let kept = await Run.findById(seeded._id).lean();
      assert.equal(kept.executionClaim, "owner-token");
      assert.equal(kept.status, "running");
      assert.deepEqual(kept.context, { v: 1 });

      await Run.updateOne({ _id: seeded._id }, { $set: { executionClaimExpiresAt: new Date(0) } });
      const expired = await engine.persistWaitingRun(seeded._id, "owner-token", {
        context: { v: 2 },
        currentNodeId: "approve",
        wait: {
          kind: "approval",
          nodeId: "approve",
          state: "pending",
          externalJobId: "approval-x-approve",
          resumeJobId: "resume-approval-x-approve",
        },
      });
      assert.equal(expired, null);
      kept = await Run.findById(seeded._id).lean();
      assert.equal(kept.executionClaim, "owner-token");
      assert.equal(new Date(kept.executionClaimExpiresAt).getTime(), 0);
      assert.equal(kept.status, "running");
      assert.deepEqual(kept.context, { v: 1 });
    } finally {
      config.executionClaimLeaseMs = previous;
    }
  });

  test("duplicate, late, and out-of-order approval completions do not walk twice", async () => {
    const graph = approvalGraph();
    const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
    const waiting = await engine.executeWorkflow(wf._id, { ticket: "T-7" }, "dup-job");
    const args = {
      runId: waiting._id,
      kind: "approval",
      nodeId: waiting.wait.nodeId,
      externalJobId: waiting.wait.externalJobId,
      result: { decision: "approved", branch: "true" },
      approval: { decision: "approved", userId: "user-1", branch: "true" },
    };

    const before = await Run.findById(waiting._id).lean();
    await settleWait({ ...args, nodeId: "other-node", externalJobId: "approval-nope" });
    const untouched = await Run.findById(waiting._id).lean();
    assert.deepEqual(untouched.wait, before.wait);
    assert.equal(untouched.status, before.status);
    assert.deepEqual(untouched.context, before.context);
    assert.equal(untouched.currentNodeId, before.currentNodeId);
    assert.equal(enqueued.length, 0);

    const first = await settleWait(args);
    assert.equal(first.matched, true);
    const settled = await Run.findById(waiting._id).lean();
    const completion = settled.wait.completion;
    const second = await settleWait(args);
    assert.equal(second.matched, false);
    const afterSecond = await Run.findById(waiting._id).lean();
    assert.deepEqual(afterSecond.wait.completion, completion);
    assert.deepEqual(enqueued, [waiting.wait.resumeJobId]);

    const begun = await engine.beginResume(waiting._id, waiting.wait.resumeJobId, 30000);
    assert.ok(begun);
    assert.equal(begun.wait.state, "resumed");
    const snap = await Run.findById(waiting._id).lean();
    await settleWait(args);
    const later = await Run.findById(waiting._id).lean();
    assert.equal(later.status, snap.status);
    assert.deepEqual(later.context, snap.context);
    assert.equal(later.currentNodeId, snap.currentNodeId);
    assert.deepEqual(enqueued, [waiting.wait.resumeJobId]);
  });

  test("a crash before resume enqueue is repaired once", async () => {
    const graph = approvalGraph();
    const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
    const owner = new mongoose.Types.ObjectId();
    await Workflow.updateOne({ _id: wf._id }, { $set: { userId: owner } });
    const waiting = await engine.executeWorkflow(wf._id, { ticket: "T-8" }, "crash-job");

    setResumeEnqueue(async () => {
      throw new Error("redis down");
    });
    const failed = await decide(waiting._id, owner, "approved");
    assert.equal(failed.statusCode, 503);
    const mid = await Run.findById(waiting._id).lean();
    assert.equal(mid.approval.decision, "approved");
    assert.equal(mid.wait.state, "completing");
    assert.equal(mid.pendingResume.enqueuedAt, null);
    assert.equal(mid.pendingResume.resumeJobId, `resume-approval-${waiting._id}-approve`);

    const repeat = await decide(waiting._id, owner, "rejected");
    assert.equal(repeat.statusCode, 409);
    const still = await Run.findById(waiting._id).lean();
    assert.equal(still.approval.decision, "approved");

    setResumeEnqueue(async (run) => {
      enqueued.push(run.pendingResume.resumeJobId);
    });
    await enqueuePendingResumes();
    assert.deepEqual(enqueued, [mid.pendingResume.resumeJobId]);

    const finished = await engine.resumeWorkflow(
      { runId: String(waiting._id) },
      mid.pendingResume.resumeJobId
    );
    assert.equal(finished.status, "success");
    const logs = JSON.stringify((await Run.findById(waiting._id).lean()).logs);
    const second = await engine.resumeWorkflow(
      { runId: String(waiting._id) },
      mid.pendingResume.resumeJobId
    );
    assert.equal(second.status, "success");
    const after = await Run.findById(waiting._id).lean();
    assert.equal(JSON.stringify(after.logs), logs);
    assert.ok(successNodes(after).includes("yes"));
    assert.equal(successNodes(after).includes("no"), false);
  });

  test("two approval nodes keep separate wait ids", async () => {
    const graph = twoApprovalGraph();
    const wf = await createPublishedWorkflow(graph.nodes, graph.edges);
    const owner = new mongoose.Types.ObjectId();
    await Workflow.updateOne({ _id: wf._id }, { $set: { userId: owner } });
    const firstWait = await engine.executeWorkflow(wf._id, { ticket: "T-9" }, "two-job");
    assert.equal(firstWait.wait.nodeId, "a1");
    assert.equal(firstWait.wait.state, "pending");
    const firstExternal = firstWait.wait.externalJobId;
    const firstResume = firstWait.wait.resumeJobId;

    const decision = await decide(firstWait._id, owner, "approved");
    assert.equal(decision.statusCode, 200);
    const secondWait = await engine.resumeWorkflow(
      { runId: String(firstWait._id) },
      firstResume
    );
    assert.equal(secondWait.status, "waiting");
    assert.equal(secondWait.wait.nodeId, "a2");
    assert.equal(secondWait.wait.state, "pending");
    assert.notEqual(secondWait.wait.externalJobId, firstExternal);
    assert.notEqual(secondWait.wait.resumeJobId, firstResume);
    assert.equal(secondWait.wait.externalJobId, `approval-${firstWait._id}-a2`);
    assert.equal(secondWait.wait.resumeJobId, `resume-approval-${firstWait._id}-a2`);

    const before = await Run.findById(firstWait._id).lean();
    await settleWait({
      runId: firstWait._id,
      kind: "approval",
      nodeId: "a1",
      externalJobId: firstExternal,
      result: { decision: "approved", branch: "true" },
      approval: { decision: "approved", userId: String(owner), branch: "true" },
    });
    const after = await Run.findById(firstWait._id).lean();
    assert.equal(after.wait.state, "pending");
    assert.equal(after.wait.nodeId, "a2");
    assert.equal(after.wait.externalJobId, before.wait.externalJobId);
    assert.equal(after.status, "waiting");
    assert.equal(after.currentNodeId, "a2");
    assert.deepEqual(enqueued, [firstResume]);
  });
});
