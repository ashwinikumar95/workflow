const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, test } = require("node:test");
const { DelayedError } = require("bullmq");
const config = require("../config");
const { parsePositiveInt } = require("../config");
const { validateWorkflowGraph } = require("../src/utils/workflowGraph");
const { executeNode } = require("../src/nodes");
const {
  getNextNode,
  carryForward,
  buildExecutionClaimRenewEveryMs,
} = require("../src/services/executionengine");
const {
  buildWorkflowWorkerOptions,
  handleWorkflowJob,
  isFinalAttempt,
} = require("../src/workers/worker");
const engine = require("../src/services/executionengine");

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close() {
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

describe("phase 1 config, graph, nodes, and worker options", () => {
  test("parsePositiveInt accepts only a base-10 integer greater than zero", () => {
    assert.equal(parsePositiveInt("0", 7), 7);
    assert.equal(parsePositiveInt("-1", 7), 7);
    assert.equal(parsePositiveInt("", 7), 7);
    assert.equal(parsePositiveInt("nope", 7), 7);
    assert.equal(parsePositiveInt("15.5", 7), 7);
    assert.equal(parsePositiveInt("15000", 7), 15000);
    assert.equal(parsePositiveInt(" 30000 ", 7), 30000);
  });

  test("cycle detection covers every component and accepts a line and a split", () => {
    const connected = validateWorkflowGraph({
      nodes: [{ id: "S" }, { id: "A" }, { id: "B" }],
      edges: [
        { from: "S", to: "A" },
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    });
    const disconnected = validateWorkflowGraph({
      nodes: [{ id: "S" }, { id: "A" }, { id: "B" }, { id: "C" }],
      edges: [
        { from: "S", to: "A" },
        { from: "B", to: "C" },
        { from: "C", to: "B" },
      ],
    });
    assert.equal(connected.ok, false);
    assert.equal(disconnected.ok, false);
    assert.equal(connected.message, disconnected.message);
    assert.match(connected.message, /cycle/);

    const line = validateWorkflowGraph({
      nodes: [{ id: "S" }, { id: "A" }],
      edges: [{ from: "S", to: "A" }],
    });
    const split = validateWorkflowGraph({
      nodes: [{ id: "S" }, { id: "T" }, { id: "F" }],
      edges: [
        { from: "S", to: "T", condition: "true" },
        { from: "S", to: "F", condition: "false" },
      ],
    });
    assert.deepEqual(line, { ok: true });
    assert.deepEqual(split, { ok: true });
  });

  test("condition, delay, and notify keep their current results", async () => {
    const previousSlack = config.slackWebhookUrl;
    config.slackWebhookUrl = undefined;
    try {
      assert.equal(
        await executeNode(
          {
            id: "c",
            type: "condition",
            config: { field: "ok", operator: "equals", value: true },
          },
          { ok: true }
        ),
        true
      );
      assert.equal(
        await executeNode(
          {
            id: "c",
            type: "condition",
            config: { field: "ok", operator: "equals", value: true },
          },
          { ok: false }
        ),
        false
      );
      const input = { keep: true };
      assert.equal(
        await executeNode({ id: "d", type: "delay", config: { seconds: 0 } }, input),
        input
      );
      const notified = await executeNode(
        { id: "n", type: "notify", config: { message: "hi" } },
        { keep: true }
      );
      assert.equal(notified.keep, true);
      assert.equal(notified._notifySkipped, true);
    } finally {
      config.slackWebhookUrl = previousSlack;
    }
  });

  test("carryForward keeps ticket fields when a condition returns boolean false", () => {
    const previous = { issueKey: "MFC-10142", jira: { key: "MFC-10142" }, branch: "false" };
    const next = carryForward(previous, false);
    assert.equal(next.issueKey, "MFC-10142");
    assert.equal(next.jira.key, "MFC-10142");
    assert.equal(next.branch, "false");
    const objectOut = carryForward(previous, { issueKey: "MF-1", branch: "true" });
    assert.equal(objectOut.issueKey, "MF-1");
  });

  test("preview keeps ticket, branch, and reason instead of truncated jira JSON", () => {
    const text = engine.preview({
      issueKey: "MFC-10142",
      jira: {
        key: "MFC-10142",
        summary: "Options & Params - Migrate Central Vue3 codebase from Options API to Composition API",
        descriptionText: "D".repeat(4000),
      },
      branch: "false",
      reason: "plan-dirty",
    });
    const parsed = JSON.parse(text);
    assert.equal(parsed.issueKey, "MFC-10142");
    assert.equal(parsed.branch, "false");
    assert.equal(parsed.reason, "plan-dirty");
    assert.match(parsed.summary, /Options/);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, "jira"), false);
    assert.ok(text.length <= 200);
  });

  test("getNextNode keeps boolean edges and requires branch on objects", () => {
    const workflow = {
      nodes: [{ id: "S" }, { id: "T" }, { id: "F" }, { id: "Only" }],
      edges: [
        { from: "S", to: "T", condition: "true" },
        { from: "S", to: "F", condition: "false" },
        { from: "Only", to: "T" },
      ],
    };
    assert.equal(getNextNode(workflow, { id: "S" }, true).id, "T");
    assert.equal(getNextNode(workflow, { id: "S" }, false).id, "F");
    assert.equal(getNextNode(workflow, { id: "S" }, { branch: "true" }).id, "T");
    assert.equal(getNextNode(workflow, { id: "S" }, { branch: "false" }).id, "F");
    assert.equal(getNextNode(workflow, { id: "Only" }, { marker: 1 }).id, "T");
    assert.throws(() => getNextNode(workflow, { id: "S" }, { marker: 1 }));
    assert.throws(() => getNextNode(workflow, { id: "S" }, { branch: "other" }));
  });

  test("live HTTP timeout rejects a hanging server and a 200 still returns the body", async () => {
    const previous = config.httpTimeoutMs;
    const hanging = await listen(() => {});
    const fast = await listen((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            header: req.headers["x-test"],
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      });
    });
    try {
      config.httpTimeoutMs = 300;
      await assert.rejects(
        () =>
          executeNode(
            { id: "h", type: "http", config: { method: "GET", url: hanging.url } },
            {}
          ),
        (err) => err.code === "ECONNABORTED"
      );
      const data = await executeNode(
        {
          id: "ok",
          type: "http",
          config: {
            method: "POST",
            url: fast.url,
            headers: { "X-Test": "yes" },
            body: { sent: true },
          },
        },
        {}
      );
      assert.equal(data.method, "POST");
      assert.equal(data.header, "yes");
      assert.equal(data.body, JSON.stringify({ sent: true }));
    } finally {
      config.httpTimeoutMs = previous;
      await hanging.close();
      await fast.close();
    }
  });

  test("worker lock options and claim renew interval refuse a zero half", () => {
    const options = buildWorkflowWorkerOptions(30000);
    assert.equal(options.lockDuration, 30000);
    assert.equal(options.concurrency, 1);
    assert.equal(options.lockRenewTime, 15000);
    assert.ok(options.lockRenewTime > 0 && options.lockRenewTime < options.lockDuration);
    assert.throws(() => buildWorkflowWorkerOptions(1));
    const previous = config.workerLockDurationMs;
    config.workerLockDurationMs = 1;
    try {
      assert.throws(() => buildWorkflowWorkerOptions(config.workerLockDurationMs));
    } finally {
      config.workerLockDurationMs = previous;
    }
    assert.equal(buildExecutionClaimRenewEveryMs(30000), 15000);
    assert.throws(() => buildExecutionClaimRenewEveryMs(1));
  });

  test("RUN_CLAIM_BUSY moves the job to delayed and throws DelayedError", async () => {
    const original = engine.executeWorkflow;
    engine.executeWorkflow = async () => {
      const err = new Error("RUN_CLAIM_BUSY");
      err.code = "RUN_CLAIM_BUSY";
      throw err;
    };
    let delayedAt = null;
    let delayedToken = null;
    const job = {
      id: "job-1",
      data: { workflowId: "wf", input: { a: 1 } },
      async moveToDelayed(when, token) {
        delayedAt = when;
        delayedToken = token;
      },
    };
    try {
      await assert.rejects(
        () => handleWorkflowJob(job, "lock-token"),
        (err) => err instanceof DelayedError
      );
      assert.equal(typeof delayedAt, "number");
      assert.equal(delayedToken, "lock-token");
    } finally {
      engine.executeWorkflow = original;
    }
  });

  test("isFinalAttempt is true only on the last BullMQ attempt", () => {
    assert.equal(isFinalAttempt({ opts: { attempts: 3 }, attemptsMade: 1 }), false);
    assert.equal(isFinalAttempt({ opts: { attempts: 3 }, attemptsMade: 2 }), false);
    assert.equal(isFinalAttempt({ opts: { attempts: 3 }, attemptsMade: 3 }), true);
    assert.equal(isFinalAttempt({ attemptsMade: 1 }), true);
  });
});
