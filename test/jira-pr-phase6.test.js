const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const config = require("../config");
const Run = require("../src/models/Run");
const nodes = require("../src/nodes");
const engine = require("../src/services/executionengine");
const slack = require("../src/services/slackService");
const { executeNode } = require("../src/nodes");
const {
  connectTestDb,
  disconnectTestDb,
  clearTestData,
  createPublishedWorkflow,
} = require("../test-support/helpers");

const WEBHOOK = "https://hooks.slack.test/phase6";
const SECRET = "super-secret-phase6-value";

function captureSender(options = {}) {
  const posts = [];
  let remainingFailures = Number(options.failures) || 0;
  slack.setSender(async (url, payload) => {
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error("slack down");
    }
    posts.push({ url, payload });
  });
  return posts;
}

async function makeRun(overrides = {}) {
  return Run.create({
    jobId: overrides.jobId || new mongoose.Types.ObjectId().toString(),
    workflowId: overrides.workflowId || new mongoose.Types.ObjectId(),
    status: overrides.status || "running",
    context: overrides.context || {
      issueKey: "MF-123",
      profileKey: "MF",
      jira: { key: "MF-123", summary: "Fix the form" },
    },
    startedAt: new Date(),
  });
}

describe("jira-pr phase 6 slack events", () => {
  const previousWebhook = config.slackWebhookUrl;
  const previousGithub = process.env.GITHUB_TOKEN;
  const originalExecuteNode = nodes.executeNode;

  before(async () => {
    await connectTestDb();
  });

  after(async () => {
    slack.setSender(null);
    config.slackWebhookUrl = previousWebhook;
    process.env.SLACK_WEBHOOK_URL = "";
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithub;
    nodes.executeNode = originalExecuteNode;
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestData();
    slack.setSender(null);
    config.slackWebhookUrl = WEBHOOK;
    process.env.SLACK_WEBHOOK_URL = WEBHOOK;
    process.env.GITHUB_TOKEN = SECRET;
    nodes.executeNode = originalExecuteNode;
  });

  test("one message per event even when two components emit it", async () => {
    const posts = captureSender();
    const run = await makeRun();
    const first = await slack.emit(run._id, "crashed", { reason: "worker exploded" });
    const second = await slack.emit(run._id, "crashed", { reason: "worker exploded" });
    await slack.emitFromJob(
      { id: run.jobId, data: { workflowId: run.workflowId } },
      new Error("worker exploded")
    );
    assert.equal(first.status, "sent");
    assert.equal(second.duplicate, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, WEBHOOK);
    assert.match(posts[0].payload.text, /\[crashed\]/);
    assert.match(posts[0].payload.text, /MF-123/);
    assert.match(posts[0].payload.text, /Run:/);
    const stored = await Run.findById(run._id).lean();
    assert.equal(stored.notifications.crashed.status, "sent");
    assert.deepEqual(stored.notificationPending || [], []);
  });

  test("engine failure and worker failed event share the crashed id", async () => {
    const posts = captureSender();
    nodes.executeNode = async () => {
      throw new Error("worker exploded");
    };
    const workflow = await createPublishedWorkflow([{ id: "S", type: "notify", config: {} }]);
    const jobId = "phase6-crash";
    await assert.rejects(() => engine.executeWorkflow(workflow._id, { n: 1 }, jobId), /worker exploded/);
    const run = await Run.findOne({ jobId });
    assert.equal(run.status, "failed");
    const again = await slack.emitFromJob(
      { id: jobId, data: { workflowId: workflow._id } },
      new Error("worker exploded")
    );
    assert.equal(again.duplicate, true);
    assert.equal(posts.length, 1);
    assert.equal(run.notifications.crashed.status, "sent");
  });

  test("a failed send is retried once by retryPending", async () => {
    const posts = captureSender({ failures: 1 });
    const run = await makeRun();
    const first = await slack.emit(run._id, "cancelled", { reason: "cancelled" });
    assert.equal(first.status, "failed");
    assert.equal(posts.length, 0);
    const pending = await Run.findById(run._id).lean();
    assert.equal(pending.notifications.cancelled.status, "failed");
    assert.deepEqual(pending.notificationPending, ["cancelled"]);

    const retried = await slack.retryPending();
    assert.equal(retried.length, 1);
    assert.equal(retried[0].status, "sent");
    assert.equal(posts.length, 1);
    assert.match(posts[0].payload.text, /\[cancelled\]/);
    const stored = await Run.findById(run._id).lean();
    assert.equal(stored.notifications.cancelled.status, "sent");
    assert.deepEqual(stored.notificationPending || [], []);
  });

  test("no webhook logs the event and the run continues", async () => {
    config.slackWebhookUrl = undefined;
    const posts = captureSender();
    const workflow = await createPublishedWorkflow([
      { id: "S", type: "notify", config: { message: "hello" } },
    ]);
    const jobId = "phase6-skip";
    const run = await engine.executeWorkflow(workflow._id, { keep: true }, jobId);
    assert.equal(run.status, "success");
    assert.equal(run.context._notifySkipped, true);
    assert.equal(run.context.keep, true);
    assert.equal(posts.length, 0);
    const stored = await Run.findById(run._id).lean();
    const note = stored.notifications && stored.notifications.notify_S;
    assert.ok(note);
    assert.equal(note.status, "logged");
    assert.match(note.text, /hello/);
  });

  test("secrets are redacted from the Slack payload and the stored event", async () => {
    const posts = captureSender();
    const run = await makeRun();
    await slack.emit(run._id, "crashed", {
      reason: `boom token=${SECRET} url=${WEBHOOK}`,
    });
    assert.equal(posts.length, 1);
    const text = posts[0].payload.text;
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(WEBHOOK), false);
    assert.match(text, /\[redacted\]/);
    const stored = await Run.findById(run._id).lean();
    const blob = JSON.stringify(stored.notifications);
    assert.equal(blob.includes(SECRET), false);
    assert.equal(blob.includes(WEBHOOK), false);
  });

  test("approval wait emits waiting_for_approval once", async () => {
    const posts = captureSender();
    const workflow = await createPublishedWorkflow(
      [{ id: "approve", type: "approval", config: { title: "Review" } }],
      []
    );
    const jobId = "phase6-wait";
    const run = await engine.executeWorkflow(workflow._id, { issueKey: "MF-123", profileKey: "MF" }, jobId);
    assert.equal(run.status, "waiting");
    const eventId = slack.eventIdFor("waiting_for_approval", { nodeId: "approve" });
    assert.equal(posts.length, 1);
    assert.match(posts[0].payload.text, /\[waiting_for_approval\]/);
    const stored = await Run.findById(run._id).lean();
    assert.equal(stored.notifications[eventId].status, "sent");

    await slack.emit(run._id, "waiting_for_approval", {
      nodeId: "approve",
      reason: "waiting for approval",
    });
    assert.equal(posts.length, 1);
  });

  test("notify node uses emit and does not fail the run when Slack is down", async () => {
    captureSender({ failures: 99 });
    const created = await makeRun();
    const result = await executeNode(
      { id: "n", type: "notify", config: { message: "hi {{keep}}", eventType: "pr_created" } },
      { keep: true, prUrl: "https://github.com/example/pr/1" },
      { runId: String(created._id) }
    );
    assert.equal(result.keep, true);
    assert.equal(result._notifySkipped, undefined);
    const run = await Run.findById(created._id).lean();
    assert.equal(run.notifications.pr_created.status, "failed");
  });
});
