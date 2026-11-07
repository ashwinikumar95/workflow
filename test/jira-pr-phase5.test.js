const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const Workflow = require("../src/models/workflow");
const Run = require("../src/models/Run");
const TicketRun = require("../src/models/TicketRun");
const ResourceLock = require("../src/models/ResourceLock");
const jira = require("../src/services/jiraService");
const jiraTransition = require("../src/services/jiraTransition");
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
  const prefix = String(key).replace(/-\d+$/, "");
  return {
    id: extra.id || String(10000 + Number(String(key).replace(/\D/g, "") || 1)),
    key,
    fields: {
      summary: extra.summary ?? `Work ${key}`,
      description,
      status: { name: extra.status || "To Do", id: extra.statusId || "1" },
      issuetype: extra.issuetype || { id: extra.issueTypeId || "10001", name: extra.issueType || "Story" },
      project: extra.project || { id: extra.projectId || `p-${prefix}`, key: prefix },
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
  const extraFields = {};
  const transitionPosts = [];
  const commentPosts = [];
  const fieldPuts = [];
  const searchCalls = [];
  const failedOnce = {};
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

  function toNameOf(item) {
    if (!item) return "";
    if (typeof item.to === "string") return item.to;
    return item.to && item.to.name ? item.to.name : "";
  }

  function enrich(item) {
    const toName = toNameOf(item);
    const fields =
      (item && item.fields) ||
      (seed.requiredFieldsByTo && seed.requiredFieldsByTo[toName]) ||
      {};
    return {
      ...item,
      to: typeof item.to === "string" ? { name: item.to } : item.to,
      fields,
    };
  }

  function currentStatus(key) {
    return issues[key] && issues[key].fields && issues[key].fields.status
      ? issues[key].fields.status.name
      : "";
  }

  function fieldSet(key) {
    return extraFields[key] || {};
  }

  function offeredFor(key) {
    let list = [];
    if (seed.transitionsByStatus) {
      list = seed.transitionsByStatus[currentStatus(key)] || [];
    } else if (seed.transitions && seed.transitions[key]) {
      list = seed.transitions[key];
    }
    return list
      .filter((item) => {
        const toName = toNameOf(item);
        const need = seed.offerAfterFields && seed.offerAfterFields[toName];
        if (!need || !need.length) return true;
        const stored = fieldSet(key);
        return need.every((name) => stored[name] != null);
      })
      .map(enrich);
  }

  function workflowResponse() {
    const graph = seed.workflows;
    if (!graph) return { workflows: [], statuses: [] };
    return {
      statuses: graph.statuses || [],
      workflows: [
        {
          statuses: graph.statuses || [],
          transitions: (graph.transitions || []).map((item) => ({
            id: item.id,
            name: item.name,
            type: "DIRECTED",
            from: item.from,
            to: typeof item.to === "string" ? { name: item.to } : item.to,
          })),
        },
      ],
    };
  }

  function httpError(status, data) {
    const err = new Error(`http ${status}`);
    err.response = { status, data: data || {} };
    return err;
  }

  const http = {
    async get(url) {
      maybe429();
      const path = String(url);
      if (path.includes("/myself")) {
        return { data: seed.myself || { accountId: "acc-1", emailAddress: "bot@example.test" } };
      }
      if (path.includes("/workflow/search")) {
        return { data: { values: workflowResponse().workflows, statuses: workflowResponse().statuses } };
      }
      if (path.includes("/workflowscheme")) {
        throw httpError(404);
      }
      const key = issueFromUrl(url);
      if (path.includes("/transitions")) {
        return { data: { transitions: offeredFor(key) } };
      }
      if (path.includes("/editmeta")) {
        return { data: { fields: seed.editmeta || {} } };
      }
      if (path.includes("/comment")) {
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
      if (!raw) throw httpError(404);
      return { data: raw };
    },
    async post(url, body) {
      maybe429();
      const path = String(url);
      if (path.includes("/search/jql")) {
        searchCalls.push(body);
        if (pages && pages.length) return { data: pages.shift() };
        const project = String(body && body.jql).match(/project\s*=\s*([A-Z]+)/i);
        const want = project ? project[1].toUpperCase() : "";
        const list = Object.values(issues).filter((item) => prefixOf(item.key) === want);
        return { data: { issues: list, isLast: true } };
      }
      if (path.includes("/workflows") && !path.includes("/issue/")) {
        return { data: workflowResponse() };
      }
      const key = issueFromUrl(url);
      if (path.includes("/transitions")) {
        const id = body && body.transition && body.transition.id;
        const offered = offeredFor(key);
        const match = offered.find((item) => String(item.id) === String(id));
        const dest = toNameOf(match);
        const fail = seed.failTransitionOnce && dest && seed.failTransitionOnce[dest];
        if (fail && !failedOnce[`${key}:${dest}`]) {
          failedOnce[`${key}:${dest}`] = true;
          throw httpError(400, { errors: fail.errors || fail });
        }
        if (seed.enforceRequiredOnPost && match && match.fields) {
          const sent = (body && body.fields) || {};
          for (const [name, meta] of Object.entries(match.fields)) {
            if (meta && meta.required && sent[name] == null && name !== "comment") {
              throw httpError(400, { errors: { [name]: `${name} is required.` } });
            }
          }
        }
        transitionPosts.push({ key, body });
        if (match && match.to && issues[key] && issues[key].fields) {
          issues[key].fields.status = {
            name: match.to.name,
            id: match.to.id || issues[key].fields.status.id,
          };
        }
        if (body && body.update && body.update.comment) {
          const added = body.update.comment[0] && body.update.comment[0].add && body.update.comment[0].add.body;
          const text = jira.adfToText(added);
          if (text) {
            comments[key] = comments[key] || [];
            comments[key].push(text);
            commentPosts.push({ key, text });
          }
        }
        return { data: {} };
      }
      if (path.includes("/comment")) {
        const text = jira.adfToText(body && body.body);
        comments[key] = comments[key] || [];
        comments[key].push(text);
        commentPosts.push({ key, text });
        return { data: { id: "1" } };
      }
      throw new Error(`unexpected POST ${url}`);
    },
    async put(url, body) {
      maybe429();
      const key = issueFromUrl(url);
      if (!issues[key]) throw httpError(404);
      const fields = (body && body.fields) || {};
      extraFields[key] = { ...(extraFields[key] || {}), ...fields };
      if (issues[key].fields) Object.assign(issues[key].fields, fields);
      fieldPuts.push({ key, fields });
      return { data: {} };
    },
  };

  return {
    http,
    issues,
    comments,
    extraFields,
    transitionPosts,
    commentPosts,
    fieldPuts,
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
    jira.clearWorkflowCache();
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

  test("On Hold walks Ready for Assign through DEV IN PROGRESS", async () => {
    const fake = createFakeJira({
      issues: { "MFC-10142": issuePayload("MFC-10142", { status: "Ready for Assign" }) },
      transitionsByStatus: mfcOffered(),
      workflows: mfcWorkflowGraph(),
    });
    const result = await jira.transitionIssue("MFC-10142", "On Hold", {
      http: fake.http,
      sleep: fake.sleep,
      marker: "[wf:run1:jiraPlanFailed]",
      preferredStatuses: ["In Progress", "READY FOR REVIEW", "On Hold"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "transitioned");
    assert.deepEqual(
      result.hops.map((hop) => hop.to),
      ["DEV IN PROGRESS", "On Hold"]
    );
    assert.equal(fake.transitionPosts.length, 2);
    assert.equal(fake.commentPosts.length, 0);
    assert.equal(fake.issues["MFC-10142"].fields.status.name, "On Hold");
  });

  test("required transition fields are sent on the On Hold hop", async () => {
    const fake = createFakeJira({
      issues: { "MFC-10142": issuePayload("MFC-10142", { status: "Ready for Assign" }) },
      transitionsByStatus: mfcOffered(),
      workflows: mfcWorkflowGraph(),
      enforceRequiredOnPost: true,
      requiredFieldsByTo: {
        "On Hold": {
          resolution: {
            required: true,
            schema: { type: "resolution" },
            allowedValues: [
              { id: "10000", name: "Done" },
              { id: "10001", name: "Won't Do" },
            ],
          },
        },
      },
    });
    const result = await jira.transitionIssue("MFC-10142", "On Hold", {
      http: fake.http,
      sleep: fake.sleep,
      commentText: "Plan did not stay clean",
    });
    assert.equal(result.ok, true);
    const hold = fake.transitionPosts.find((row) => row.body.transition.id === "20");
    assert.ok(hold);
    assert.equal(hold.body.fields.resolution.id, "10001");
  });

  test("a required field is PUT before a hidden hop is offered", async () => {
    const fake = createFakeJira({
      issues: { "MFC-7": issuePayload("MFC-7", { status: "Ready for Assign" }) },
      transitionsByStatus: {
        "Ready for Assign": [{ id: "20", name: "On Hold", to: { name: "On Hold" } }],
        "On Hold": [],
      },
      workflows: {
        statuses: [
          { id: "1", name: "Ready for Assign" },
          { id: "4", name: "On Hold" },
        ],
        transitions: [{ id: "20", name: "On Hold", from: ["Ready for Assign"], to: "On Hold" }],
      },
      offerAfterFields: { "On Hold": ["customfield_11800"] },
      editmeta: {
        customfield_11800: { required: false, schema: { type: "string" } },
      },
    });
    const result = await jira.transitionIssue("MFC-7", "On Hold", {
      http: fake.http,
      sleep: fake.sleep,
      transitionFields: { customfield_11800: "Blocked: plan failed" },
    });
    assert.equal(result.ok, true);
    assert.equal(fake.fieldPuts.length, 1);
    assert.equal(fake.fieldPuts[0].fields.customfield_11800, "Blocked: plan failed");
    assert.equal(fake.transitionPosts.length, 1);
    assert.equal(fake.issues["MFC-7"].fields.status.name, "On Hold");
  });

  test("claim target In Progress matches live status DEV IN PROGRESS", async () => {
    const fake = createFakeJira({
      issues: { "MFC-8": issuePayload("MFC-8", { status: "Ready for Assign" }) },
      transitionsByStatus: mfcOffered(),
      workflows: mfcWorkflowGraph(),
    });
    const result = await jira.transitionIssue("MFC-8", "In Progress", {
      http: fake.http,
      sleep: fake.sleep,
    });
    assert.equal(result.ok, true);
    assert.equal(result.hops.length, 1);
    assert.equal(result.hops[0].to, "DEV IN PROGRESS");
    assert.equal(fake.issues["MFC-8"].fields.status.name, "DEV IN PROGRESS");
  });

  test("a transition that still cannot be reached comments offered hops", async () => {
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
    assert.match(fake.commentPosts[0].text, /Offered: Start → In Progress/);
  });

  test("a 400 listing missing fields retries the hop once", async () => {
    const fake = createFakeJira({
      issues: { "MFC-12": issuePayload("MFC-12", { status: "DEV IN PROGRESS" }) },
      transitionsByStatus: mfcOffered(),
      workflows: mfcWorkflowGraph(),
      failTransitionOnce: {
        "On Hold": { errors: { customfield_9: "required" } },
      },
    });
    const result = await jira.transitionIssue("MFC-12", "On Hold", {
      http: fake.http,
      sleep: fake.sleep,
      commentText: "hold reason",
    });
    assert.equal(result.ok, true);
    assert.equal(fake.transitionPosts.length, 1);
    assert.equal(fake.transitionPosts[0].body.fields.customfield_9, "hold reason");
  });

  test("a looped workflow does not walk forever", async () => {
    const fake = createFakeJira({
      issues: { "MFC-9": issuePayload("MFC-9", { status: "A" }) },
      transitionsByStatus: {
        A: [{ id: "1", name: "to B", to: { name: "B" } }],
        B: [{ id: "2", name: "to A", to: { name: "A" } }],
      },
      workflows: {
        statuses: [
          { id: "1", name: "A" },
          { id: "2", name: "B" },
          { id: "3", name: "C" },
        ],
        transitions: [
          { id: "1", name: "to B", from: ["A"], to: "B" },
          { id: "2", name: "to A", from: ["B"], to: "A" },
        ],
      },
    });
    const result = await jira.transitionIssue("MFC-9", "C", {
      http: fake.http,
      sleep: fake.sleep,
      marker: "[wf:loop:n1]",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_offered");
    assert.equal(fake.transitionPosts.length, 0);
  });

  test("a path longer than six hops is refused", async () => {
    const statuses = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"];
    const transitions = [];
    const byStatus = {};
    for (let i = 0; i < statuses.length - 1; i += 1) {
      const id = String(i + 1);
      transitions.push({ id, name: `to ${statuses[i + 1]}`, from: [statuses[i]], to: statuses[i + 1] });
      byStatus[statuses[i]] = [{ id, name: `to ${statuses[i + 1]}`, to: { name: statuses[i + 1] } }];
    }
    byStatus.S7 = [];
    const fake = createFakeJira({
      issues: { "MFC-10": issuePayload("MFC-10", { status: "S0" }) },
      transitionsByStatus: byStatus,
      workflows: {
        statuses: statuses.map((name, idx) => ({ id: String(idx + 1), name })),
        transitions,
      },
    });
    const result = await jira.transitionIssue("MFC-10", "S7", {
      http: fake.http,
      sleep: fake.sleep,
      marker: "[wf:cap:n1]",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_offered");
    assert.equal(fake.transitionPosts.length, 0);
  });

  test("jiraUpdate passes comment text into a blocked transition", async () => {
    const fake = createFakeJira({
      issues: { "MFC-11": issuePayload("MFC-11", { status: "DEV IN PROGRESS" }) },
      transitionsByStatus: mfcOffered(),
      workflows: mfcWorkflowGraph(),
      requiredFieldsByTo: {
        "On Hold": {
          comment: { required: true, schema: { type: "string" } },
        },
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
        id: "jiraPlanFailed",
        type: "jiraUpdate",
        config: {
          transition: "blocked",
          comment: "{{reason}}",
        },
      };
      const input = {
        issueKey: "MFC-11",
        jira: { key: "MFC-11" },
        reason: "plan did not stay clean",
      };
      const runState = { runId: "bbbbbbbbbbbbbbbbbbbbbbbb", nodeId: "jiraPlanFailed" };
      const out = await lifecycle.jiraUpdate(node, input, runState);
      assert.equal(out.jiraUpdate.transition.ok, true);
      assert.equal(fake.transitionPosts.length, 1);
      assert.ok(fake.transitionPosts[0].body.update);
    } finally {
      jira.transitionIssue = originalTransition;
      jira.addComment = originalComment;
    }
  });

  test("jiraUpdate comments without transitioning when no status is configured", async () => {
    const fake = createFakeJira({
      issues: { "MFC-11": issuePayload("MFC-11", { status: "DEV IN PROGRESS" }) },
      transitionsByStatus: mfcOffered(),
      workflows: mfcWorkflowGraph(),
    });
    const originalTransition = jira.transitionIssue;
    const originalComment = jira.addComment;
    let transitionCalls = 0;
    jira.transitionIssue = (...args) => {
      transitionCalls += 1;
      return originalTransition(...args);
    };
    jira.addComment = (key, text, marker, extra = {}) =>
      originalComment(key, text, marker, { ...extra, http: fake.http, sleep: fake.sleep });
    try {
      const node = {
        id: "jiraPlanFailed",
        type: "jiraUpdate",
        config: { comment: "{{reason}}" },
      };
      const input = {
        issueKey: "MFC-11",
        jira: { key: "MFC-11" },
        reason: "plan did not stay clean",
      };
      const runState = { runId: "bbbbbbbbbbbbbbbbbbbbbbbb", nodeId: "jiraPlanFailed" };
      const out = await lifecycle.jiraUpdate(node, input, runState);
      assert.equal(out.jiraUpdate.transition, undefined);
      assert.equal(transitionCalls, 0);
      assert.equal(fake.transitionPosts.length, 0);
      assert.equal(fake.commentPosts.length, 1);
      assert.match(fake.commentPosts[0].text, /plan did not stay clean/);
      assert.equal(fake.issues["MFC-11"].fields.status.name, "DEV IN PROGRESS");
    } finally {
      jira.transitionIssue = originalTransition;
      jira.addComment = originalComment;
    }
  });
});

function mfcWorkflowGraph() {
  return {
    statuses: [
      { id: "1", name: "Ready for Assign" },
      { id: "2", name: "DEV IN PROGRESS" },
      { id: "3", name: "READY FOR DESIGN" },
      { id: "4", name: "On Hold" },
      { id: "5", name: "READY FOR REVIEW" },
    ],
    transitions: [
      { id: "10", name: "Start Dev", from: ["Ready for Assign"], to: "DEV IN PROGRESS" },
      { id: "11", name: "More Details", from: ["Ready for Assign"], to: "READY FOR DESIGN" },
      { id: "20", name: "On Hold", from: ["DEV IN PROGRESS"], to: "On Hold" },
      { id: "21", name: "Ready for Review", from: ["DEV IN PROGRESS"], to: "READY FOR REVIEW" },
      { id: "30", name: "Start Dev", from: ["READY FOR DESIGN"], to: "DEV IN PROGRESS" },
    ],
  };
}

function mfcOffered() {
  return {
    "Ready for Assign": [
      { id: "10", name: "Start Dev", to: { name: "DEV IN PROGRESS" } },
      { id: "11", name: "More Details", to: { name: "READY FOR DESIGN" } },
    ],
    "DEV IN PROGRESS": [
      { id: "20", name: "On Hold", to: { name: "On Hold" } },
      { id: "21", name: "Ready for Review", to: { name: "READY FOR REVIEW" } },
    ],
    "READY FOR DESIGN": [{ id: "30", name: "Start Dev", to: { name: "DEV IN PROGRESS" } }],
    "On Hold": [],
  };
}

describe("jira transition path helpers", () => {
  test("BFS prefers the claim status when two paths are the same length", () => {
    const workflow = {
      statuses: [
        { name: "Ready for Assign" },
        { name: "DEV IN PROGRESS" },
        { name: "READY FOR DESIGN" },
        { name: "On Hold" },
      ],
      transitions: [
        { id: "1", name: "Start Dev", from: ["Ready for Assign"], to: "DEV IN PROGRESS" },
        { id: "2", name: "More Details", from: ["Ready for Assign"], to: "READY FOR DESIGN" },
        { id: "3", name: "Hold from dev", from: ["DEV IN PROGRESS"], to: "On Hold" },
        { id: "4", name: "Hold from design", from: ["READY FOR DESIGN"], to: "On Hold" },
      ],
    };
    const path = jiraTransition.findTransitionPath(workflow, "Ready for Assign", "On Hold", {
      preferredStatuses: ["In Progress", "On Hold"],
    });
    assert.deepEqual(
      path.map((hop) => hop.to),
      ["DEV IN PROGRESS", "On Hold"]
    );
  });

  test("fillRequiredFields uses overlay, then allowed values, then comment text", () => {
    const filled = jiraTransition.fillRequiredFields(
      {
        resolution: {
          required: true,
          schema: { type: "resolution" },
          allowedValues: [
            { id: "1", name: "Done" },
            { id: "2", name: "Won't Do" },
          ],
        },
        customfield_1: { required: true, schema: { type: "string" } },
        assignee: { required: true, schema: { type: "user" } },
      },
      {
        commentText: "blocked by plan",
        myself: { accountId: "acc-1" },
      }
    );
    assert.equal(filled.missing.length, 0);
    assert.equal(filled.fields.resolution.id, "2");
    assert.equal(filled.fields.customfield_1, "blocked by plan");
    assert.equal(filled.fields.assignee.accountId, "acc-1");
  });

  test("a required field with no justifiable value is reported missing", () => {
    const filled = jiraTransition.fillRequiredFields({
      duedate: { required: true, schema: { type: "date" } },
    });
    assert.deepEqual(filled.missing, ["duedate"]);
  });
});
