const assert = require("node:assert/strict");
const path = require("path");
const { describe, test, before, after, beforeEach } = require("node:test");
const mongoose = require("mongoose");
const Workflow = require("../src/models/workflow");
const User = require("../src/models/User");
const TicketRun = require("../src/models/TicketRun");
const Run = require("../src/models/Run");
const ResourceLock = require("../src/models/ResourceLock");
const dispatcher = require("../src/services/jiraDispatcher");
const { seedDraftWorkflows, loadSeedDefs } = require("../src/services/workflowSeed");
const { prepareWorkflowWrite } = require("../src/utils/redactSecrets");
const rulesService = require("../src/services/rulesService");
const lifecycle = require("../src/nodes/lifecycle");
const { parseProfiles } = require("../src/services/projectRegistry");
const {
  connectTestDb,
  disconnectTestDb,
  clearTestData,
} = require("../test-support/helpers");

const FUJI_FIXTURE = path.join(__dirname, "fixtures", "rules", "fuji");
const OWNER_EMAIL = "owner.drafts@example.test";
const PREV_OWNER = process.env.WORKFLOW_OWNER_EMAIL;

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

function createFakeJira(issues) {
  const http = {
    async get(url) {
      const match = String(url).match(/\/issue\/([^/?]+)/);
      const key = match ? decodeURIComponent(match[1]) : "";
      const raw = issues[key];
      if (!raw) {
        const err = new Error("not found");
        err.response = { status: 404 };
        throw err;
      }
      return { data: raw };
    },
    async post(url, body) {
      if (String(url).includes("/search/jql")) {
        const project = String(body && body.jql).match(/project\s*=\s*([A-Z]+)/i);
        const want = project ? project[1].toUpperCase() : "";
        const list = Object.values(issues).filter(
          (item) => String(item.key).replace(/-\d+$/, "") === want
        );
        return { data: { issues: list, isLast: true } };
      }
      return { data: {} };
    },
  };
  return { http, sleep: async () => {} };
}

async function makeOwner() {
  return User.create({
    name: "Owner",
    email: OWNER_EMAIL,
    password: "test-password-not-used",
  });
}

describe("jira-pr durable MF/MFC drafts", () => {
  const profiles = parseProfiles();
  let enqueued;

  before(async () => {
    process.env.WORKFLOW_OWNER_EMAIL = OWNER_EMAIL;
    await connectTestDb();
    await TicketRun.syncIndexes();
    await ResourceLock.syncIndexes();
  });

  after(async () => {
    await disconnectTestDb();
    if (PREV_OWNER === undefined) delete process.env.WORKFLOW_OWNER_EMAIL;
    else process.env.WORKFLOW_OWNER_EMAIL = PREV_OWNER;
  });

  beforeEach(async () => {
    await clearTestData();
    try {
      await mongoose.connection.collection("users").deleteMany({});
    } catch {
      // collection may not exist yet
    }
    enqueued = [];
  });

  function enqueue(workflowId, input, options) {
    enqueued.push({ workflowId: String(workflowId), input, options });
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

  test("seed restores missing drafts for the owner and does not overwrite existing", async () => {
    const defs = loadSeedDefs();
    assert.deepEqual(
      defs.map((row) => row.seedKey),
      ["manual-mf-mfc", "bucket-mfc", "bucket-mf"]
    );
    const user = await makeOwner();
    const first = await seedDraftWorkflows();
    assert.equal(first.skipped, false);
    assert.equal(first.created.length, 3);
    const listed = await Workflow.find({ userId: user._id }).sort({ name: 1 });
    assert.equal(listed.length, 3);
    assert.ok(listed.every((row) => row.status === "draft"));
    assert.ok(listed.every((row) => row.trigger.config.seedKey));
    assert.equal(
      listed.find((row) => row.trigger.config.seedKey === "manual-mf-mfc").trigger.type,
      "webhook"
    );
    assert.equal(listed.find((row) => row.trigger.config.seedKey === "bucket-mf").profileKey, "MF");
    assert.equal(listed.find((row) => row.trigger.config.seedKey === "bucket-mfc").profileKey, "MFC");

    const manual = listed.find((row) => row.trigger.config.seedKey === "manual-mf-mfc");
    await Workflow.updateOne({ _id: manual._id }, { $set: { name: "Kept name", status: "published" } });
    await Workflow.deleteOne({ "trigger.config.seedKey": "bucket-mf" });

    const second = await seedDraftWorkflows();
    assert.equal(second.created.length, 1);
    assert.equal(second.created[0].seedKey, "bucket-mf");
    const restored = await Workflow.findOne({ "trigger.config.seedKey": "bucket-mf" });
    assert.equal(restored.status, "draft");
    const kept = await Workflow.findById(manual._id);
    assert.equal(kept.name, "Kept name");
    assert.equal(kept.status, "published");
  });

  test("seed restores intake fields wiped from a published manual workflow", async () => {
    const user = await makeOwner();
    await seedDraftWorkflows();
    const manual = await Workflow.findOne({ "trigger.config.seedKey": "manual-mf-mfc" });
    await Workflow.updateOne(
      { _id: manual._id },
      { $set: { status: "published", "trigger.config": { provider: "jira" } } }
    );

    const second = await seedDraftWorkflows();
    assert.equal(second.created.length, 0);
    assert.equal(second.repaired.length, 1);
    assert.equal(second.repaired[0].seedKey, "manual-mf-mfc");

    const stored = await Workflow.findById(manual._id).lean();
    assert.equal(stored.status, "published");
    assert.equal(stored.trigger.config.provider, "jira");
    assert.equal(stored.trigger.config.seedKey, "manual-mf-mfc");
    assert.equal(stored.trigger.config.intake, "manual");
    assert.deepEqual(stored.trigger.config.profileKeys, ["MF", "MFC"]);
    assert.equal(
      await Workflow.countDocuments({ userId: user._id, name: "Manual MF or MFC ticket" }),
      1
    );

    const fake = createFakeJira({ "MFC-40": issuePayload("MFC-40") });
    const started = await dispatcher.startFromIssue("MFC-40", depsFor(fake));
    assert.equal(started.profileKey, "MFC");
    assert.equal(String(started.workflowId), String(manual._id));
  });

  test("seed repairs the published workflow and drops the duplicate draft", async () => {
    const user = await makeOwner();
    await seedDraftWorkflows();
    const manual = await Workflow.findOne({ "trigger.config.seedKey": "manual-mf-mfc" });
    await Workflow.updateOne(
      { _id: manual._id },
      { $set: { status: "published", "trigger.config": { provider: "jira" } } }
    );
    const duplicate = await Workflow.create({
      name: "Manual MF or MFC ticket",
      status: "draft",
      userId: user._id,
      trigger: {
        type: "webhook",
        enabled: true,
        config: {
          provider: "jira",
          seedKey: "manual-mf-mfc",
          intake: "manual",
          profileKeys: ["MF", "MFC"],
        },
      },
      nodes: [],
      edges: [],
    });

    const second = await seedDraftWorkflows();
    assert.equal(second.created.length, 0);
    assert.equal(second.repaired.length, 1);
    assert.equal(second.repaired[0].id, String(manual._id));
    const stored = await Workflow.findById(manual._id).lean();
    assert.equal(stored.status, "published");
    assert.equal(stored.trigger.config.intake, "manual");
    assert.deepEqual(stored.trigger.config.profileKeys, ["MF", "MFC"]);
    assert.equal(await Workflow.countDocuments({ _id: duplicate._id }), 0);
    assert.equal(
      await Workflow.countDocuments({ userId: user._id, name: "Manual MF or MFC ticket" }),
      1
    );
  });

  test("saving a trigger keeps seed intake fields the editor does not send", () => {
    const next = prepareWorkflowWrite(
      { trigger: { type: "webhook", enabled: true, config: { provider: "jira" } } },
      {
        trigger: {
          type: "webhook",
          enabled: true,
          config: {
            provider: "jira",
            seedKey: "manual-mf-mfc",
            intake: "manual",
            profileKeys: ["MF", "MFC"],
            secret: "keep-me",
          },
        },
      }
    );
    assert.equal(next.trigger.config.provider, "jira");
    assert.equal(next.trigger.config.seedKey, "manual-mf-mfc");
    assert.equal(next.trigger.config.intake, "manual");
    assert.deepEqual(next.trigger.config.profileKeys, ["MF", "MFC"]);
    assert.equal(next.trigger.config.secret, undefined);
  });

  test("seed skips when the owner user is missing", async () => {
    const result = await seedDraftWorkflows();
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "missing_user");
    assert.equal(await Workflow.countDocuments(), 0);
  });

  test("paste stays idle until the manual workflow is published", async () => {
    const user = await makeOwner();
    await seedDraftWorkflows();
    const fake = createFakeJira({ "MF-40": issuePayload("MF-40") });
    await assert.rejects(
      () => dispatcher.startFromIssue("MF-40", depsFor(fake)),
      (err) => err.statusCode === 404 && err.reason === "missing_workflow"
    );
    assert.equal(enqueued.length, 0);

    const manual = await Workflow.findOne({ userId: user._id, "trigger.config.seedKey": "manual-mf-mfc" });
    await Workflow.updateOne({ _id: manual._id }, { $set: { status: "published" } });
    const started = await dispatcher.startFromIssue("MF-40", depsFor(fake));
    assert.equal(started.ok, true);
    assert.equal(started.profileKey, "MF");
    assert.equal(String(started.workflowId), String(manual._id));
  });

  test("paste of MFC uses the published manual workflow", async () => {
    const user = await makeOwner();
    await seedDraftWorkflows();
    await Workflow.updateOne(
      { userId: user._id, "trigger.config.seedKey": "manual-mf-mfc" },
      { $set: { status: "published" } }
    );
    const manual = await Workflow.findOne({ "trigger.config.seedKey": "manual-mf-mfc" });
    const fake = createFakeJira({ "MFC-40": issuePayload("MFC-40") });
    const started = await dispatcher.startFromIssue("MFC-40", depsFor(fake));
    assert.equal(started.profileKey, "MFC");
    assert.equal(String(started.workflowId), String(manual._id));
  });

  test("paste can start the same ticket again after the previous run is cancelled", async () => {
    const user = await makeOwner();
    await seedDraftWorkflows();
    await Workflow.updateOne(
      { userId: user._id, "trigger.config.seedKey": "manual-mf-mfc" },
      { $set: { status: "published" } }
    );
    const fake = createFakeJira({ "MFC-40": issuePayload("MFC-40") });
    const first = await dispatcher.startFromIssue("MFC-40", depsFor(fake));
    await assert.rejects(
      () => dispatcher.startFromIssue("MFC-40", depsFor(fake)),
      (err) => err.statusCode === 409 && err.reason === "duplicate"
    );
    await TicketRun.updateOne({ runId: first.runId }, { $set: { state: "cancelled" } });
    const second = await dispatcher.startFromIssue("MFC-40", depsFor(fake));
    assert.equal(second.ok, true);
    assert.notEqual(second.runId, first.runId);
  });

  test("paste starts a new run when the previous run already failed", async () => {
    const user = await makeOwner();
    await seedDraftWorkflows();
    await Workflow.updateOne(
      { userId: user._id, "trigger.config.seedKey": "manual-mf-mfc" },
      { $set: { status: "published" } }
    );
    const fake = createFakeJira({ "MFC-40": issuePayload("MFC-40") });
    const first = await dispatcher.startFromIssue("MFC-40", depsFor(fake));
    await Run.updateOne({ _id: first.runId }, { $set: { status: "failed" } });
    const second = await dispatcher.startFromIssue("MFC-40", depsFor(fake));
    assert.equal(second.ok, true);
    assert.notEqual(second.runId, first.runId);
  });

  test("bucket poll for MF/MFC waits until that bucket workflow is published", async () => {
    const user = await makeOwner();
    await seedDraftWorkflows();
    const fake = createFakeJira({
      "MF-41": issuePayload("MF-41"),
      "MFC-41": issuePayload("MFC-41"),
    });
    const idle = await dispatcher.dispatch({ dryRun: false, ...depsFor(fake) });
    const idleMf = idle.profiles.find((row) => row.jiraKey === "MF");
    const idleMfc = idle.profiles.find((row) => row.jiraKey === "MFC");
    assert.ok(idleMf.skipped.some((item) => item.reason === "missing_workflow"));
    assert.ok(idleMfc.skipped.some((item) => item.reason === "missing_workflow"));
    assert.equal(enqueued.length, 0);

    await Workflow.updateOne(
      { userId: user._id, "trigger.config.seedKey": "bucket-mf" },
      { $set: { status: "published" } }
    );
    const live = await dispatcher.dispatch({ dryRun: false, ...depsFor(fake) });
    const mf = live.profiles.find((row) => row.jiraKey === "MF");
    const mfc = live.profiles.find((row) => row.jiraKey === "MFC");
    assert.equal(mf.started.length, 1);
    assert.equal(mf.started[0].jiraKey, "MF-41");
    assert.ok(mfc.skipped.some((item) => item.reason === "missing_workflow"));
    assert.equal(enqueued.length, 1);
  });

  test("manual intake resolves MFC repos at runtime", () => {
    const workflow = {
      trigger: { type: "webhook", config: { intake: "manual", profileKeys: ["MF", "MFC"] } },
      repository: {
        location: profiles.MF.repo.location,
        defaultBranch: "main",
        credentialRef: "GITHUB_TOKEN",
      },
    };
    const node = {
      id: "gitApp",
      type: "gitBranch",
      config: {
        role: "app",
        repository: {
          location: profiles.MF.repo.location,
          defaultBranch: "main",
          credentialRef: "GITHUB_TOKEN",
          owner: "Vxceed-IN",
          repo: "Fuji-Vue3",
        },
      },
    };
    const autoNode = {
      id: "gitAuto",
      type: "gitBranch",
      config: {
        role: "automation",
        repository: {
          location: profiles.QUT.repo.location,
          defaultBranch: "main",
          credentialRef: "GITHUB_TOKEN",
          owner: "Vxceed-IN",
          repo: "vxc-ui-automation",
        },
      },
    };
    const input = { issueKey: "MFC-9", profileKey: "MFC", jira: { key: "MFC-9" } };
    const appRepo = lifecycle.repositoryForNode(node, input, workflow);
    const autoRepo = lifecycle.repositoryForNode(autoNode, input, workflow);
    assert.equal(appRepo.location, profiles.MFC.repo.location);
    assert.equal(appRepo.repo, "Mt-Fuji-Central");
    assert.equal(autoRepo.location, profiles.TAC.repo.location);
    assert.equal(autoRepo.repo, "central-ui-automation");
  });

  test("jira description named rules are force-included", async () => {
    const mentioned = rulesService.rulesMentionedInTicket(
      {
        summary: "Grid work",
        descriptionText: "Jira rules:\nFollow vxceed-grid-rules.mdc and testing-validation-rules.",
      },
      FUJI_FIXTURE
    );
    assert.ok(mentioned.includes(".cursor/rules/vxceed-grid-rules.mdc"));
    assert.ok(mentioned.includes(".cursor/rules/testing-validation-rules.mdc"));
    const result = await lifecycle.cursorPrompt(
      { id: "promptPlan", type: "cursorPrompt", config: { mode: "plan" } },
      {
        issueKey: "MF-1",
        profileKey: "MF",
        jira: {
          key: "MF-1",
          summary: "Grid work",
          descriptionText: "Jira rules:\nFollow vxceed-grid-rules.mdc",
        },
        worktreePath: FUJI_FIXTURE,
      },
      { runId: "a".repeat(24) }
    );
    const grid = result.rulesManifest.rules.find((rule) => rule.file === ".cursor/rules/vxceed-grid-rules.mdc");
    assert.equal(grid.reason, "forced");
  });
});
