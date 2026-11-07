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
      title: "Jira comment",
      retries: 1,
      ticketStage: "blocked",
      action: "comment",
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

function playwrightConfig(appProfile, autoProfile, extra = {}) {
  const ticketKind = extra.ticketKind || "app";
  const role = extra.role || (ticketKind === "automation" ? "automation" : "app");
  return {
    title: extra.title || "Playwright",
    role,
    ticketKind,
    strategy: "external-repo",
    target: "local-worktree",
    appCommand: Array.isArray(appProfile.repo.appCommand) ? appProfile.repo.appCommand : [],
    readiness: appProfile.repo.readiness || "/",
    testCommand: Array.isArray(autoProfile.repo.testCommand) ? autoProfile.repo.testCommand : [],
    testRepository: {
      location: autoProfile.repo.location,
      defaultBranch: autoProfile.repo.defaultBranch,
      credentialRef: autoProfile.repo.credentialRef,
    },
    credentialFiles: Array.isArray(autoProfile.repo.credentialFiles) ? autoProfile.repo.credentialFiles : [],
    sourceRepoPath: autoProfile.repo.location,
    appCredentialFiles: Array.isArray(appProfile.repo.credentialFiles) ? appProfile.repo.credentialFiles : [],
    appSourceRepoPath: appProfile.repo.location,
    app: appNameFor(appProfile),
    repository: repositoryFromProfile(role === "automation" ? autoProfile : appProfile),
  };
}

function agentConfig(profile, mode, extra) {
  return {
    title: `Agent ${mode}`,
    role: extra && extra.role ? extra.role : "app",
    mode,
    retries: 1,
    repository: repositoryFromProfile(profile),
    ...extra,
  };
}

function promptConfig(mode, extra = {}) {
  return { title: `Prompt ${mode}`, mode, role: extra.role || "app", ...extra };
}

function maxFixAttemptsOf(profile) {
  const value = profile && profile.agent && profile.agent.maxFixAttempts;
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : 2;
}

function credentialFilesOf(profile) {
  return Array.isArray(profile.repo.credentialFiles) ? profile.repo.credentialFiles : [];
}

function addCommonStops(nodes, edges, spec) {
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
    jiraStop("jiraPlanRejected", {
      title: "Jira rejected",
      ticketStage: "rejected",
      comment: "Plan rejected",
    }),
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
  if (spec.stops.appBug) {
    stopPair(
      nodes,
      edges,
      spec.stops.appBug,
      notify("notifyAppBug", "app_bug_blocked", "Stopped: application bug; scripts were not changed to hide it", "playwright"),
      jiraStop("jiraAppBug", {
        comment: "Blocked: this is an application bug. Automation scripts were not changed to hide it.",
      }),
      8,
      8
    );
  }
}

function addSuccessTail(nodes, edges, editor, extra = {}) {
  add(nodes, {
    id: "pr",
    type: "githubPr",
    config: {
      title: extra.prTitle || "Open pull request",
      role: extra.role || "app",
      retries: 1,
      repository: repositoryFromProfile(editor),
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
      comment: "Pull request: {{prUrl}} Linked: {{linkedPrUrl}}",
      ...ui(7, 6),
    },
  });
  edge(edges, "pr", "notifyPr", "true");
  edge(edges, "pr", "notifyEnv", "false");
  edge(edges, "notifyPr", "jiraReview");
}

function addVerifyLoop({
  nodes,
  edges,
  editor,
  appProfile,
  autoProfile,
  maxFix,
  previousAgent,
  successId,
  role,
  ticketKind,
  selectMode,
  colStart,
  idPrefix,
  routing,
  linkedStart,
  linkedScript,
}) {
  const verifyCount = maxFix + 1;
  let previous = previousAgent;

  for (let n = 0; n < verifyCount; n += 1) {
    const col = colStart + n;
    const rulesId = `${idPrefix}${n}_rules`;
    const reviewPromptId = `${idPrefix}${n}_rprompt`;
    const reviewId = `${idPrefix}${n}_review`;
    const selectId = `${idPrefix}${n}_select`;
    const pwId = `${idPrefix}${n}_pw`;
    const isEnvId = `${idPrefix}${n}_isEnv`;
    const canFixId = `${idPrefix}${n}_canFix`;
    const last = n === verifyCount - 1;

    add(nodes, {
      id: rulesId,
      type: "rulesChecks",
      config: {
        title: `Rules checks ${n + 1}`,
        role,
        repository: repositoryFromProfile(editor),
        ...ui(col, 0),
      },
    });
    add(nodes, {
      id: reviewPromptId,
      type: "cursorPrompt",
      config: { ...promptConfig("review", { role }), ...ui(col, 1) },
    });
    add(nodes, {
      id: reviewId,
      type: "cursorAgent",
      config: {
        ...agentConfig(editor, "review", { attempt: n + 1, maxFixAttempts: maxFix, role }),
        ...ui(col, 2),
      },
    });
    add(nodes, {
      id: selectId,
      type: "testSelect",
      config: { title: "Select tests", mode: selectMode, role, ...ui(col, 3) },
    });
    add(nodes, {
      id: pwId,
      type: "playwright",
      config: {
        ...playwrightConfig(appProfile, autoProfile, { ticketKind, role, title: `Playwright ${n + 1}` }),
        ...ui(col, 4),
      },
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

    let afterEnv = canFixId;
    if (routing === "linked") {
      const isLinkedId = `${idPrefix}${n}_isLinked`;
      add(nodes, {
        id: isLinkedId,
        type: "condition",
        config: {
          field: "failureClassification.routing.action",
          operator: "equals",
          value: "linked_automation_run",
          ...ui(col, 5.5),
        },
      });
      edge(edges, isEnvId, isLinkedId, "false");
      edge(edges, isLinkedId, linkedStart, "true");
      edge(edges, isLinkedId, canFixId, "false");
      afterEnv = isLinkedId;
    } else if (routing === "appBug") {
      const isAppBugId = `${idPrefix}${n}_isAppBug`;
      add(nodes, {
        id: isAppBugId,
        type: "condition",
        config: {
          field: "failureClassification.value.classification",
          operator: "equals",
          value: "app-bug",
          ...ui(col, 5.5),
        },
      });
      edge(edges, isEnvId, isAppBugId, "false");
      edge(edges, isAppBugId, "notifyAppBug", "true");
      edge(edges, isAppBugId, canFixId, "false");
      afterEnv = isAppBugId;
    }

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

    edge(edges, previous, rulesId, "true");
    edge(edges, rulesId, reviewPromptId, "true");
    edge(edges, reviewPromptId, reviewId);
    edge(edges, reviewId, selectId, "true");
    edge(edges, selectId, pwId);
    edge(edges, pwId, successId, "true");
    edge(edges, pwId, isEnvId, "false");
    edge(edges, isEnvId, "notifyEnv", "true");
    if (routing !== "linked" && routing !== "appBug") {
      edge(edges, isEnvId, afterEnv, "false");
    }

    if (last) {
      edge(edges, rulesId, "notifyGate", "false");
      edge(edges, reviewId, "notifyRules", "false");
      edge(edges, canFixId, "notifyPlaywright", "true");
      edge(edges, canFixId, "notifyPlaywright", "false");
    } else {
      const fixPromptId = `${idPrefix}f${n + 1}_prompt`;
      const fixAgentId = `${idPrefix}f${n + 1}_agent`;
      add(nodes, {
        id: fixPromptId,
        type: "cursorPrompt",
        config: {
          ...promptConfig("fix", { role, linkedScript: Boolean(linkedScript) }),
          ...ui(col, 7),
        },
      });
      add(nodes, {
        id: fixAgentId,
        type: "cursorAgent",
        config: { ...agentConfig(editor, "fix", { role }), ...ui(col, 8) },
      });
      edge(edges, rulesId, fixPromptId, "false");
      edge(edges, reviewId, fixPromptId, "false");
      edge(edges, canFixId, fixPromptId, "true");
      edge(edges, canFixId, "notifyPlaywright", "false");
      edge(edges, fixPromptId, fixAgentId);
      edge(edges, fixAgentId, "agentIsEnv", "false");
      previous = fixAgentId;
    }
  }
}

function addLinkedAutomationPath(nodes, edges, appProfile, autoProfile) {
  const maxFix = maxFixAttemptsOf(autoProfile);
  const repo = repositoryFromProfile(autoProfile);
  add(nodes, {
    id: "lgit",
    type: "gitBranch",
    config: {
      title: "Automation worktree",
      role: "automation",
      repository: repo,
      credentialFiles: credentialFilesOf(autoProfile),
      ...ui(9, 0),
    },
  });
  add(nodes, {
    id: "lprompt",
    type: "cursorPrompt",
    config: { ...promptConfig("fix", { role: "automation", linkedScript: true }), ...ui(9, 1) },
  });
  add(nodes, {
    id: "lagent",
    type: "cursorAgent",
    config: { ...agentConfig(autoProfile, "fix", { role: "automation", linkedScript: true }), ...ui(9, 2) },
  });
  add(nodes, {
    id: "autoPr",
    type: "githubPr",
    config: {
      title: "Open automation pull request",
      role: "automation",
      retries: 1,
      repository: repo,
      ...ui(9, 4),
    },
  });
  edge(edges, "lgit", "lprompt");
  edge(edges, "lprompt", "lagent");
  edge(edges, "lagent", "agentIsEnv", "false");
  edge(edges, "autoPr", "pr", "true");
  edge(edges, "autoPr", "notifyEnv", "false");

  addVerifyLoop({
    nodes,
    edges,
    editor: autoProfile,
    appProfile,
    autoProfile,
    maxFix,
    previousAgent: "lagent",
    successId: "autoPr",
    role: "automation",
    ticketKind: "automation",
    selectMode: "automation",
    colStart: 10,
    idPrefix: "l",
    routing: "appBug",
    linkedScript: true,
  });
}

function addAgentEnvFork(nodes, edges) {
  add(nodes, {
    id: "agentIsEnv",
    type: "condition",
    config: { field: "guardFailed", operator: "truthy", value: "", ...ui(2, 5) },
  });
}

function workflowEnvelope(profile, spec, nodes, edges, maxFix) {
  return {
    kind: spec.kind,
    name: String(spec.name || `{{jiraKey}} ticket`).split("{{jiraKey}}").join(profile.jiraKey),
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

function buildAppTicketWorkflow(profile, linked, template) {
  const spec = template || loadTemplate("app-ticket");
  const maxFix = maxFixAttemptsOf(profile);
  const repo = repositoryFromProfile(profile);
  const autoRepo = repositoryFromProfile(linked);
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
    config: {
      title: "App worktree",
      role: "app",
      repository: repo,
      credentialFiles: credentialFilesOf(profile),
      ...ui(0, 2),
    },
  });
  add(nodes, {
    id: "gitAuto",
    type: "gitBranch",
    config: {
      title: "Automation worktree",
      role: "automation",
      detached: true,
      repository: autoRepo,
      credentialFiles: credentialFilesOf(linked),
      ...ui(0, 2.4),
    },
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
  edge(edges, "gitApp", "gitAuto");
  edge(edges, "gitAuto", "promptPlan");
  edge(edges, "promptPlan", "agentPlan");
  edge(edges, "agentPlan", "approvePlan", "true");
  edge(edges, "approvePlan", "promptImpl", "true");
  edge(edges, "promptImpl", "agentImpl");

  addCommonStops(nodes, edges, spec);
  edge(edges, "agentPlan", "notifyPlanFailed", "false");
  edge(edges, "approvePlan", "notifyPlanRejected", "false");

  addAgentEnvFork(nodes, edges);
  edge(edges, "agentImpl", "agentIsEnv", "false");
  edge(edges, "agentIsEnv", "notifyEnv", "true");
  edge(edges, "agentIsEnv", "notifyAgentFailed", "false");

  addSuccessTail(nodes, edges, profile, { role: "app" });
  addLinkedAutomationPath(nodes, edges, profile, linked);
  addVerifyLoop({
    nodes,
    edges,
    editor: profile,
    appProfile: profile,
    autoProfile: linked,
    maxFix,
    previousAgent: "agentImpl",
    successId: "pr",
    role: "app",
    ticketKind: "app",
    selectMode: "app",
    colStart: 3,
    idPrefix: "v",
    routing: "linked",
    linkedStart: "lgit",
    linkedScript: false,
  });

  return workflowEnvelope(profile, spec, nodes, edges, maxFix);
}

function buildAutomationTicketWorkflow(profile, linked, template) {
  const spec = template || loadTemplate("automation-ticket");
  const maxFix = maxFixAttemptsOf(profile);
  const autoRepo = repositoryFromProfile(profile);
  const appRepo = repositoryFromProfile(linked);
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
    id: "gitAuto",
    type: "gitBranch",
    config: {
      title: "Automation worktree",
      role: "automation",
      repository: autoRepo,
      credentialFiles: credentialFilesOf(profile),
      ...ui(0, 2),
    },
  });
  add(nodes, {
    id: "gitApp",
    type: "gitBranch",
    config: {
      title: "App worktree",
      role: "app",
      detached: true,
      repository: appRepo,
      credentialFiles: credentialFilesOf(linked),
      ...ui(0, 2.4),
    },
  });
  add(nodes, {
    id: "promptPlan",
    type: "cursorPrompt",
    config: { ...promptConfig("plan", { role: "automation" }), ...ui(0, 3) },
  });
  add(nodes, {
    id: "agentPlan",
    type: "cursorAgent",
    config: { ...agentConfig(profile, "plan", { role: "automation" }), ...ui(0, 4) },
  });
  add(nodes, {
    id: "approvePlan",
    type: "approval",
    config: { title: "Approve plan", ...ui(1, 4) },
  });
  add(nodes, {
    id: "promptImpl",
    type: "cursorPrompt",
    config: { ...promptConfig("implement", { role: "automation" }), ...ui(2, 3) },
  });
  add(nodes, {
    id: "agentImpl",
    type: "cursorAgent",
    config: { ...agentConfig(profile, "implement", { role: "automation" }), ...ui(2, 4) },
  });

  edge(edges, "fetch", "claim");
  edge(edges, "claim", "gitAuto");
  edge(edges, "gitAuto", "gitApp");
  edge(edges, "gitApp", "promptPlan");
  edge(edges, "promptPlan", "agentPlan");
  edge(edges, "agentPlan", "approvePlan", "true");
  edge(edges, "approvePlan", "promptImpl", "true");
  edge(edges, "promptImpl", "agentImpl");

  addCommonStops(nodes, edges, spec);
  edge(edges, "agentPlan", "notifyPlanFailed", "false");
  edge(edges, "approvePlan", "notifyPlanRejected", "false");

  addAgentEnvFork(nodes, edges);
  edge(edges, "agentImpl", "agentIsEnv", "false");
  edge(edges, "agentIsEnv", "notifyEnv", "true");
  edge(edges, "agentIsEnv", "notifyAgentFailed", "false");

  addSuccessTail(nodes, edges, profile, { role: "automation", prTitle: "Open automation pull request" });
  addVerifyLoop({
    nodes,
    edges,
    editor: profile,
    appProfile: linked,
    autoProfile: profile,
    maxFix,
    previousAgent: "agentImpl",
    successId: "pr",
    role: "automation",
    ticketKind: "automation",
    selectMode: "automation",
    colStart: 3,
    idPrefix: "v",
    routing: "appBug",
    linkedScript: false,
  });

  return workflowEnvelope(profile, spec, nodes, edges, maxFix);
}

function buildProjectWorkflow(profile, linked, options = {}) {
  if (!profile || (profile.kind !== "app" && profile.kind !== "automation")) {
    throw new Error("project workflow requires an app or automation profile");
  }
  if (profile.kind === "app") {
    if (!linked || linked.kind !== "automation") {
      throw new Error("app-ticket template requires a linked automation profile");
    }
    const template = options.template || loadTemplate("app-ticket");
    if (template.kind !== "app-ticket") {
      throw new Error(`Unexpected template kind ${template.kind}`);
    }
    return buildAppTicketWorkflow(profile, linked, template);
  }
  if (!linked || linked.kind !== "app") {
    throw new Error("automation-ticket template requires a linked app profile");
  }
  const template = options.template || loadTemplate("automation-ticket");
  if (template.kind !== "automation-ticket") {
    throw new Error(`Unexpected template kind ${template.kind}`);
  }
  return buildAutomationTicketWorkflow(profile, linked, template);
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
  const terminals = nodes.filter((node) => node.id && !outgoing(edges, node.id).length);
  if (!terminals.length) return false;
  return terminals.every((node) => {
    if (node.type === "notify") return true;
    const incoming = edges.filter((row) => row.to === node.id);
    return incoming.some((row) => {
      const src = nodes.find((item) => item.id === row.from);
      return src && src.type === "notify";
    });
  });
}

function notifyThenJiraOnStops(nodes, edges) {
  const terminals = nodes.filter((node) => node.id && !outgoing(edges, node.id).length);
  if (!terminals.length) return false;
  return terminals.every((node) => {
    if (node.type === "notify") return true;
    if (node.type !== "jiraUpdate") return false;
    const incoming = edges.filter((row) => row.to === node.id);
    return (
      incoming.length > 0 &&
      incoming.every((row) => {
        const src = nodes.find((item) => item.id === row.from);
        return src && src.type === "notify";
      })
    );
  });
}

function reachableIds(nodes, edges, startId) {
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const row of outgoing(edges, id)) stack.push(row.to);
  }
  return seen;
}

function successors(edges, id, condition) {
  return outgoing(edges, id)
    .filter((row) => (condition == null ? true : row.condition === condition))
    .map((row) => row.to);
}

module.exports = {
  TEMPLATE_DIR,
  loadTemplate,
  repositoryFromProfile,
  maxFixAttemptsOf,
  buildProjectWorkflow,
  buildAppTicketWorkflow,
  buildAutomationTicketWorkflow,
  terminalPaths,
  everyTerminalPathHasNotify,
  notifyThenJiraOnStops,
  reachableIds,
  successors,
};
