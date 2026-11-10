const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const Run = require("../src/models/Run");
const engine = require("../src/services/executionengine");
const { recordDecision } = require("../src/services/approvalService");
const { setResumeEnqueue } = require("../src/services/waitCompletion");
const rulesChecks = require("../src/services/rulesChecks");
const { buildProjectWorkflow } = require("../src/services/workflowTemplate");
const {
  buildReviewPrompt,
  buildImplementPrompt,
  buildFixFeedback,
} = require("../src/services/cursorPromptService");
const { connectTestDb, disconnectTestDb, createPublishedWorkflow } = require("../test-support/helpers");

function stubProfile(kind, extra = {}) {
  return {
    jiraKey: kind === "app" ? "MF" : "QUT",
    kind,
    linkedProfile: kind === "app" ? "QUT" : "MF",
    enabled: true,
    repo: {
      location: "D:/tmp/app",
      defaultBranch: "main",
      github: { owner: "Vxceed-IN", repo: kind === "app" ? "Fuji-Vue3" : "automation" },
      credentialRef: "GITHUB_TOKEN",
      credentialFiles: [".env"],
    },
    agent: { model: "composer-2.5", maxFixAttempts: 2 },
    ...extra,
  };
}

describe("review and fix loop", () => {
  test("normalizeReview accepts finding-style review output", () => {
    const moved = rulesChecks.normalizeReview({
      confirmed: [
        {
          severity: "medium",
          evidence: "+      const sourceList = PageConfig.getSearchParameter(this.pageConfigResponse, 'PURCHASEORDERSOURCE') || []",
          finding: "In purchase-order-grid-v2, getPurchaseOrderSourceLabel reloads PURCHASEORDERSOURCE on every cell render.",
        },
      ],
      potential: [
        {
          severity: "medium",
          evidence: "+        return text.includes('recommend')",
          finding: "recommendationSourceValue infers the source id from display text.",
        },
      ],
      uncertainties: [
        {
          severity: "low",
          evidence: "+          options: this.buildPurchaseOrderSourceFilterOptions(),",
          finding: "Source filter options are built once at mount.",
        },
      ],
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.value.confirmed.length, 0);
    assert.equal(moved.value.potential.length, 2);
    assert.match(moved.value.potential[0].detail, /purchase-order-grid-v2/);
    assert.equal(moved.value.potential[0].rule, "unspecified");
    assert.equal(moved.value.uncertainties[0].question.includes("built once"), true);
  });

  test("review prompt names every required field", () => {
    const text = buildReviewPrompt({
      issue: { summary: "MF-28985", descriptionText: "frontend" },
      artifactPath: "D:/tmp/review.json",
    });
    for (const field of ["rule", "file", "line", "detail", "severity", "evidence", "whatWouldConfirm", "question"]) {
      assert.match(text, new RegExp(field));
    }
    assert.match(text, /high, medium, or low/);
    assert.match(text, /line is an integer/);
  });

  test("invalid review is retried once and a second invalid review stops", () => {
    const graph = buildProjectWorkflow(stubProfile("app"), stubProfile("automation"));
    const from = (id) => graph.edges.filter((edge) => edge.from === id);
    assert.deepEqual(
      from("v0_review").map((edge) => `${edge.condition || ""}:${edge.to}`).sort(),
      ["false:v0_reviewBad", "true:v0_select"]
    );
    assert.equal(from("v0_reviewBad").find((edge) => edge.condition === "true").to, "v0_rprompt2");
    assert.equal(from("v0_reviewBad").find((edge) => edge.condition === "false").to, "vf1_prompt");
    const prompt2 = graph.nodes.find((node) => node.id === "v0_rprompt2");
    assert.equal(prompt2.config.reviewRetry, true);
    assert.equal(from("v0_reviewBad2").find((edge) => edge.condition === "true").to, "notifyRules");
    assert.equal(from("v0_reviewBad2").find((edge) => edge.condition === "false").to, "vf1_prompt");
    const last = graph.nodes.find((node) => node.id === "v2_reviewBad2");
    assert.ok(last);
    assert.equal(from("v2_reviewBad2").every((edge) => edge.to === "notifyRules"), true);
  });

  test("fix prompt includes the confirmed finding", () => {
    const feedback = buildFixFeedback({
      review: {
        confirmed: [
          {
            rule: "vxceed-grid-rules.mdc",
            file: "src/components/purchase-order-grid-v2.vue",
            line: 12,
            detail: "lookup runs inside the cell renderer",
            severity: "medium",
            evidence: "+ const sourceList = PageConfig.getSearchParameter()",
          },
        ],
      },
    });
    const text = buildImplementPrompt({
      issue: { summary: "MF-28985", descriptionText: "frontend" },
      plan: { approach: "lock the form" },
      feedback,
      clarifications: [{ question: "Lock the whole form?", answer: "Yes, header and lines." }],
      fix: true,
      artifactPath: "D:/tmp/result.json",
    });
    assert.match(text, /lookup runs inside the cell renderer/);
    assert.match(text, /Clarifications \(binding\)/);
    assert.match(text, /Yes, header and lines/);
    assert.match(text, /make a commit only if files changed/);
  });
});

describe("failure stamp", { concurrency: false }, () => {
  before(async () => {
    await connectTestDb();
  });

  after(async () => {
    await disconnectTestDb();
  });

  test("a false branch records log.error and run.failure once", async () => {
    assert.deepEqual(engine.branchFailureStamp("v0_review", { branch: "false", reason: "invalid_review" }), {
      nodeId: "v0_review",
      reason: "invalid_review",
    });
    assert.equal(engine.branchFailureStamp("v0_review", { branch: "true", reason: "ok" }), null);

    const workflow = await createPublishedWorkflow([{ id: "v0_review", type: "condition", config: {} }]);
    const run = await Run.create({
      workflowId: workflow._id,
      jobId: `failure-stamp-${Date.now()}`,
      status: "running",
      logs: [],
      context: {},
      currentNodeId: "v0_review",
      executionClaim: "T",
      executionClaimExpiresAt: new Date(Date.now() + 60000),
    });
    const first = await engine.persistRun(run._id, "T", {
      context: { reason: "invalid_review", branch: "false" },
      currentNodeId: "v0_rprompt2",
      status: "running",
      failure: { nodeId: "v0_review", reason: "invalid_review" },
      log: { nodeId: "v0_review", status: "success", error: "invalid_review" },
    });
    assert.equal(first.logs[0].error, "invalid_review");
    assert.equal(first.failure.nodeId, "v0_review");
    assert.equal(first.failure.reason, "invalid_review");

    const second = await engine.persistRun(run._id, "T", {
      context: { reason: "no-commit", branch: "false" },
      currentNodeId: "notifyAgentFailed",
      status: "running",
      failure: { nodeId: "vf1_agent", reason: "no-commit" },
      log: { nodeId: "vf1_agent", status: "success", error: "no-commit" },
    });
    assert.equal(second.failure.nodeId, "v0_review");
    assert.equal(second.failure.reason, "invalid_review");
    assert.equal(second.logs[1].error, "no-commit");
  });

  test("approvePlan requires an answer for each plan question", async () => {
    const workflow = await createPublishedWorkflow([{ id: "approvePlan", type: "approval", config: {} }]);
    const run = await Run.create({
      workflowId: workflow._id,
      jobId: `plan-questions-${Date.now()}`,
      status: "waiting",
      context: {
        planHash: "hash-1",
        plan: { questions: ["Lock the whole form?", "Which source value?"] },
      },
      wait: {
        kind: "approval",
        nodeId: "approvePlan",
        state: "pending",
        externalJobId: "approval-plan-questions",
        resumeJobId: "resume-approval-plan-questions",
      },
    });
    const missing = await recordDecision(run._id, "approved", "user-1", {
      planHash: "hash-1",
      answers: ["Yes"],
    });
    assert.equal(missing.http, 400);
    setResumeEnqueue(async () => {});
    try {
      const saved = await recordDecision(run._id, "approved", "user-1", {
        planHash: "hash-1",
        answers: ["Yes, header and lines.", "Value 1."],
      });
      assert.equal(saved.http, 200);
      assert.equal(saved.run.approval.clarifications[1].answer, "Value 1.");
    } finally {
      setResumeEnqueue(null);
    }
  });
});
