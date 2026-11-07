const axios = require("axios");
const config = require("../../config");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getAtPath(obj, path) {
  if (path == null || typeof path !== "string") return undefined;
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function interpolateMessage(template, input) {
  if (typeof template !== "string") return "";
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const v = getAtPath(input, key.trim());
    if (v === undefined || v === null) return "";
    if (typeof v === "object") return JSON.stringify(v).slice(0, 200);
    return String(v);
  });
}

function evaluateCondition(input, cfg) {
  const field = typeof cfg.field === "string" ? cfg.field : "";
  const op = typeof cfg.operator === "string" ? cfg.operator : "truthy";
  const val = field ? getAtPath(input, field) : input;

  switch (op) {
    case "exists":
      return field ? getAtPath(input, field) !== undefined : input != null;
    case "equals":
      return val === cfg.value;
    case "truthy":
    default:
      return Boolean(field ? getAtPath(input, field) : input);
  }
}

async function executeNode(node, input, runState) {
  const cfg = node.config && typeof node.config === "object" ? node.config : {};

  switch (node.type) {
    case "http": {
      const headers =
        cfg.headers &&
        typeof cfg.headers === "object" &&
        !Array.isArray(cfg.headers)
          ? cfg.headers
          : {};
      const res = await axios({
        method: cfg.method || "GET",
        url: cfg.url,
        headers,
        data: cfg.body !== undefined ? cfg.body : {},
        timeout: config.httpTimeoutMs,
      });
      return res.data;
    }

    case "condition":
      return evaluateCondition(input, cfg);

    case "delay": {
      let sec = Number(cfg.seconds);
      if (!Number.isFinite(sec) || sec < 0) sec = 0;
      if (sec > 60) sec = 60;
      await sleep(Math.round(sec * 1000));
      return input;
    }

    case "jira":
    case "jiraUpdate":
    case "analysis":
    case "cursorPrompt":
    case "gitBranch":
    case "cursorAgent":
    case "rulesChecks":
    case "testSelect":
    case "playwright":
    case "githubPr":
      return require("./lifecycle")[node.type](node, input, runState);

    case "approval": {
      const decision = runState && runState.decision;
      if (decision === "approved" || decision === "rejected") {
        const base =
          input && typeof input === "object" && !Array.isArray(input)
            ? { ...input }
            : { payload: input };
        const branch =
          base.branch === "true" || base.branch === "false"
            ? base.branch
            : decision === "approved"
              ? "true"
              : "false";
        const stored = runState && runState.approval;
        const planApproval =
          stored && stored.planHash
            ? {
                decision: stored.decision,
                planHash: stored.planHash,
                fingerprint: stored.fingerprint,
                expiresAt: stored.expiresAt,
                baseSha: stored.baseSha,
                approvedBy: stored.userId,
                approvedAt: stored.decidedAt,
              }
            : base.planApproval;
        return { ...base, branch, planApproval };
      }
      return { control: "wait", kind: "approval", output: input };
    }

    case "notify": {
      const slack = require("../services/slackService");
      const raw =
        typeof cfg.message === "string" ? cfg.message : "Workflow notification";
      const text = interpolateMessage(raw, input);
      const typed = typeof cfg.eventType === "string" ? cfg.eventType.trim() : "";
      const type = slack.EVENT_TYPE_SET.has(typed) ? typed : "notify";
      const runId = runState && runState.runId;
      const result = await slack.emit(runId, type, {
        reason: text,
        message: text,
        nodeId: node.id,
        jiraKey: input && (input.issueKey || (input.jira && input.jira.key)),
        project: input && input.profileKey,
        prUrl: input && input.prUrl,
        stage: cfg.stage,
      });
      const payload =
        input && typeof input === "object" && !Array.isArray(input)
          ? { ...input }
          : { payload: input };
      payload.message = text;
      payload.eventType = type;
      if (result && (result.skipped || result.status === "logged")) payload._notifySkipped = true;
      return payload;
    }

    default:
      throw new Error(`Unknown node type: ${node.type}`);
  }
}

module.exports = { executeNode, getAtPath, evaluateCondition };
