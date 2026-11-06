const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const config = require("../../config");
const jira = require("../services/jiraService");
const analysis = require("../services/analysisService");
const prompts = require("../services/cursorPromptService");
const git = require("../services/gitService");
const { assertPullRequestGate } = require("../services/pullRequestGate");
const githubPrService = require("../services/githubPrService");
const { parseProfiles, resolveProfile } = require("../services/projectRegistry");
const rulesService = require("../services/rulesService");
const rulesChecks = require("../services/rulesChecks");
const {
  normalizeMode,
  isReadOnlyMode,
  artifactDirFor,
  planPath,
  resultPath,
  reviewPath,
  readPlan,
  readResult,
  readReview,
} = require("../services/agentContract");
const { evaluateApproval } = require("../services/approvalService");
const commitPushGuard = require("../services/commitPushGuard");
const { buildPrBody, buildPrTitle } = require("../services/prBody");

function asObject(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) return { ...input };
  return { payload: input };
}

function interpolate(template, input) {
  if (typeof template !== "string") return "";
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const parts = String(key).trim().split(".").filter(Boolean);
    let cur = input;
    for (const part of parts) {
      if (cur == null || typeof cur !== "object") return "";
      cur = cur[part];
    }
    if (cur === undefined || cur === null) return "";
    if (typeof cur === "object") return JSON.stringify(cur).slice(0, 200);
    return String(cur);
  });
}

function resolveTransitionName(cfg, issueKey) {
  const raw = cfg && typeof cfg.transition === "string" ? cfg.transition.trim() : "";
  if (!raw) return "";
  try {
    const profile = resolveProfile(issueKey, parseProfiles());
    if (profile && profile.transitions && profile.transitions[raw]) {
      return profile.transitions[raw];
    }
  } catch {
    // Profiles are optional for ad-hoc nodes; use the configured name as-is.
  }
  return raw;
}

function nodeRepository(node) {
  const repo = node && node.config && node.config.repository;
  if (repo && typeof repo === "object" && !Array.isArray(repo)) return repo;
  return null;
}

function isManualIntake(workflow) {
  return Boolean(
    workflow && workflow.trigger && workflow.trigger.config && workflow.trigger.config.intake === "manual"
  );
}

function profileByRole(input, role) {
  const profile = profileFromInput(input);
  if (!profile) return null;
  let linked = null;
  try {
    const profiles = parseProfiles();
    linked = profile.linkedProfile ? profiles[profile.linkedProfile] : null;
  } catch {
    linked = null;
  }
  if (role === "automation") return profile.kind === "automation" ? profile : linked;
  if (role === "app") return profile.kind === "app" ? profile : linked;
  return profile;
}

function repositoryFromEditor(profile) {
  if (!profile || !profile.repo) return null;
  return {
    location: profile.repo.location,
    defaultBranch: profile.repo.defaultBranch,
    credentialRef: profile.repo.credentialRef,
    owner: profile.repo.github && profile.repo.github.owner,
    repo: profile.repo.github && profile.repo.github.repo,
  };
}

function repositoryForNode(node, input, workflow) {
  if (isManualIntake(workflow)) {
    const editor = profileByRole(input, nodeRole(node) || "app");
    const resolved = repositoryFromEditor(editor);
    if (resolved) return resolved;
  }
  return nodeRepository(node);
}

function appNameForProfile(profile) {
  const key = profile && profile.jiraKey;
  if (key === "MFC" || key === "TAC") return "central";
  return "fuji";
}

function nodeRole(node) {
  const role = node && node.config && node.config.role;
  if (role === "app" || role === "automation") return role;
  return "";
}

function nodeRuntime(node, runState) {
  if (node && node.config && typeof node.config.runtime === "string" && node.config.runtime) {
    return node.config.runtime;
  }
  if (runState && runState.workflow && typeof runState.workflow.runtime === "string" && runState.workflow.runtime) {
    return runState.workflow.runtime;
  }
  return undefined;
}

function optionalRepoLocation(workflow, repository) {
  if (repository && typeof repository.location === "string" && repository.location.trim()) {
    return repository.location.trim();
  }
  if (workflow && workflow.repository && typeof workflow.repository.location === "string") {
    return workflow.repository.location;
  }
  return "";
}

function externalFor(runState, role) {
  const external = runState && runState.external ? runState.external : {};
  if (!role) return external;
  const entry = external.repos && external.repos[role];
  if (entry && typeof entry === "object" && !Array.isArray(entry)) return entry;
  return {};
}

function externalPatch(role, fields) {
  if (!role) return fields;
  return { repos: { [role]: fields } };
}

function tokenFromWorkflow(workflow, repository) {
  const ref =
    (repository && typeof repository.credentialRef === "string" && repository.credentialRef) ||
    (workflow && workflow.repository && workflow.repository.credentialRef);
  if (typeof ref === "string" && ref && Object.prototype.hasOwnProperty.call(process.env, ref)) {
    return process.env[ref];
  }
  return config.githubToken;
}

function profileFromInput(input) {
  const key =
    (input && typeof input.profileKey === "string" && input.profileKey) ||
    (input && input.jira && typeof input.jira.key === "string" && input.jira.key) ||
    (typeof input.issueKey === "string" ? input.issueKey : "");
  if (!key) return null;
  try {
    return resolveProfile(key, parseProfiles());
  } catch {
    return null;
  }
}

function plannedFilesFrom(input) {
  if (input && input.plan && Array.isArray(input.plan.filesToChange)) return input.plan.filesToChange;
  if (input && input.analysis && Array.isArray(input.analysis.filesLikelyTouched)) {
    return input.analysis.filesLikelyTouched;
  }
  return [];
}

function rulesRoot(node, input, runState) {
  const role = nodeRole(node);
  const active = externalFor(runState, role);
  if (active.worktreePath) return active.worktreePath;
  if (input && typeof input.worktreePath === "string" && input.worktreePath) return input.worktreePath;
  const location = optionalRepoLocation(
    runState && runState.workflow,
    repositoryForNode(node, input, runState && runState.workflow)
  );
  return location || "";
}

async function rememberPlanHash(runId, planHash) {
  if (!runId || !planHash) return;
  try {
    const TicketRun = require("../models/TicketRun");
    await TicketRun.updateOne({ runId: String(runId) }, { $set: { planHash } });
  } catch {
    // TicketRun is optional for ad-hoc workflows.
  }
}

async function rememberPrUrl(runId, url, role) {
  if (!runId || !url) return;
  try {
    const TicketRun = require("../models/TicketRun");
    const patch = role === "automation" ? { linkedPrUrl: url } : { prUrl: url };
    await TicketRun.updateOne({ runId: String(runId) }, { $set: patch });
    if (role === "automation") {
      await TicketRun.updateOne(
        { runId: String(runId), $or: [{ prUrl: { $exists: false } }, { prUrl: null }, { prUrl: "" }] },
        { $set: { prUrl: url } }
      );
    }
  } catch {
    // TicketRun is optional for ad-hoc workflows.
  }
}

function credentialFilesFor(node, input) {
  const cfg = node && node.config && typeof node.config === "object" ? node.config : {};
  if (Array.isArray(cfg.appCredentialFiles) && cfg.appCredentialFiles.length) return cfg.appCredentialFiles;
  if (Array.isArray(cfg.credentialFiles) && cfg.credentialFiles.length) return cfg.credentialFiles;
  const profile = profileFromInput(input);
  if (profile && profile.repo && Array.isArray(profile.repo.credentialFiles) && profile.repo.credentialFiles.length) {
    return profile.repo.credentialFiles;
  }
  return [".env"];
}

async function applyGuard(node, base, runState, stage) {
  const role = nodeRole(node);
  const active = externalFor({ ...runState, node }, role);
  const worktreePath = role ? active.worktreePath : active.worktreePath || base.worktreePath;
  if (!worktreePath) return { ok: true, errors: [] };
  const profile = profileFromInput(base);
  const result = await commitPushGuard.assertCommitPushGuard({
    worktreePath,
    baseSha: active.preAgentSha || base.preAgentSha || base.baseSha,
    sourceRepoPath: active.repoPath || (profile && profile.repo && profile.repo.location) || "",
    credentialFiles: credentialFilesFor(node, base),
    stage,
  });
  if (result.ok) return result;
  const slack = require("../services/slackService");
  await slack.emit(runState && runState.runId, "env_failed", {
    reason: result.summary || "commit/push guard failed",
    stage,
    file: result.errors && result.errors[0] && result.errors[0].file,
  });
  return result;
}

function guardOutput(base, result) {
  return {
    ...base,
    branch: "false",
    reason: "env",
    guardFailed: true,
    failureClassification: commitPushGuard.classificationFrom(result),
  };
}

async function removeQuiet(runState) {
  if (git.keepsWorktreeOnFailure(runState && runState.workflow)) return;
  const role = nodeRole(runState && runState.node);
  const external = externalFor(runState, role);
  if (!external.worktreePath || !external.repoPath) return;
  try {
    if (runState.checkpointExternal) {
      await runState.checkpointExternal(externalPatch(role, { worktreeState: "removing" }));
    }
    await git.removeWorktree({
      repoPath: external.repoPath,
      worktreePath: external.worktreePath,
      worktreesDir: config.worktreesDir,
    });
  } catch (err) {
    console.error("[worktree] remove failed:", err.message);
  }
}

async function jiraNode(_node, input) {
  const base = asObject(input);
  if (base.jira && base.jira.id && base.jira.key) return { ...base, jira: base.jira };
  const issue = await jira.fetchIssue(typeof base.issueKey === "string" ? base.issueKey : "");
  return { ...base, jira: issue };
}

async function jiraUpdateNode(node, input, runState) {
  const base = asObject(input);
  const cfg = node && node.config && typeof node.config === "object" ? node.config : {};
  const key =
    (base.jira && typeof base.jira.key === "string" && base.jira.key) ||
    (typeof base.issueKey === "string" ? base.issueKey : "");
  const marker =
    typeof cfg.marker === "string" && cfg.marker.trim()
      ? cfg.marker.trim()
      : jira.commentMarker(runState && runState.runId, runState && runState.nodeId);
  const statusName = resolveTransitionName(cfg, key);
  const update = { marker };
  if (statusName) {
    update.transition = await jira.transitionIssue(key, statusName, {
      marker,
      commentOnMissing: true,
    });
  }
  const commentTemplate = typeof cfg.comment === "string" ? cfg.comment : "";
  if (commentTemplate.trim()) {
    const text = `${interpolate(commentTemplate, base)}\n${marker}`.trim();
    update.comment = await jira.addComment(key, text, marker);
  }
  return { ...base, jiraUpdate: update };
}

async function analysisNode(_node, input) {
  const base = asObject(input);
  const issue = base.jira || {};
  const result = await analysis.analyzeIssue({
    summary: issue.summary,
    descriptionText: issue.descriptionText,
  });
  return { ...base, analysis: result };
}

async function cursorPromptNode(node, input, runState) {
  const base = asObject(input);
  const cfg = node && node.config && typeof node.config === "object" ? node.config : {};
  const mode = normalizeMode(cfg.mode);
  const profile = profileFromInput(base);
  const repoRoot = rulesRoot(node, base, runState);
  let manifest = base.rulesManifest;
  if (repoRoot && fs.existsSync(repoRoot)) {
    const named = rulesService.rulesMentionedInTicket(base.jira || {}, repoRoot);
    const forced = [
      ...((profile && profile.rules && profile.rules.forceInclude) || []),
      ...named,
    ];
    manifest = rulesService.buildManifest({
      repoRoot,
      plannedFiles: plannedFilesFrom(base),
      forceInclude: forced,
      extraDocs: profile && profile.rules ? profile.rules.extraDocs : [],
    });
  }
  const runId = runState && runState.runId;
  const artifacts = artifactDirFor(runId);
  let prompt;
  if (mode === "plan") {
    prompt = prompts.buildPlanPrompt({
      issue: base.jira || {},
      analysis: base.analysis || {},
      manifest,
      artifactPath: planPath(runId),
    });
  } else if (mode === "review") {
    let diff = typeof base.diff === "string" ? base.diff : "";
    const worktree = repoRoot;
    const fromSha = externalFor(runState, nodeRole(node)).preAgentSha || base.preAgentSha;
    if (!diff && worktree && fromSha) {
      try {
        const result = await git.runGit(["-C", worktree, "diff", fromSha, "HEAD"]);
        diff = result && result.stdout ? result.stdout : "";
      } catch (err) {
        diff = err && err.stdout ? err.stdout : "";
      }
    }
    prompt = prompts.buildReviewPrompt({
      issue: base.jira || {},
      manifest,
      diff,
      mechanical: base.rulesChecks,
      artifactPath: reviewPath(runId),
    });
  } else if (mode === "implement" || mode === "fix") {
    if (cfg.linkedScript) {
      prompt = prompts.buildLinkedScriptPrompt({
        issue: base.jira || {},
        plan: base.plan,
        manifest,
        classification: base.failureClassification,
        feedback: base.feedback,
        artifactPath: resultPath(runId),
      });
    } else {
      prompt = prompts.buildImplementPrompt({
        issue: base.jira || {},
        plan: base.plan,
        manifest,
        feedback: base.feedback,
        artifactPath: resultPath(runId),
      });
    }
  } else {
    prompt = prompts.buildPrompt(base.jira || {}, base.analysis || {});
  }
  return { ...base, prompt, rulesManifest: manifest, agentMode: mode || undefined, artifactDir: artifacts };
}

async function gitBranchNode(node, input, runState) {
  const base = asObject(input);
  const repository = repositoryForNode(node, base, runState.workflow);
  const role = nodeRole(node);
  const cfg = node && node.config && typeof node.config === "object" ? node.config : {};
  const repoPath = git.resolveRepoPath(runState.workflow, repository);
  const baseBranch = git.resolveBaseBranch(runState.workflow, repository);
  const created = cfg.detached
    ? await git.createCleanWorktree({
        repoPath,
        runId: runState.runId,
        nodeId: runState.nodeId,
        baseBranch,
        worktreesDir: config.worktreesDir,
      })
    : await git.createWorktree({
        repoPath,
        runId: runState.runId,
        nodeId: runState.nodeId,
        issueKey: base.jira && base.jira.key,
        baseBranch,
        worktreesDir: config.worktreesDir,
      });
  let credentialFiles = Array.isArray(cfg.credentialFiles) ? cfg.credentialFiles : [];
  if (isManualIntake(runState.workflow)) {
    const editor = profileByRole(base, role || "app");
    if (editor && Array.isArray(editor.repo.credentialFiles)) {
      credentialFiles = editor.repo.credentialFiles;
    }
  }
  if (credentialFiles.length) {
    const { copyCredentialFiles } = require("../services/hostRunners");
    const copied = await copyCredentialFiles({
      sourceRepoPath: created.repoPath,
      destWorktree: created.path,
      credentialFiles,
    });
    if (copied && copied.failureClass === "env") {
      const err = new Error("Missing credentials for worktree");
      err.code = "ENV";
      throw err;
    }
  }
  const fields = {
    worktreePath: created.path,
    branch: created.branch || "",
    repoPath: created.repoPath,
    worktreeState: "ready",
    detached: created.detached === true,
  };
  if (runState.checkpointExternal) await runState.checkpointExternal(externalPatch(role, fields));
  return { ...base, worktreePath: created.path, branch: created.branch || "" };
}

async function finishReadOnlyAgent(node, base, runState, mode) {
  const role = nodeRole(node);
  const state = { ...runState, node };
  const active = externalFor(state, role);
  const worktreePath = role ? active.worktreePath : active.worktreePath || base.worktreePath;
  const preAgentSha = active.preAgentSha || base.preAgentSha;
  const head = worktreePath ? await git.revParse(worktreePath) : "";
  const clean = worktreePath ? await git.isClean(worktreePath) : false;
  if (!clean || (preAgentSha && head !== preAgentSha)) {
    await removeQuiet(state);
    return { ...base, branch: "false", reason: "plan-dirty" };
  }
  if (mode === "plan") {
    const parsed = readPlan(planPath(runState.runId));
    if (!parsed.ok) {
      await removeQuiet(state);
      return { ...base, branch: "false", reason: parsed.reason || "invalid_plan" };
    }
    await rememberPlanHash(runState.runId, parsed.hash);
    return {
      ...base,
      branch: "true",
      plan: parsed.value,
      planHash: parsed.hash,
      rulesApplied: parsed.value.rulesApplied,
      baseSha: preAgentSha || head,
    };
  }
  const parsed = readReview(reviewPath(runState.runId));
  const normalized = parsed.ok
    ? rulesChecks.normalizeReview(parsed.value)
    : { ok: false, reason: parsed.reason };
  const alreadyRetried = Boolean(base.reviewRetried);
  if (!normalized.ok) {
    const decision = rulesChecks.reviewValidationDecision(normalized, { alreadyRetried });
    if (decision.action === "retry") {
      return { ...base, branch: "false", retryReview: true, reason: "invalid_review" };
    }
    const slack = require("../services/slackService");
    await slack.emit(runState.runId, "rules_violation", { reason: "invalid review output", stage: "rules_review" });
    await removeQuiet(state);
    return { ...base, branch: "false", reason: "invalid_review" };
  }
  const blocking = rulesChecks.applyReviewBlocking(normalized.value, {
    attempt: Number(node.config && node.config.attempt) || 1,
    maxFixAttempts: Number(node.config && node.config.maxFixAttempts) || 1,
    mechanicalFailed: Boolean(base.rulesChecks && base.rulesChecks.ok === false),
    deviationApproved: Boolean(base.deviationApproved || (runState.approval && runState.approval.deviation)),
  });
  if (blocking.action === "wait") {
    const slack = require("../services/slackService");
    await slack.emit(runState.runId, "waiting_for_approval", {
      reason: "rules review uncertainty",
      stage: "rules_review",
      nodeId: runState.nodeId,
    });
    return {
      control: "wait",
      kind: "approval",
      output: { ...base, review: normalized.value, rulesReviewWait: true },
    };
  }
  if (blocking.action === "retry") {
    return { ...base, branch: "false", review: normalized.value, retryReview: true, reason: blocking.reason };
  }
  if (blocking.action === "block") {
    const slack = require("../services/slackService");
    await slack.emit(runState.runId, "rules_violation", {
      reason: blocking.reason || "rules violation",
      stage: "rules_review",
    });
    await removeQuiet(state);
    return { ...base, branch: "false", review: normalized.value, reason: blocking.reason };
  }
  return {
    ...base,
    branch: "true",
    review: normalized.value,
    deviations: blocking.deviations || [],
  };
}

async function cursorAgentNode(node, input, runState) {
  const base = asObject(input);
  const role = nodeRole(node);
  const state = { ...runState, node };
  const cfg = node && node.config && typeof node.config === "object" ? node.config : {};
  const mode = normalizeMode(cfg.mode);
  if (runState.resumed && runState.decision && (base.rulesReviewWait || (runState.wait && runState.wait.kind === "approval"))) {
    const branch = runState.decision === "approved" ? "true" : "false";
    return { ...base, branch, deviationApproved: runState.decision === "approved" };
  }
  if (runState.resumed) {
    const branch = runState.completion && runState.completion.branch === "true" ? "true" : "false";
    if (isReadOnlyMode(mode)) {
      if (branch !== "true") {
        await removeQuiet(state);
        return { ...base, branch: "false", reason: "plan-dirty" };
      }
      return finishReadOnlyAgent(node, base, runState, mode);
    }
    if (branch === "false") await removeQuiet(state);
    const result = runState.completion && runState.completion.result;
    let artifact = null;
    if (branch === "true" && (mode === "implement" || mode === "fix")) {
      artifact = readResult(resultPath(runState.runId));
      if (!artifact.ok) {
        await removeQuiet(state);
        return { ...base, branch: "false", reason: artifact.reason || "invalid_result" };
      }
      const guarded = await applyGuard(node, base, runState, "agent");
      if (!guarded.ok) {
        await removeQuiet(state);
        return guardOutput(base, guarded);
      }
    }
    return {
      ...base,
      branch,
      headSha: result && result.sha ? result.sha : null,
      result: artifact && artifact.ok ? artifact.value : undefined,
    };
  }
  if (mode === "implement" || mode === "fix") {
    const bound = Boolean(base.planHash || (base.planApproval && base.planApproval.planHash));
    if (bound) {
      const gate = evaluateApproval({
        decision: (base.planApproval && base.planApproval.decision) || "approved",
        approvedPlanHash: (base.planApproval && base.planApproval.planHash) || base.planHash,
        currentPlanHash: base.planHash,
        approvedFingerprint: base.planApproval && base.planApproval.fingerprint,
        currentFingerprint: base.fingerprint || (base.jira && base.jira.fingerprint),
        expiresAt: base.planApproval && base.planApproval.expiresAt,
      });
      if (!gate.ok) {
        return { ...base, branch: "false", replan: gate.replan === true, replanReason: gate.reason };
      }
    }
  }
  const active = externalFor(state, role);
  const worktreePath = role ? active.worktreePath : active.worktreePath || base.worktreePath;
  const head = await git.revParse(worktreePath);
  const clean = await git.isClean(worktreePath);
  if (!clean) {
    await removeQuiet(state);
    return { ...base, branch: "false" };
  }
  const agentExecutionId = uuidv4();
  const artifactDir = base.artifactDir || artifactDirFor(runState.runId);
  if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
  const external = externalPatch(role, {
    agentExecutionId,
    preAgentSha: head,
    worktreePath,
    worktreeState: "ready",
  });
  if (runState.checkpointExternal) await runState.checkpointExternal(external);
  const externalJobId = `agent-${runState.runId}-${runState.nodeId}`;
  return {
    control: "wait",
    kind: "agent",
    output: { ...base, artifactDir, agentMode: mode || undefined },
    external,
    job: {
      runId: runState.runId,
      workflowId: runState.workflowId,
      nodeId: runState.nodeId,
      prompt: typeof base.prompt === "string" ? base.prompt : "",
      worktreePath,
      externalJobId,
      agentExecutionId,
      preAgentSha: head,
      runtime: nodeRuntime(node, runState),
      mode: mode || undefined,
      artifactDir,
    },
  };
}

async function rulesChecksNode(node, input, runState) {
  const base = asObject(input);
  const role = nodeRole(node);
  const active = externalFor({ ...runState, node }, role);
  const worktreePath = role ? active.worktreePath : active.worktreePath || base.worktreePath;
  const fromSha = active.preAgentSha || base.preAgentSha;
  const profile = profileFromInput(base);
  const repoName =
    (node.config && node.config.repository && node.config.repository.repo) ||
    (profile && profile.repo && profile.repo.github && profile.repo.github.repo) ||
    "";
  const loaded = rulesChecks.loadChecksFile(repoName);
  const files = worktreePath && fromSha ? await rulesChecks.addedDiff(worktreePath, fromSha, "HEAD") : [];
  const result = rulesChecks.runMechanicalChecks({
    files: Array.isArray(base.diffFiles) ? base.diffFiles : files,
    checks: rulesChecks.enabledChecks(loaded),
  });
  if (!result.ok) {
    const slack = require("../services/slackService");
    await slack.emit(runState && runState.runId, "rules_violation", {
      reason: "mechanical rules check failed",
      stage: "rules_review",
    });
  }
  return { ...base, rulesChecks: result, branch: result.ok ? "true" : "false" };
}

async function testSelectNode(node, input, runState) {
  const base = asObject(input);
  const cfg = node.config && typeof node.config === "object" ? node.config : {};
  const profile = profileFromInput(base);
  const testSelect = require("../services/testSelect");
  const mode =
    cfg.mode === "automation" || cfg.mode === "app"
      ? cfg.mode
      : profile && profile.kind === "automation"
        ? "automation"
        : "app";
  const role = nodeRole(node) || (mode === "automation" ? "automation" : "app");
  const active = externalFor(runState, role);
  const worktreePath = active.worktreePath || base.worktreePath;
  const fromSha = active.preAgentSha || base.preAgentSha;
  const selection = await testSelect.selectForRun({
    input: base,
    config: { ...cfg, mode },
    profile,
    worktreePath,
    fromSha,
    toSha: "HEAD",
  });
  try {
    const TicketRun = require("../models/TicketRun");
    if (runState && runState.runId) {
      await TicketRun.updateOne({ runId: String(runState.runId) }, { $set: { selection } });
    }
  } catch {
    // TicketRun is optional for ad-hoc workflows.
  }
  return { ...base, selection, branch: "true" };
}

async function playwrightNode(node, input, runState) {
  const base = asObject(input);
  const cfg = node.config && typeof node.config === "object" ? node.config : {};
  const role = nodeRole(node);
  const state = { ...runState, node };
  if (runState.resumed) {
    const branch = runState.completion && runState.completion.branch === "true" ? "true" : "false";
    if (branch === "false") await removeQuiet(state);
    const result = runState.completion && runState.completion.result;
    const extra = {};
    if (result && result.report) extra.playwrightReport = result.report;
    if (result && result.baseline) extra.baseline = result.baseline;
    if (result && result.classification) extra.failureClassification = result.classification;
    return { ...base, branch, ...extra };
  }
  if (cfg.strategy !== "in-repo" && cfg.strategy !== "external-repo") {
    throw new Error("Playwright strategy is required");
  }
  if (cfg.target !== "local-worktree" && cfg.target !== "deployed-preview") {
    throw new Error("Playwright target is required");
  }
  const active = externalFor(state, role);
  const appExt = externalFor(state, "app");
  const autoExt = externalFor(state, "automation");
  const changedPath = role ? active.worktreePath : active.worktreePath || base.worktreePath;
  const preAgentSha = active.preAgentSha;
  const ready = await git.readyForPlaywright(changedPath, preAgentSha);
  if (!ready.ok) {
    await removeQuiet(state);
    const slack = require("../services/slackService");
    await slack.emit(runState.runId, "playwright_failed", {
      reason: ready.reason || "worktree not ready for playwright",
      stage: "playwright",
    });
    return { ...base, branch: "false" };
  }
  const guarded = await applyGuard(node, base, runState, "tests");
  if (!guarded.ok) {
    await removeQuiet(state);
    return guardOutput(base, guarded);
  }
  const testRepository = cfg.testRepository && typeof cfg.testRepository === "object" ? cfg.testRepository : {};
  const appWorktree = appExt.worktreePath || (role === "app" ? changedPath : changedPath);
  const testWorktree =
    autoExt.worktreePath ||
    (cfg.strategy === "in-repo" ? changedPath : testRepository.location);
  let appHead = "";
  let autoHead = "";
  try {
    if (appExt.worktreePath) appHead = await git.revParse(appExt.worktreePath);
  } catch {
    appHead = "";
  }
  try {
    if (autoExt.worktreePath) autoHead = await git.revParse(autoExt.worktreePath);
  } catch {
    autoHead = "";
  }
  if (!appHead && role === "app") appHead = ready.head;
  if (!autoHead && role === "automation") autoHead = ready.head;
  const testedShas = {};
  if (appHead) testedShas.app = appHead;
  if (autoHead) testedShas.automation = autoHead;
  const shaPatch = { repos: {} };
  if (appExt.worktreePath && appHead) {
    shaPatch.repos.app = { testedSha: appHead, worktreePath: appExt.worktreePath, worktreeState: "ready" };
  }
  if (autoExt.worktreePath && autoHead) {
    shaPatch.repos.automation = {
      testedSha: autoHead,
      worktreePath: autoExt.worktreePath,
      worktreeState: "ready",
    };
  }
  if (role && !shaPatch.repos[role]) {
    shaPatch.repos[role] = { testedSha: ready.head, worktreePath: changedPath, worktreeState: "ready" };
  } else if (role && shaPatch.repos[role]) {
    shaPatch.repos[role].testedSha = ready.head;
  }
  const external = Object.keys(shaPatch.repos).length ? shaPatch : { testedSha: ready.head, worktreePath: changedPath, worktreeState: "ready" };
  if (runState.checkpointExternal) await runState.checkpointExternal(external);
  const testSelect = require("../services/testSelect");
  const selection = base.selection && typeof base.selection === "object" ? base.selection : null;
  const profile = profileFromInput(base);
  const appProfile = isManualIntake(runState.workflow) ? profileByRole(base, "app") : null;
  const autoProfile = isManualIntake(runState.workflow) ? profileByRole(base, "automation") : null;
  let sourceRepoPath =
    typeof cfg.sourceRepoPath === "string" && cfg.sourceRepoPath
      ? cfg.sourceRepoPath
      : cfg.strategy === "in-repo"
        ? optionalRepoLocation(runState.workflow, repositoryForNode(node, base, runState.workflow))
        : testRepository.location || optionalRepoLocation(runState.workflow, repositoryForNode(node, base, runState.workflow));
  let testCommand = testSelect.appendSelection(
    Array.isArray(cfg.testCommand) ? cfg.testCommand : [],
    selection
  );
  let appCommand = Array.isArray(cfg.appCommand) ? cfg.appCommand : [];
  let readiness = cfg.readiness || "/";
  let credentialFiles = Array.isArray(cfg.credentialFiles) ? cfg.credentialFiles : [];
  let appCredentialFiles = Array.isArray(cfg.appCredentialFiles) ? cfg.appCredentialFiles : [];
  let appSourceRepoPath = typeof cfg.appSourceRepoPath === "string" ? cfg.appSourceRepoPath : "";
  let app = typeof cfg.app === "string" ? cfg.app : "";
  let resolvedTestWorktree = testWorktree;
  if (appProfile) {
    appCommand = Array.isArray(appProfile.repo.appCommand) ? appProfile.repo.appCommand : [];
    readiness = appProfile.repo.readiness || "/";
    appCredentialFiles = Array.isArray(appProfile.repo.credentialFiles) ? appProfile.repo.credentialFiles : [];
    appSourceRepoPath = appProfile.repo.location;
    app = appNameForProfile(appProfile);
  }
  if (autoProfile) {
    testCommand = testSelect.appendSelection(
      Array.isArray(autoProfile.repo.testCommand) ? autoProfile.repo.testCommand : [],
      selection
    );
    credentialFiles = Array.isArray(autoProfile.repo.credentialFiles) ? autoProfile.repo.credentialFiles : [];
    sourceRepoPath = autoProfile.repo.location;
    resolvedTestWorktree =
      autoExt.worktreePath || (cfg.strategy === "in-repo" ? changedPath : autoProfile.repo.location);
  }
  const ticketKind =
    cfg.ticketKind === "automation" || cfg.ticketKind === "app"
      ? cfg.ticketKind
      : profile && profile.kind === "automation"
        ? "automation"
        : profile && profile.kind === "app"
          ? "app"
          : "";
  const baselineRepoPath =
    ticketKind === "automation"
      ? autoExt.repoPath || active.repoPath
      : appExt.repoPath || active.repoPath;
  const baseSha =
    ticketKind === "automation"
      ? autoExt.preAgentSha || preAgentSha
      : appExt.preAgentSha || preAgentSha;
  return {
    control: "wait",
    kind: "playwright",
    output: { ...base, testedSha: ready.head, testedShas, selection },
    external,
    job: {
      runId: runState.runId,
      workflowId: runState.workflowId,
      nodeId: runState.nodeId,
      externalJobId: `playwright-${runState.runId}-${runState.nodeId}`,
      strategy: cfg.strategy,
      target: cfg.target,
      testedSha: ready.head,
      testedShas,
      testedWorktree: changedPath,
      appWorktree,
      worktreePath: changedPath,
      testWorktree: resolvedTestWorktree,
      testPath: typeof cfg.testPath === "string" ? cfg.testPath : "",
      appCommand,
      readiness,
      testCommand,
      selection,
      ticketKind,
      baseSha,
      baselineRepoPath,
      baseline: cfg.baseline === true,
      credentialFiles,
      sourceRepoPath,
      appCredentialFiles,
      appSourceRepoPath,
      app,
      preAgentSha,
      runtime: nodeRuntime(node, runState),
    },
  };
}

async function githubPrNode(node, input, runState) {
  const base = asObject(input);
  const role = nodeRole(node);
  const repository = repositoryForNode(node, base, runState.workflow);
  const external = externalFor({ ...runState, node }, role);
  if (external.detached || !external.branch) {
    throw new Error("Cannot open a pull request from a detached worktree");
  }
  const guarded = await applyGuard(node, base, runState, "push");
  if (!guarded.ok) return guardOutput(base, guarded);
  const head = await git.revParse(external.worktreePath);
  try {
    assertPullRequestGate({
      external: runState.external,
      predecessorId: runState.predecessorId,
      head,
      role,
    });
  } catch (err) {
    const slack = require("../services/slackService");
    await slack.emit(runState.runId, "gate_failed", { reason: err.message, stage: "pr_open" });
    throw err;
  }
  const otherRole = role === "app" ? "automation" : role === "automation" ? "app" : "";
  const other = otherRole ? externalFor({ ...runState, node }, otherRole) : {};
  const linkedUrl = (other && other.prUrl) || base.linkedPrUrl || base.prUrl || "";
  const token = tokenFromWorkflow(runState.workflow, repository);
  await git.pushBranch({
    worktreePath: external.worktreePath,
    branch: external.branch,
    testedSha: external.testedSha,
    token,
  });
  const owner = (repository && repository.owner) || config.githubOwner;
  const repo = (repository && repository.repo) || config.githubRepo;
  const url = await githubPrService.openPullRequest({
    owner,
    repo,
    title: buildPrTitle(base, external.branch),
    head: external.branch,
    base: git.resolveBaseBranch(runState.workflow, repository),
    body: buildPrBody(base, { linkedPrUrl: linkedUrl }),
    token,
  });
  if (runState.checkpointExternal) {
    await runState.checkpointExternal(externalPatch(role, { prUrl: url, prOwner: owner, prRepo: repo }));
  }
  await rememberPrUrl(runState.runId, url, role);
  if (other && other.prUrl && other.prOwner && other.prRepo) {
    try {
      await githubPrService.updatePullRequestBody({
        owner: other.prOwner,
        repo: other.prRepo,
        url: other.prUrl,
        body: buildPrBody(base, { linkedPrUrl: url }),
        token,
      });
    } catch (err) {
      console.error("[githubPr] linked body update failed:", err && err.message);
    }
  }
  const slack = require("../services/slackService");
  await slack.emit(runState.runId, "pr_created", {
    reason: "pull request opened",
    prUrl: url,
    role: role || undefined,
    stage: "pr_open",
  });
  if (runState.checkpointExternal) {
    await runState.checkpointExternal(
      externalPatch(role, { prUrl: url, prOwner: owner, prRepo: repo, worktreeState: "removing" })
    );
  }
  try {
    await git.removeWorktree({
      repoPath: external.repoPath,
      worktreePath: external.worktreePath,
      worktreesDir: config.worktreesDir,
    });
  } catch (err) {
    console.error("[githubPr] worktree remove failed:", err.message);
  }
  const appUrl = role === "app" ? url : linkedUrl;
  const autoUrl = role === "automation" ? url : linkedUrl;
  return {
    ...base,
    prUrl: appUrl || url,
    linkedPrUrl: autoUrl || base.linkedPrUrl || "",
    branch: "true",
  };
}

module.exports = {
  jira: jiraNode,
  jiraUpdate: jiraUpdateNode,
  analysis: analysisNode,
  cursorPrompt: cursorPromptNode,
  gitBranch: gitBranchNode,
  cursorAgent: cursorAgentNode,
  rulesChecks: rulesChecksNode,
  testSelect: testSelectNode,
  playwright: playwrightNode,
  githubPr: githubPrNode,
  repositoryForNode,
  isManualIntake,
};
