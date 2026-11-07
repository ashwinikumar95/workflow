const { z } = require("zod");

const CLASSIFICATIONS = [
  "app-bug",
  "script-bug",
  "test-outdated",
  "env",
  "data-issue",
  "unknown",
];

const PLAYWRIGHT_ENV = new Set(["env", "bootstrap", "timeout", "missing-report"]);

const failureClassificationSchema = z.object({
  classification: z.enum(CLASSIFICATIONS),
  summary: z.string().min(1),
  evidence: z.union([z.string().min(1), z.array(z.string())]),
  recommendedAction: z.string().min(1),
  retryable: z.boolean(),
});

function normalize(value) {
  const parsed = failureClassificationSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_classification",
      value: {
        classification: "unknown",
        summary: "Classification was missing or invalid",
        evidence: [],
        recommendedAction: "stop_unknown",
        retryable: false,
      },
    };
  }
  return { ok: true, value: parsed.data };
}

function fromPlaywrightOutcome(outcome) {
  const failureClass = outcome && outcome.failureClass;
  if (PLAYWRIGHT_ENV.has(failureClass) || (outcome && outcome.reason === "env")) {
    return normalize({
      classification: "env",
      summary: (outcome && (outcome.reason || outcome.failureClass)) || "environment failure",
      evidence: [String((outcome && outcome.reason) || failureClass || "env")],
      recommendedAction: "stop_env",
      retryable: false,
    });
  }
  return null;
}

function routeFailure({ classification, kind, baseline, inOwnScenario } = {}) {
  const parsed = CLASSIFICATIONS.includes(classification) ? classification : "unknown";
  const ticketKind = kind === "automation" ? "automation" : "app";
  const preexisting =
    baseline &&
    baseline.blocks === false &&
    Array.isArray(baseline.rows) &&
    baseline.rows.some((row) => row && row.meaning === "pre-existing");

  if (preexisting && inOwnScenario !== true && parsed !== "env") {
    return {
      action: "list_preexisting",
      classification: parsed,
      retryable: false,
      block: false,
      notify: null,
      jiraComment: true,
    };
  }

  if (parsed === "app-bug") {
    if (ticketKind === "automation") {
      return {
        action: "report_and_block",
        classification: parsed,
        retryable: false,
        block: true,
        notify: "app_bug_blocked",
        jiraComment: true,
      };
    }
    return {
      action: "fix_app",
      classification: parsed,
      retryable: true,
      block: true,
      notify: "playwright_failed",
      jiraComment: false,
    };
  }

  if (parsed === "script-bug" || parsed === "test-outdated") {
    if (ticketKind === "automation") {
      return {
        action: "fix_script",
        classification: parsed,
        retryable: true,
        block: true,
        notify: "playwright_failed",
        jiraComment: false,
      };
    }
    return {
      action: "linked_automation_run",
      classification: parsed,
      retryable: true,
      block: true,
      notify: "playwright_failed",
      jiraComment: false,
    };
  }

  if (parsed === "env") {
    return {
      action: "stop_env",
      classification: parsed,
      retryable: false,
      block: true,
      notify: "env_failed",
      jiraComment: true,
    };
  }

  return {
    action: "stop_unknown",
    classification: parsed,
    retryable: false,
    block: true,
    notify: parsed === "data-issue" ? "playwright_failed" : "playwright_failed",
    jiraComment: true,
  };
}

function classifyFailure({ outcome, agentResult, baseline, kind, inOwnScenario } = {}) {
  const fromOutcome = fromPlaywrightOutcome(outcome);
  if (fromOutcome) {
    return { ...fromOutcome, routing: routeFailure({ classification: "env", kind, baseline, inOwnScenario }) };
  }
  if (agentResult && typeof agentResult === "object") {
    const source = agentResult.classification && typeof agentResult.classification === "object"
      ? agentResult.classification
      : agentResult;
    const parsed = normalize(source);
    return { ...parsed, routing: routeFailure({ classification: parsed.value.classification, kind, baseline, inOwnScenario }) };
  }
  const unknown = normalize({
    classification: "unknown",
    summary: "No classification was produced",
    evidence: [],
    recommendedAction: "stop_unknown",
    retryable: false,
  });
  return {
    ...unknown,
    routing: routeFailure({ classification: "unknown", kind, baseline, inOwnScenario }),
  };
}

module.exports = {
  CLASSIFICATIONS,
  failureClassificationSchema,
  normalize,
  fromPlaywrightOutcome,
  routeFailure,
  classifyFailure,
};
