const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const config = require("../config");
const Run = require("../src/models/Run");
const nodes = require("../src/nodes");
const engine = require("../src/services/executionengine");
const {
  connectTestDb,
  disconnectTestDb,
  clearTestData,
  createPublishedWorkflow,
  poll,
} = require("../test-support/helpers");

function listenHeld() {
  const pending = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      pending.push({ res, body: Buffer.concat(chunks).toString("utf8") });
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        pending,
        url: `http://127.0.0.1:${port}`,
        reply(index, body) {
          const hit = pending[index];
          hit.res.writeHead(200, { "content-type": "application/json" });
          hit.res.end(JSON.stringify(body));
        },
        close() {
          for (const hit of pending) {
            if (!hit.res.writableEnded) hit.res.end();
          }
          if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
    server.on("error", reject);
  });
}

function snap(doc) {
  return {
    logs: JSON.parse(JSON.stringify(doc.logs || [])),
    context: doc.context === undefined ? null : JSON.parse(JSON.stringify(doc.context)),
    currentNodeId: doc.currentNodeId ?? null,
    status: doc.status,
    executionClaim: doc.executionClaim ?? null,
  };
}

describe("phase 1 execution lease and checkpoints", { concurrency: false }, () => {
  const originalExecuteNode = nodes.executeNode;
  const originalPersistRun = engine.persistRun;
  let previousLease;
  let previousTimeout;

  before(async () => {
    await connectTestDb();
  });

  after(async () => {
    nodes.executeNode = originalExecuteNode;
    engine.persistRun = originalPersistRun;
    if (previousLease !== undefined) config.executionClaimLeaseMs = previousLease;
    if (previousTimeout !== undefined) config.httpTimeoutMs = previousTimeout;
    await disconnectTestDb();
  });

  beforeEach(async () => {
    nodes.executeNode = originalExecuteNode;
    engine.persistRun = originalPersistRun;
    if (previousLease === undefined) previousLease = config.executionClaimLeaseMs;
    if (previousTimeout === undefined) previousTimeout = config.httpTimeoutMs;
    config.executionClaimLeaseMs = previousLease;
    config.httpTimeoutMs = previousTimeout;
    await clearTestData();
  });

  test("a repeated job id reloads the run and does not execute a saved success again", async () => {
    let calls = 0;
    nodes.executeNode = async () => {
      calls += 1;
      return { done: true };
    };
    const workflow = await createPublishedWorkflow([{ id: "S", type: "notify", config: {} }]);
    const jobId = "retry-success";
    await engine.executeWorkflow(workflow._id, { n: 1 }, jobId);
    await engine.executeWorkflow(workflow._id, { n: 1 }, jobId);
    assert.equal(calls, 1);
    assert.equal(await Run.countDocuments({ jobId }), 1);
    const row = await Run.findOne({ jobId });
    assert.equal(row.status, "success");
  });

  test("a failed checkpoint save leaves the pre-node row and redelivery runs the node again", async () => {
    let calls = 0;
    nodes.executeNode = async (_node, input) => {
      calls += 1;
      return { seen: input.marker };
    };
    let persists = 0;
    engine.persistRun = async (...args) => {
      persists += 1;
      if (persists === 2) throw new Error("checkpoint failed");
      return originalPersistRun.apply(engine, args);
    };
    const workflow = await createPublishedWorkflow([{ id: "S", type: "notify", config: {} }]);
    const jobId = "at-least-once";
    await assert.rejects(
      () => engine.executeWorkflow(workflow._id, { marker: "job" }, jobId),
      /checkpoint failed/
    );
    const midway = await Run.findOne({ jobId });
    assert.equal(midway.status, "running");
    assert.equal(midway.currentNodeId, "S");
    assert.deepEqual(midway.context, { marker: "job" });
    assert.equal(midway.logs.length, 0);
    assert.equal(calls, 1);
    assert.equal(await Run.countDocuments({ jobId }), 1);

    engine.persistRun = originalPersistRun;
    await Run.updateOne(
      { jobId },
      { $set: { executionClaimExpiresAt: new Date(0) } }
    );
    await engine.executeWorkflow(workflow._id, { marker: "job" }, jobId);
    assert.equal(calls, 2);
    const done = await Run.findOne({ jobId });
    assert.equal(done.status, "success");
    assert.deepEqual(done.context, { seen: "job" });
  });

  test("a saved success for A is not executed again when redelivery starts at B", async () => {
    const calls = [];
    nodes.executeNode = async (node) => {
      calls.push(node.id);
      return { from: node.id };
    };
    let persists = 0;
    engine.persistRun = async (...args) => {
      persists += 1;
      if (persists === 3) throw new Error("stop before B");
      return originalPersistRun.apply(engine, args);
    };
    const workflow = await createPublishedWorkflow(
      [
        { id: "A", type: "notify", config: {} },
        { id: "B", type: "notify", config: {} },
      ],
      [{ from: "A", to: "B" }]
    );
    const jobId = "checkpoint-held";
    await assert.rejects(
      () => engine.executeWorkflow(workflow._id, { marker: "job" }, jobId),
      /stop before B/
    );
    const midway = await Run.findOne({ jobId });
    assert.equal(midway.currentNodeId, "B");
    assert.deepEqual(midway.context, { from: "A" });
    assert.equal(midway.logs.length, 1);
    assert.equal(midway.logs[0].nodeId, "A");
    assert.deepEqual(calls, ["A"]);

    engine.persistRun = originalPersistRun;
    await Run.updateOne(
      { jobId },
      { $set: { executionClaimExpiresAt: new Date(0) } }
    );
    await engine.executeWorkflow(workflow._id, { marker: "job" }, jobId);
    assert.deepEqual(calls, ["A", "B"]);
    const done = await Run.findOne({ jobId });
    assert.equal(done.status, "success");
    assert.equal(done.currentNodeId, null);
  });

  test("the start cursor is stored before the first node runs", async () => {
    let snapshot = null;
    nodes.executeNode = async () => {
      snapshot = await Run.findOne({ jobId: "cursor-first" });
      return { ok: true };
    };
    const workflow = await createPublishedWorkflow([{ id: "S", type: "notify", config: {} }]);
    await engine.executeWorkflow(workflow._id, { hello: 1 }, "cursor-first");
    assert.equal(snapshot.currentNodeId, "S");
    assert.deepEqual(snapshot.context, { hello: 1 });
    assert.equal(snapshot.logs.length, 0);
  });

  test("overlapping execution leaves the owner checkpoint unchanged", async () => {
    const held = await listenHeld();
    const workflow = await createPublishedWorkflow([
      { id: "S", type: "http", config: { method: "GET", url: held.url } },
    ]);
    const jobId = "lease-overlap";
    const first = engine.executeWorkflow(workflow._id, { marker: "job" }, jobId);
    const rejectFirst = first.catch((err) => err);
    try {
      await poll(async () => {
        const row = await Run.findOne({ jobId });
        return row && row.executionClaim && row.currentNodeId === "S" ? row : null;
      });
      const before = snap(await Run.findOne({ jobId }));
      await assert.rejects(
        () => engine.executeWorkflow(workflow._id, { marker: "job" }, jobId),
        (err) => err.code === "RUN_CLAIM_BUSY"
      );
      assert.deepEqual(snap(await Run.findOne({ jobId })), before);
      assert.equal(await Run.countDocuments({ jobId }), 1);
      held.reply(0, { ok: true });
      const result = await rejectFirst;
      assert.equal(result && result.code, undefined);
    } finally {
      await held.close();
    }
  });

  test("a result that lands after the lease is lost is discarded", async () => {
    const previous = config.executionClaimLeaseMs;
    config.executionClaimLeaseMs = 60000;
    const held = await listenHeld();
    const workflow = await createPublishedWorkflow([
      { id: "S", type: "http", config: { method: "GET", url: held.url } },
    ]);
    const jobId = "lease-lost-after-node";
    const run = engine.executeWorkflow(workflow._id, { marker: "job" }, jobId);
    try {
      await poll(() => (held.pending.length >= 1 ? true : null));
      await Run.updateOne(
        { jobId },
        { $set: { executionClaimExpiresAt: new Date(0) } }
      );
      held.reply(0, { marker: "late" });
      await assert.rejects(run, (err) => err.code === "RUN_CLAIM_BUSY");
      const row = await Run.findOne({ jobId }).lean();
      assert.equal(row.logs.length, 0);
      assert.deepEqual(row.context, { marker: "job" });
      assert.equal(JSON.stringify(row).includes("late"), false);
    } finally {
      config.executionClaimLeaseMs = previous;
      await held.close();
    }
  });

  test("renewal keeps one HTTP node past the initial lease", { timeout: 20000 }, async () => {
    const previousLease = config.executionClaimLeaseMs;
    const previousTimeout = config.httpTimeoutMs;
    config.executionClaimLeaseMs = 200;
    config.httpTimeoutMs = 20000;
    const held = await listenHeld();
    const workflow = await createPublishedWorkflow([
      { id: "S", type: "http", config: { method: "GET", url: held.url } },
    ]);
    const jobId = "lease-lifetime-renew";
    const attempt = engine.executeWorkflow(workflow._id, { marker: "job" }, jobId);
    try {
      const opened = await poll(async () => {
        const row = await Run.findOne({ jobId }).lean();
        if (!row || !row.executionClaim || !row.executionClaimExpiresAt) return null;
        if (row.currentNodeId !== "S" || row.status !== "running") return null;
        if ((row.logs || []).length !== 0) return null;
        return row;
      });
      const token = opened.executionClaim;
      const firstExpiry = new Date(opened.executionClaimExpiresAt);
      const mark = Date.now();
      await poll(async () => {
        const row = await Run.findOne({ jobId }).lean();
        if (!row || row.executionClaim !== token) return null;
        if (row.status !== "running" || (row.logs || []).length !== 0) return null;
        if (!(new Date(row.executionClaimExpiresAt) > firstExpiry)) return null;
        if (Date.now() < mark + config.executionClaimLeaseMs) return null;
        return row;
      });
      held.reply(0, { marker: "renewed" });
      await attempt;
      const done = await Run.findOne({ jobId }).lean();
      assert.equal(done.status, "success");
      assert.deepEqual(done.context, { marker: "renewed" });
      assert.equal(done.logs.length, 1);
      assert.equal(done.logs[0].status, "success");
      assert.match(String(done.logs[0].output), /renewed/);
      assert.equal(done.executionClaim, token);
    } finally {
      config.executionClaimLeaseMs = previousLease;
      config.httpTimeoutMs = previousTimeout;
      await held.close();
    }
  });

  test("a failed renewal lets the next attempt own the row and the stale result is dropped", { timeout: 20000 }, async () => {
    const previousLease = config.executionClaimLeaseMs;
    const previousTimeout = config.httpTimeoutMs;
    config.executionClaimLeaseMs = 60000;
    config.httpTimeoutMs = 20000;
    const held = await listenHeld();
    const workflow = await createPublishedWorkflow([
      { id: "S", type: "http", config: { method: "GET", url: held.url } },
    ]);
    const jobId = "lease-lifetime-takeover";
    const input = { marker: "job" };
    const attemptA = engine.executeWorkflow(workflow._id, input, jobId);
    const settledA = attemptA.then(
      () => {
        throw new Error("attempt A resolved");
      },
      (err) => err
    );
    let attemptB;
    let settledB;
    try {
      await poll(() => (held.pending.length >= 1 ? true : null));
      const opened = await poll(async () => {
        const row = await Run.findOne({ jobId }).lean();
        return row && row.executionClaim && row.currentNodeId === "S" ? row : null;
      });
      const t1 = opened.executionClaim;
      const beforeRenew = await Run.findOne({ jobId }).lean();
      await Run.updateOne(
        { jobId },
        { $set: { executionClaimExpiresAt: new Date(0) } }
      );
      const renewed = await engine.renewExecutionClaim(opened._id, t1, 60000);
      assert.equal(renewed, null);
      const afterRenew = await Run.findOne({ jobId }).lean();
      assert.equal(afterRenew.executionClaim, t1);
      assert.equal(new Date(afterRenew.executionClaimExpiresAt).getTime(), 0);
      assert.equal((afterRenew.logs || []).length, 0);
      assert.deepEqual(afterRenew.context, beforeRenew.context);
      assert.equal(afterRenew.currentNodeId, beforeRenew.currentNodeId);
      assert.equal(afterRenew.status, beforeRenew.status);

      let responded = false;
      attemptB = engine.executeWorkflow(workflow._id, input, jobId);
      settledB = attemptB.then(
        (value) => value,
        (err) => err
      );
      const claimedByB = await poll(async () => {
        if (responded) throw new Error("response was sent before B claimed the row");
        const row = await Run.findOne({ jobId }).lean();
        if (!row || !row.executionClaim || row.executionClaim === t1) return null;
        if (!(new Date(row.executionClaimExpiresAt) > new Date(0))) return null;
        if (row.status !== "running" || (row.logs || []).length !== 0) return null;
        if (row.currentNodeId !== "S") return null;
        if (JSON.stringify(row.context) !== JSON.stringify(input)) return null;
        return row;
      });
      const t2 = claimedByB.executionClaim;
      assert.notEqual(t2, t1);

      await poll(() => (held.pending.length >= 2 ? true : null));
      responded = true;
      held.reply(1, { owner: "B" });
      await poll(async () => {
        const row = await Run.findOne({ jobId }).lean();
        if (!row || JSON.stringify(row.context) !== JSON.stringify({ owner: "B" })) return null;
        if (row.executionClaim !== t2 || (row.logs || []).length !== 1) return null;
        return row;
      });
      const committed = await Run.findOne({ jobId }).lean();
      const frozen = snap(committed);
      assert.equal(JSON.stringify(committed).includes('{"owner":"A"}'), false);

      held.reply(0, { owner: "A" });
      const errorA = await settledA;
      assert.equal(errorA.code, "RUN_CLAIM_BUSY");
      const afterA = snap(await Run.findOne({ jobId }).lean());
      assert.deepEqual(afterA, frozen);
      const errorB = await settledB;
      assert.equal(errorB && errorB.code, undefined);
    } finally {
      config.executionClaimLeaseMs = previousLease;
      config.httpTimeoutMs = previousTimeout;
      await held.close();
    }
  });

  test("persistRun rejects a stale token and an elapsed lease", async () => {
    const workflow = await createPublishedWorkflow([{ id: "n1", type: "notify", config: {} }]);
    const run = await Run.create({
      workflowId: workflow._id,
      jobId: "persist-stale",
      status: "running",
      logs: [],
      context: { v: 0 },
      currentNodeId: "n1",
      executionClaim: "T",
      executionClaimExpiresAt: new Date(0),
    });
    const patch = {
      context: { v: 1 },
      currentNodeId: null,
      status: "success",
      log: { nodeId: "n1", status: "success", output: "{\"v\":1}" },
    };
    assert.equal(await engine.persistRun(run._id, "T", patch), null);
    const elapsed = await Run.findById(run._id).lean();
    assert.deepEqual(elapsed.context, { v: 0 });
    assert.equal(elapsed.logs.length, 0);
    assert.equal(elapsed.currentNodeId, "n1");
    assert.equal(elapsed.status, "running");

    await Run.updateOne(
      { _id: run._id },
      {
        $set: {
          executionClaim: "OTHER",
          executionClaimExpiresAt: new Date(Date.now() + 60000),
        },
      }
    );
    assert.equal(await engine.persistRun(run._id, "T", patch), null);
    const wrongToken = await Run.findById(run._id).lean();
    assert.deepEqual(wrongToken.context, { v: 0 });
    assert.equal(wrongToken.executionClaim, "OTHER");

    await Run.updateOne(
      { _id: run._id },
      {
        $set: {
          executionClaim: "T",
          executionClaimExpiresAt: new Date(Date.now() + 60000),
          context: { v: 0 },
          currentNodeId: "n1",
          status: "running",
          logs: [],
        },
      }
    );
    const saved = await engine.persistRun(run._id, "T", patch);
    assert.ok(saved);
    assert.equal(saved.executionClaim, "T");
    assert.deepEqual(saved.context, { v: 1 });
    assert.equal(saved.currentNodeId, null);
    assert.equal(saved.status, "success");
    assert.equal(saved.logs.length, 1);
  });

  test("old runs without a cursor do not throw and do not trust truncated logs", async () => {
    const workflow = await createPublishedWorkflow([{ id: "S", type: "notify", config: {} }]);
    const seen = [];
    nodes.executeNode = async (_node, input) => {
      seen.push(input);
      return { echoed: input.marker };
    };

    await Run.collection.insertOne({
      workflowId: workflow._id,
      jobId: "old-success",
      status: "success",
      logs: [{ status: "success", output: "{\"truncated\":true}" }],
      startedAt: new Date(),
    });
    await engine.executeWorkflow(workflow._id, { marker: "job" }, "old-success");
    assert.equal(seen.length, 0);

    await Run.collection.insertOne({
      workflowId: workflow._id,
      jobId: "old-running",
      status: "running",
      logs: [{ status: "success", output: "{\"truncated\":true}" }],
      startedAt: new Date(),
    });
    await engine.executeWorkflow(workflow._id, { marker: "from-running" }, "old-running");

    await Run.collection.insertOne({
      workflowId: workflow._id,
      jobId: "old-failed",
      status: "failed",
      logs: [{ status: "success", output: "{\"truncated\":true}" }],
      startedAt: new Date(),
    });
    await engine.executeWorkflow(workflow._id, { marker: "from-failed" }, "old-failed");

    assert.deepEqual(
      seen.map((item) => item.marker),
      ["from-running", "from-failed"]
    );
    const running = await Run.findOne({ jobId: "old-running" }).lean();
    const failed = await Run.findOne({ jobId: "old-failed" }).lean();
    assert.equal(running.status, "success");
    assert.deepEqual(running.context, { echoed: "from-running" });
    assert.equal(failed.status, "success");
    assert.deepEqual(failed.context, { echoed: "from-failed" });
  });
});
