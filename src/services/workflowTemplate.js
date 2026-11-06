const fs = require("fs");
const path = require("path");

const TEMPLATE_DIR = path.join(__dirname, "..", "..", "config", "workflow-templates");

function loadTemplate(kind) {
  const file = path.join(TEMPLATE_DIR, `${kind}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function repositoryFromProfile(profile) {
  return {
    location: profile.repo.location,
    defaultBranch: profile.repo.defaultBranch,
    credentialRef: profile.repo.credentialRef,
    owner: profile.repo.github.owner,
    repo: profile.repo.github.repo,
  };
}

function appNameFor(profile) {
  const location = String(profile.repo && profile.repo.location ? profile.repo.location : "")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (location.includes("mt-fuji-central") || location.includes("fuji-central")) return "central";
  return "fuji";
}

function ui(col, row) {
  return { __ui: { position: { x: 80 + col * 240, y: 40 + row * 130 } } };
}

function add(nodes, node) {
  nodes.push(node);
  return node.id;
}

function edge(edges, from, to, condition) {
  const row = { from, to };
  if (condition === "true" || condition === "false") row.condition = condition;
  edges.push(row);
}

function notify(id, eventType, message, stage, extra) {
  return {
    id,
    type: "notify",
    config: {
      title: eventType,
      eventType,
      message,
      stage,
      retries: 1,
      ...extra,
    },
  };
}

function jiraStop(id, extra) {
  return {
    id,
    type: "jiraUpdate",
    config: {
      title: "Jira blocked",
      transition: "blocked",
      retries: 1,
      ticketStage: "blocked",
      action: "blocked",
      comment: "{{reason}}",
      ...extra,
    },
  };
}

function stopPair(nodes, edges, ids, notifyNode, jiraNode, col, row) {
  add(nodes, { ...notifyNode, config: { ...notifyNode.config, ...ui(col, row) } });
  add(nodes, { ...jiraNode, config: { ...jiraNode.config, ...ui(col, row + 1) } });
  edge(edges, ids[0], ids[1]);
}

function playwrightConfig(profile, linked) {
  return {
    title: "Playwright",
    role: "app",
    ticketKind: "app",
    strategy: "external-repo",
    target: "local-worktree",
    appCommand: Array.isArray(profile.repo.appCommand) ? profile.repo.appCommand : [],
    readiness: profile.repo.readiness || "/",
    testCommand: Array.isArray(linked.repo.testCommand) ? linked.repo.testCommand : [],
    testRepository: {
      location: linked.repo.location,
      defaultBranch: linked.repo.defaultBranch,
      credentialRef: linked.repo.credentialRef,
    },
    credentialFiles: Array.isArray(linked.repo.credentialFiles) ? linked.repo.credentialFiles : [],
    sourceRepoPath: linked.repo.location,
    appCredentialFiles: Array.isArray(profile.repo.credentialFiles) ? profile.repo.credentialFiles : [],
    appSourceRepoPath: profile.repo.location,
    app: appNameFor(profile),
    repository: repositoryFromProfile(profile),
  };
}

function agentConfig(profile, mode, extra) {
  return {
    title: `Agent ${mode}`,
    role: "app",
    mode,
    retries: 1,
    repository: repositoryFromProfile(profile),
    ...extra,
  };
}

function promptConfig(mode) {
  return { title: `Prompt ${mode}`, mode, role: "app" };
}

function maxFixAttemptsOf(profile) {
  const value = profile && profile.agent && profile.agent.maxFixAttempts;
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : 2;
}

function buildAppTicketWorkflow(profile, linked, template) {
  const spec = template || loadTemplate("app-ticket");
  const maxFix = maxFixAttemptsOf(profile);
  const repo = repositoryFromProfile(profile);
  const nodes = [];
  const edges = [];

  add(nodes, {
    id: "fetch",
    type: "jira",
    config: { title: "Fetch Jira", ...ui(0, 0) },
  });
  add(nodes, {
    id: "claim",
    type: "jiraUpdate",
    config: {
      title: "Claim",
      transition: "claim",
      retries: 1,
      ticketStage: "claimed",
      action: "claim",
      ...ui(0, 1),
    },
  });
  add(nodes, {
    id: "gitApp",
    type: "gitBranch",
    config: { title: "App worktree", role: "app", repository: repo, ...ui(0, 2) },
  });
  add(nodes, {
    id: "promptPlan",
    type: "cursorPrompt",
    config: { ...promptConfig("plan"), ...ui(0, 3) },
  });
  add(nodes, {
    id: "agentPlan",
    type: "cursorAgent",
    config: { ...agentConfig(profile, "plan"), ...ui(0, 4) },
  });
  add(nodes, {
    id: "approvePlan",
    type: "approval",
    config: { title: "Approve plan", ...ui(1, 4) },
  });
  add(nodes, {
    id: "promptImpl",
    type: "cursorPrompt",
    config: { ...promptConfig("implement"), ...ui(2, 3) },
  });
  add(nodes, {
    id: "agentImpl",
    type: "cursorAgent",
    config: { ...agentConfig(profile, "implement"), ...ui(2, 4) },
  });

  edge(edges, "fetch", "claim");
  edge(edges, "claim", "gitApp");
  edge(edges, "gitApp", "promptPlan");
  edge(edges, "promptPlan", "agentPlan");
  edge(edges, "agentPlan", "approvePlan", "true");
  edge(edges, "approvePlan", "promptImpl", "true");
  edge(edges, "promptImpl", "agentImpl");

  stopPair(
    nodes,
    edges,
    spec.stops.plan,
    notify("notifyPlanFailed", "gate_failed", "Stopped: plan did not stay clean", "planning"),
    jiraStop("jiraPlanFailed", { ticketStage: "blocked" }),
    0,
    6
  );
  stopPair(
    nodes,
    edges,
    spec.stops.rejected,
    notify("notifyPlanRejected", "plan_rejected", "Stopped: you rejected the plan", "awaiting_approval"),
    {
      id: "jiraPlanRejected",
      type: "jiraUpdate",
      config: {
        title: "Jira rejected",
        transition: "blocked",
        retries: 1,
        ticketStage: "rejected",
        action: "blocked",
        comment: "Plan rejected",
      },
    },
    1,
    6
  );
  stopPair(
    nodes,
    edges,
    spec.stops.agent,
    notify("notifyAgentFailed", "gate_failed", "Stopped: implementation did not produce a clean commit", "implementing"),
    jiraStop("jiraAgentFailed"),
    2,
    6
  );
  stopPair(
    nodes,
    edges,
    spec.stops.env,
    notify("notifyEnv", "env_failed", "Stopped: environment or credential guard", "verifying"),
    jiraStop("jiraEnv"),
    8,
    0
  );
  stopPair(
    nodes,
    edges,
    spec.stops.gate,
    notify("notifyGate", "gate_failed", "Stopped: rules or lint or build still failing", "gates"),
    jiraStop("jiraGate"),
    8,
    2
  );
  stopPair(
    nodes,
    edges,
    spec.stops.rules,
    notify("notifyRules", "rules_violation", "Stopped: rules review still failing", "rules_review"),
    jiraStop("jiraRules"),
    8,
    4
  );
  stopPair(
    nodes,
    edges,
    spec.stops.playwright,
    notify("notifyPlaywright", "playwright_failed", "Stopped: Playwright still failing after retries", "playwright"),
    jiraStop("jiraPlaywright"),
    8,
    6
  );

  edge(edges, "agentPlan", "notifyPlanFailed", "false");
  edge(edges, "approvePlan", "notifyPlanRejected", "false");

  add(nodes, {
    id: "agentIsEnv",
    type: "condition",
    config: { field: "guardFailed", operator: "truthy", value: "", ...ui(2, 5) },
  });
  edge(edges, "agentImpl", "agentIsEnv", "false");
  edge(edges, "agentIsEnv", "notifyEnv", "true");
  edge(edges, "agentIsEnv", "notifyAgentFailed", "false");

  const verifyCount = maxFix + 1;
  let previousAgent = "agentImpl";

  for (let n = 0; n < verifyCount; n += 1) {
    const col = 3 + n;
    const rulesId = `v${n}_rules`;
    const reviewPromptId = `v${n}_rprompt`;
    const reviewId = `v${n}_review`;
    const selectId = `v${n}_select`;
    const pwId = `v${n}_pw`;
    const isEnvId = `v${n}_isEnv`;
    const canFixId = `v${n}_canFix`;
    const last = n === verifyCount - 1;

    add(nodes, {
      id: rulesId,
      type: "rulesChecks",
      config: {
        title: `Rules checks ${n + 1}`,
        role: "app",
        repository: repo,
        ...ui(col, 0),
      },
    });
    add(nodes, {
      id: reviewPromptId,
      type: "cursorPrompt",
      config: { ...promptConfig("review"), ...ui(col, 1) },
    });
    add(nodes, {
      id: reviewId,
      type: "cursorAgent",
      config: {
        ...agentConfig(profile, "review", { attempt: n + 1, maxFixAttempts: maxFix }),
        ...ui(col, 2),
      },
    });
    add(nodes, {
      id: selectId,
      type: "testSelect",
      config: { title: "Select tests", mode: "app", role: "app", ...ui(col, 3) },
    });
    add(nodes, {
      id: pwId,
      type: "playwright",
      config: { ...playwrightConfig(profile, linked), title: `Playwright ${n + 1}`, ...ui(col, 4) },
    });
    add(nodes, {
      id: isEnvId,
      type: "condition",
      config: {
        field: "failureClassification.value.classification",
        operator: "equals",
        value: "env",
        ...ui(col, 5),
      },
    });
    add(nodes, {
      id: canFixId,
      type: "condition",
      config: {
        field: "failureClassification.routing.retryable",
        operator: "equals",
        value: true,
        ...ui(col, 6),
      },
    });

    edge(edges, previousAgent, rulesId, "true");
    edge(edges, rulesId, reviewPromptId, "true");
    edge(edges, reviewPromptId, reviewId);
    edge(edges, reviewId, selectId, "true");
    edge(edges, selectId, pwId);
    edge(edges, pwId, "pr", "true");
    edge(edges, pwId, isEnvId, "false");
    edge(edges, isEnvId, "notifyEnv", "true");
    edge(edges, isEnvId, canFixId, "false");

    if (last) {
      edge(edges, rulesId, "notifyGate", "false");
      edge(edges, reviewId, "notifyRules", "false");
      edge(edges, canFixId, "notifyPlaywright", "true");
      edge(edges, canFixId, "notifyPlaywright", "false");
    } else {
      const fixPromptId = `f${n + 1}_prompt`;
      const fixAgentId = `f${n + 1}_agent`;
      add(nodes, {
        id: fixPromptId,
        type: "cursorPrompt",
        config: { ...promptConfig("fix"), ...ui(col, 7) },
      });
      add(nodes, {
        id: fixAgentId,
        type: "cursorAgent",
        config: { ...agentConfig(profile, "fix"), ...ui(col, 8) },
      });
      edge(edges, rulesId, fixPromptId, "false");
      edge(edges, reviewId, fixPromptId, "false");
      edge(edges, canFixId, fixPromptId, "true");
      edge(edges, canFixId, "notifyPlaywright", "false");
      edge(edges, fixPromptId, fixAgentId);
      edge(edges, fixAgentId, "agentIsEnv", "false");
      previousAgent = fixAgentId;
    }
  }

  add(nodes, {
    id: "pr",
    type: "githubPr",
    config: {
      title: "Open pull request",
      role: "app",
      retries: 1,
      repository: repo,
      ...ui(7, 4),
    },
  });
  add(nodes, {
    ...notify("notifyPr", "pr_created", "Done: {{prUrl}}", "pr_open"),
    config: {
      ...notify("notifyPr", "pr_created", "Done: {{prUrl}}", "pr_open").config,
      ...ui(7, 5),
    },
  });
  add(nodes, {
    id: "jiraReview",
    type: "jiraUpdate",
    config: {
      title: "Jira in review",
      transition: "review",
      retries: 1,
      ticketStage: "completed",
      action: "review",
      comment: "Pull request: {{prUrl}}",
      ...ui(7, 6),
    },
  });
  edge(edges, "pr", "notifyPr", "true");
  edge(edges, "pr", "notifyEnv", "false");
  edge(edges, "notifyPr", "jiraReview");

  return {
    kind: spec.kind,
    name: String(spec.name || "{{jiraKey}} app ticket").split("{{jiraKey}}").join(profile.jiraKey),
    profileKey: profile.jiraKey,
    runtime: "host",
    retention: { keepWorktreeOnFailure: true, worktreeDays: 7 },
    repository: {
      location: profile.repo.location,
      defaultBranch: profile.repo.defaultBranch,
      credentialRef: profile.repo.credentialRef,
    },
    nodes,
    edges,
    maxFixAttempts: maxFix,
  };
}

function buildProjectWorkflow(profile, linked, options = {}) {
  if (!profile || profile.kind !== "app") {
    throw new Error("app-ticket template requires an app profile");
  }
  if (!linked || linked.kind !== "automation") {
    throw new Error("app-ticket template requires a linked automation profile");
  }
  const template = options.template || loadTemplate("app-ticket");
  if (template.kind !== "app-ticket") {
    throw new Error(`Unexpected template kind ${template.kind}`);
  }
  return buildAppTicketWorkflow(profile, linked, template);
}

function outgoing(edges, id) {
  return edges.filter((row) => row.from === id);
}

function startNode(nodes, edges) {
  const incoming = new Set(edges.map((row) => row.to));
  return nodes.find((node) => node.id && !incoming.has(node.id));
}

function terminalPaths(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const start = startNode(nodes, edges);
  if (!start) return [];
  const paths = [];
  function walk(id, trail) {
    const next = outgoing(edges, id);
    const pathIds = trail.concat(id);
    if (!next.length) {
      paths.push(pathIds.map((item) => byId.get(item)).filter(Boolean));
      return;
    }
    for (const row of next) walk(row.to, pathIds);
  }
  walk(start.id, []);
  return paths;
}

function everyTerminalPathHasNotify(nodes, edges) {
  const paths = terminalPaths(nodes, edges);
  if (!paths.length) return false;
  return paths.every((path) => path.some((node) => node.type === "notify"));
}

function notifyThenJiraOnStops(nodes, edges) {
  const paths = terminalPaths(nodes, edges);
  return paths.every((path) => {
    const types = path.map((node) => node.type);
    const notifyAt = types.lastIndexOf("notify");
    const jiraAt = types.lastIndexOf("jiraUpdate");
    if (notifyAt < 0) return false;
    if (jiraAt < 0) return true;
    return notifyAt < jiraAt;
  });
}

module.exports = {
  TEMPLATE_DIR,
  loadTemplate,
  repositoryFromProfile,
  maxFixAttemptsOf,
  buildProjectWorkflow,
  terminalPaths,
  everyTerminalPathHasNotify,
  notifyThenJiraOnStops,
};
