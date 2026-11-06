const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const Workflow = require("../src/models/workflow");
const Run = require("../src/models/Run");
const TicketRun = require("../src/models/TicketRun");
const ResourceLock = require("../src/models/ResourceLock");
const jira = require("../src/services/jiraService");
const dispatcher = require("../src/services/jiraDispatcher");
const lifecycle = require("../src/nodes/lifecycle");
const engine = require("../src/services/executionengine");
const { parseProfiles, resolveProfile } = require("../src/services/projectRegistry");
const {
  connectTestDb,
  disconnectTestDb,
  clearTestData,
} = require("../test-support/helpers");

const PREV_BASE = process.env.JIRA_BASE_URL;
const PREV_EMAIL = process.env.JIRA_EMAIL;
const PREV_TOKEN = process.env.JIRA_API_TOKEN;

function issuePayload(key, extra = {}) {
  const description = Object.prototype.hasOwnProperty.call(extra, "description")
    ? extra.description
    : "Acceptance: user can complete the flow.";
  return {
    id: extra.id || String(10000 + Number(String(key).replace(/\D/g, "") || 1)),
    key,
    fields: {
      summary: extra.summary ?? `Work ${key}`,
      description,
      status: { name: extra.status || "To Do" },
      issuetype: { name: extra.issueType || "Story" },
      labels: extra.labels || [],
      components: extra.components || [{ name: "UI" }],
      updated: extra.updated || "2026-11-06T00:00:00.000Z",
    },
  };
}

function prefixOf(key) {
  return String(key).replace(/-\d+$/, "");
}

function rateLimit(retryAfter = "0") {
  const err = new Error("rate limited");
  err.response = { status: 429, headers: { "retry-after": retryAfter } };
  return err;
}

function createFakeJira(seed = {}) {
  const issues = { ...(seed.issues || {}) };
  const comments = {};
  const transitionPosts = [];
  const commentPosts = [];
  const searchCalls = [];
  let pages = Array.isArray(seed.searchPages) ? [...seed.searchPages] : null;
  let remaining429 = Number(seed.rateLimits) || 0;
  const slept = [];

  function maybe429() {
    if (remaining429 > 0) {
      remaining429 -= 1;
      throw rateLimit(seed.retryAfter || "0");
    }
  }

  function issueFromUrl(url) {
    const match = String(url).match(/\/issue\/([^/?]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  const http = {
    async get(url) {
      maybe429();
      const key = issueFromUrl(url);
      if (String(url).includes("/transitions")) {
        const offered = seed.transitions && seed.transitions[key] ? seed.transitions[key] : [];
        return { data: { transitions: offered } };
      }
      if (String(url).includes("/comment")) {
        const list = comments[key] || [];
        return {
          data: {
            comments: list.map((text, idx) => ({
              id: String(idx + 1),
              body: text,
            })),
          },
        };
      }
      const raw = issues[key];
      if (!raw) {
        const err = new Error("not found");
        err.response = { status: 404 };
        throw err;
      }
      return { data: raw };
    },
    async post(url, body) {
      maybe429();
      if (String(url).includes("/search/jql")) {
        searchCalls.push(body);
        if (pages && pages.length) return { data: pages.shift() };
        const project = String(body && body.jql).match(/project\s*=\s*([A-Z]+)/i);
        const want = project ? project[1].toUpperCase() : "";
        const list = Object.values(issues).filter((item) => prefixOf(item.key) === want);
        return { data: { issues: list, isLast: true } };
      }
      const key = issueFromUrl(url);
      if (String(url).includes("/transitions")) {
        transitionPosts.push({ key, body });
        const id = body && body.transition && body.transition.id;
        const offered = seed.transitions && seed.transitions[key] ? seed.transitions[key] : [];
        const match = offered.find((item) => String(item.id) === String(id));
        if (match && match.to && issues[key] && issues[key].fields) {
          issues[key].fields.status = { name: match.to.name };
        }
        return { data: {} };
      }
      if (String(url).includes("/comment")) {
        const text = jira.adfToText(body && body.body);
        comments[key] = comments[key] || [];
        comments[key].push(text);
        commentPosts.push({ key, text });
        return { data: { id: "1" } };
      }
      throw new Error(`unexpected POST ${url}`);
    },
  };

  return {
    http,
    issues,
    comments,
    transitionPosts,
    commentPosts,
    searchCalls,
    slept,
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
}

async function makeWorkflow(profileKey) {
  const config = { cron: "*/5 * * * *" };
  if (profileKey === "MF" || profileKey === "MFC") {
    config.intake = "bucket";
    config.profileKeys = [profileKey];
  }
  return Workflow.create({
    name: `${profileKey} pipeline`,
    status: "published",
    profileKey,
    nodes: [{ id: "start", type: "delay", config: { seconds: 0 } }],
    edges: [],
    trigger: { type: "cron", enabled: true, config },
  });
}

async function seedWorkflows() {
  const docs = {};
  for (const key of ["MF", "MFC", "QUT", "TAC"]) {
    docs[key] = await makeWorkflow(key);
  }
  return docs;
}

describe("jira-pr phase 5 intake", () => {
  const profiles = parseProfiles();
  let enqueued;

  before(async () => {
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.JIRA_EMAIL = "bot@example.test";
    process.env.JIRA_API_TOKEN = "token";
    await connectTestDb();
    await TicketRun.syncIndexes();
    await ResourceLock.syncIndexes();
  });

  after(async () => {
    await disconnectTestDb();
    if (PREV_BASE === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = PREV_BASE;
    if (PREV_EMAIL === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = PREV_EMAIL;
    if (PREV_TOKEN === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = PREV_TOKEN;
  });

  beforeEach(async () => {
    await clearTestData();
    enqueued = [];
  });

  function enqueue(workflowId, input, options) {
    enqueued.push({
      workflowId: String(workflowId),
      input,
      options,
    });
    return { id: options && options.jobId };
  }

  function depsFor(fake, extra = {}) {
    return {
      http: fake.http,
      sleep: fake.sleep,
      profiles,
      enqueue,
      recoverStale: async () => ({ released: [], results: [] }),
      ...extra,
    };
  }

  test("routing by prefix", async () => {
    assert.equal(jira.parseIssueRef("MF-123"), "MF-123");
    assert.equal(jira.parseIssueRef("https://site.atlassian.net/browse/MFC-9?foo=1"), "MFC-9");
    assert.equal(resolveProfile("MF-123", profiles).jiraKey, "MF");
    assert.equal(resolveProfile("MFC-123", profiles).jiraKey, "MFC");
    assert.equal(resolveProfile("QUT-1", profiles).jiraKey, "QUT");
    assert.equal(resolveProfile("TAC-8", profiles).jiraKey, "TAC");
  });

  test("paging through several pages", async () => {
    const fake = createFakeJira({
      searchPages: [
        {
          issues: [issuePayload("MF-1")],
          nextPageToken: "p2",
          isLast: false,
        },
        {
          issues: [issuePayload("MF-2")],
          isLast: true,
        },
      ],
    });
    const issues = await jira.searchIssues(profiles.MF.eligibleJql, {
      http: fake.http,
      sleep: fake.sleep,
    });
    assert.deepEqual(
      issues.map((item) => item.key),
      ["MF-1", "MF-2"]
    );
    assert.equal(issues[0].fingerprint.length, 64);
    assert.equal(fake.searchCalls.length, 2);
    assert.equal(fake.searchCalls[1].nextPageToken, "p2");
  });

  test("429 backoff", async () => {
    const fake = createFakeJira({
      issues: { "MF-1": issuePayload("MF-1") },
      rateLimits: 1,
      retryAfter: "2",
    });
    const issue = await jira.fetchIssue("MF-1", { http: fake.http, sleep: fake.sleep });
    assert.equal(issue.key, "MF-1");
    assert.deepEqual(issue.labels, []);
    assert.deepEqual(issue.components, ["UI"]);
    assert.equal(issue.issueType, "Story");
    assert.ok(issue.updated);
    assert.deepEqual(fake.slept, [2000]);
  });

  test("ineligible tickets are reported and keep their status", async () => {
    await seedWorkflows();
    const fake = createFakeJira({
      issues: {
        "MF-10": issuePayload("MF-10", { description: "" }),
        "QUT-10": issuePayload("QUT-10", { summary: "Write tests" }),
      },
    });
    const report = await dispatcher.dispatch({ dryRun: false, ...depsFor(fake) });
    const mf = report.profiles.find((row) => row.jiraKey === "MF");
    const qut = report.profiles.find((row) => row.jiraKey === "QUT");
    assert.ok(mf.ineligible.some((item) => item.key === "MF-10" && item.reason === "missing_description"));
    assert.ok(qut.ineligible.some((item) => item.key === "QUT-10" && item.reason === "missing_module_ref"));
    assert.equal(fake.transitionPosts.length, 0);
    assert.equal(enqueued.length, 0);
    assert.equal(await TicketRun.countDocuments(), 0);
  });

  test("a duplicate poll creates nothing", async () => {
    const workflows = await seedWorkflows();
    const fake = createFakeJira({
      issues: { "MF-11": issuePayload("MF-11") },
    });
    const first = await dispatcher.dispatch({ dryRun: false, ...depsFor(fake) });
    const second = await dispatcher.dispatch({ dryRun: false, ...depsFor(fake) });
    const started = first.profiles.find((row) => row.jiraKey === "MF").started;
    const skipped = second.profiles.find((row) => row.jiraKey === "MF").skipped;
    assert.equal(started.length, 1);
    assert.equal(started[0].profileKey, "MF");
    assert.equal(String(started[0].workflowId), String(workflows.MF._id));
    assert.ok(skipped.some((item) => item.key === "MF-11" && item.reason === "duplicate"));
    assert.equal(enqueued.length, 1);
    assert.equal(await TicketRun.countDocuments(), 1);
  });

  test("a changed fingerprint after completion creates a new run", async () => {
    await seedWorkflows();
    const fake = createFakeJira({
      issues: { "MF-12": issuePayload("MF-12", { summary: "First summary" }) },
    });
    await dispatcher.dispatch({ dryRun: false, ...depsFor(fake) });
    const first = await TicketRun.findOne({ jiraKey: "MF-12" });
    assert.ok(first);
    await TicketRun.updateOne({ _id: first._id }, { $set: { state: "completed" } });
    fake.issues["MF-12"] = issuePayload("MF-12", { summary: "Changed summary" });
    await dispatcher.dispatch({ dryRun: false, ...depsFor(fake) });
    const all = await TicketRun.find({ jiraKey: "MF-12" }).sort({ createdAt: 1 });
    assert.equal(all.length, 2);
    assert.equal(all[0].state, "completed");
    assert.equal(all[1].state, "claimed");
    assert.notEqual(all[0].fingerprint, all[1].fingerprint);
    assert.equal(enqueued.length, 2);
  });

  test("a transition that isn't offered becomes a comment, not a failure", async () => {
    const fake = createFakeJira({
      issues: { "MF-13": issuePayload("MF-13") },
      transitions: { "MF-13": [{ id: "21", name: "Start", to: { name: "In Progress" } }] },
    });
    const result = await jira.transitionIssue("MF-13", "READY FOR REVIEW", {
      http: fake.http,
      sleep: fake.sleep,
      marker: "[wf:run1:n1]",
      commentOnMissing: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_offered");
    assert.equal(result.commented, true);
    assert.equal(fake.transitionPosts.length, 0);
    assert.equal(fake.commentPosts.length, 1);
    assert.match(fake.commentPosts[0].text, /not offered/);
    assert.match(fake.commentPosts[0].text, /\[wf:run1:n1\]/);
  });

  test("a browse URL and a bare key for the same issue start one run", async () => {
    await seedWorkflows();
    const fake = createFakeJira({
      issues: { "MF-14": issuePayload("MF-14") },
    });
    const first = await dispatcher.startFromIssue("https://vxceed.atlassian.net/browse/MF-14", depsFor(fake));
    assert.equal(first.ok, true);
    await assert.rejects(
      () => dispatcher.startFromIssue("MF-14", depsFor(fake)),
      (err) => err.statusCode === 409 && err.reason === "duplicate"
    );
    assert.equal(enqueued.length, 1);
    assert.equal(await TicketRun.countDocuments({ jiraKey: "MF-14" }), 1);
  });

  test("a pasted ticket runs even when it is not assigned to you and has no ai-ready label", async () => {
    await seedWorkflows();
    const fake = createFakeJira({
      issues: {
        "MF-15": issuePayload("MF-15", {
          status: "In Progress",
          labels: ["needs-design"],
          summary: "Unassigned work",
        }),
      },
    });
    const started = await dispatcher.startFromIssue("MF-15", depsFor(fake));
    assert.equal(started.ok, true);
    assert.equal(started.profileKey, "MF");
    assert.equal(enqueued[0].input.jira.status, "In Progress");
    assert.deepEqual(enqueued[0].input.jira.labels, ["needs-design"]);
  });

  test("MFC-1 is not treated as MF-1", async () => {
    const workflows = await seedWorkflows();
    const fake = createFakeJira({
      issues: {
        "MF-1": issuePayload("MF-1"),
        "MFC-1": issuePayload("MFC-1"),
      },
    });
    const mf = await dispatcher.startFromIssue("MF-1", depsFor(fake));
    const mfc = await dispatcher.startFromIssue("MFC-1", depsFor(fake));
    assert.equal(mf.profileKey, "MF");
    assert.equal(mfc.profileKey, "MFC");
    assert.equal(String(mf.workflowId), String(workflows.MF._id));
    assert.equal(String(mfc.workflowId), String(workflows.MFC._id));
    assert.notEqual(mf.runId, mfc.runId);
  });

  test("a key outside the four projects is refused", async () => {
    await seedWorkflows();
    const fake = createFakeJira({
      issues: { "ABC-1": issuePayload("ABC-1") },
    });
    await assert.rejects(
      () => dispatcher.startFromIssue("ABC-1", depsFor(fake)),
      (err) => err.statusCode === 400 && err.reason === "unknown_project"
    );
    await assert.rejects(
      () => dispatcher.startFromIssue("not a ticket", depsFor(fake)),
      (err) => err.statusCode === 400 && err.reason === "invalid_issue"
    );
    assert.equal(enqueued.length, 0);
  });

  test("dry run lists tickets and changes nothing", async () => {
    await seedWorkflows();
    const fake = createFakeJira({
      issues: {
        "MF-20": issuePayload("MF-20"),
        "MFC-20": issuePayload("MFC-20"),
        "QUT-20": issuePayload("QUT-20", { summary: "Cover [@QUT-1] login" }),
        "TAC-20": issuePayload("TAC-20", { summary: "Add [@TAC-3-2] transfer" }),
      },
    });
    const report = await dispatcher.dispatch({ dryRun: true, ...depsFor(fake) });
    assert.equal(report.dryRun, true);
    assert.deepEqual(
      report.profiles.map((row) => row.jiraKey).sort(),
      ["MF", "MFC", "QUT", "TAC"]
    );
    for (const row of report.profiles) {
      assert.equal(row.started.length, 0);
      assert.equal(row.eligible.length, 1);
    }
    assert.equal(enqueued.length, 0);
    assert.equal(await TicketRun.countDocuments(), 0);
    assert.equal(fake.transitionPosts.length, 0);
    assert.equal(fake.commentPosts.length, 0);
  });

  test("jiraUpdate retries once and a repeated marker does not post twice", async () => {
    const fake = createFakeJira({
      issues: { "MF-21": issuePayload("MF-21") },
      transitions: {
        "MF-21": [{ id: "31", name: "dev in progress", to: { name: "In Progress" } }],
      },
    });
    const originalTransition = jira.transitionIssue;
    const originalComment = jira.addComment;
    jira.transitionIssue = (key, status, extra = {}) =>
      originalTransition(key, status, { ...extra, http: fake.http, sleep: fake.sleep });
    jira.addComment = (key, text, marker, extra = {}) =>
      originalComment(key, text, marker, { ...extra, http: fake.http, sleep: fake.sleep });
    try {
      const node = {
        id: "claim",
        type: "jiraUpdate",
        config: {
          retries: 1,
          transition: "claim",
          comment: "Claimed {{jira.key}}",
        },
      };
      const input = { issueKey: "MF-21", jira: { key: "MF-21", status: "To Do" } };
      const runState = { runId: "aaaaaaaaaaaaaaaaaaaaaaaa", nodeId: "claim" };
      const first = await lifecycle.jiraUpdate(node, input, runState);
      const second = await lifecycle.jiraUpdate(node, input, runState);
      assert.equal(first.jiraUpdate.transition.reason, "transitioned");
      assert.equal(first.jiraUpdate.comment.posted, true);
      assert.equal(second.jiraUpdate.transition.reason, "already_in_status");
      assert.equal(second.jiraUpdate.comment.posted, false);
      assert.equal(second.jiraUpdate.comment.reason, "duplicate_marker");
      assert.equal(fake.commentPosts.length, 1);
      assert.equal(fake.transitionPosts.length, 1);
    } finally {
      jira.transitionIssue = originalTransition;
      jira.addComment = originalComment;
    }

    const workflow = await Workflow.create({
      name: "jira-update-once",
      status: "published",
      nodes: [
        {
          id: "u",
          type: "jiraUpdate",
          config: { retries: 1, transition: "In Progress" },
        },
      ],
      edges: [],
      trigger: { type: "webhook", enabled: true, config: {} },
    });
    const nodes = require("../src/nodes");
    const originalNode = nodes.executeNode;
    let calls = 0;
    nodes.executeNode = async () => {
      calls += 1;
      throw new Error("boom");
    };
    try {
      await assert.rejects(() => engine.executeWorkflow(workflow._id, { issueKey: "MF-21" }, "phase5-once"));
      assert.equal(calls, 1);
    } finally {
      nodes.executeNode = originalNode;
    }
  });

  test("summary tags such as [@TAC-3-2] are parsed onto the issue", async () => {
    const fake = createFakeJira({
      issues: {
        "TAC-3": issuePayload("TAC-3", { summary: "Script [@TAC-3-2] for load out" }),
      },
    });
    const issue = await jira.fetchIssue("TAC-3", { http: fake.http, sleep: fake.sleep });
    assert.deepEqual(issue.tags, ["[@TAC-3-2]"]);
    assert.equal(
      dispatcher.assessEligibility(issue, profiles.TAC, { source: "bucket" }).ok,
      true
    );
  });
});
