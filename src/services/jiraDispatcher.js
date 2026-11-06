const mongoose = require("mongoose");
const Run = require("../models/Run");
const TicketRun = require("../models/TicketRun");
const Workflow = require("../models/workflow");
const jira = require("./jiraService");
const resourceLocks = require("./resourceLocks");
const ticketState = require("./ticketState");
const recovery = require("./recovery");
const { parseProfiles, resolveProfile } = require("./projectRegistry");
const { enqueueWorkflowJob } = require("./enqueueWorkflowJob");

const DISPATCHER_LOCK = "dispatcher";
const DISPATCHER_OWNER = "dispatcher";

function httpError(message, statusCode, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function profilesFrom(deps = {}) {
  if (deps.profiles) return deps.profiles;
  return parseProfiles(deps.dir);
}

function hasModuleRef(issue) {
  const tags = Array.isArray(issue && issue.tags) ? issue.tags : [];
  if (tags.length) return true;
  const blob = `${(issue && issue.summary) || ""}\n${(issue && issue.descriptionText) || ""}`;
  return /tests\/e2e/i.test(blob);
}

function assessEligibility(issue, profile, options = {}) {
  const paste = options.source === "paste";
  if (!profile) return { ok: false, reason: "unknown_project" };
  if (!paste && !options.ignoreEnabled && !profile.enabled) {
    return { ok: false, reason: "disabled_profile" };
  }
  if (!String(issue && issue.descriptionText ? issue.descriptionText : "").trim()) {
    return { ok: false, reason: "missing_description" };
  }
  if (profile.kind === "automation" && !hasModuleRef(issue)) {
    return { ok: false, reason: "missing_module_ref" };
  }
  return { ok: true };
}

async function latestTicket(jiraKey) {
  return TicketRun.findOne({ jiraKey }).sort({ createdAt: -1, _id: -1 });
}

function isAppTicketKey(profileKey) {
  return profileKey === "MF" || profileKey === "MFC";
}

async function findPublishedByIntake(profileKey, intake) {
  if (intake === "manual") {
    return Workflow.findOne({
      status: "published",
      "trigger.config.intake": "manual",
      "trigger.config.profileKeys": profileKey,
    }).sort({ updatedAt: -1 });
  }
  return Workflow.findOne({
    profileKey,
    status: "published",
    "trigger.config.intake": "bucket",
  }).sort({ updatedAt: -1 });
}

async function findUnlabeledPublished(profileKey) {
  return Workflow.findOne({
    profileKey,
    status: "published",
    $or: [
      { "trigger.config.intake": { $exists: false } },
      { "trigger.config.intake": null },
      { "trigger.config.intake": "" },
    ],
  }).sort({ updatedAt: -1 });
}

async function findProfileWorkflow(profileKey, deps = {}, source = "bucket") {
  if (typeof deps.findWorkflow === "function") {
    return deps.findWorkflow(profileKey, source);
  }
  if (source === "paste") {
    const manual = await findPublishedByIntake(profileKey, "manual");
    if (manual) return manual;
    const unlabeled = await findUnlabeledPublished(profileKey);
    if (unlabeled) return unlabeled;
    return Workflow.findOne({ profileKey, status: "published" }).sort({ updatedAt: -1 });
  }
  if (isAppTicketKey(profileKey)) {
    return findPublishedByIntake(profileKey, "bucket");
  }
  const unlabeled = await findUnlabeledPublished(profileKey);
  if (unlabeled) return unlabeled;
  return Workflow.findOne({ profileKey, status: "published" }).sort({ updatedAt: -1 });
}

async function hasPublishedBucketWorkflow(profileKey, deps = {}) {
  if (typeof deps.hasBucketWorkflow === "function") {
    return deps.hasBucketWorkflow(profileKey);
  }
  const workflow = await findPublishedByIntake(profileKey, "bucket");
  return Boolean(workflow) && !workflowPaused(workflow);
}

function workflowPaused(workflow) {
  return Boolean(workflow && workflow.trigger && workflow.trigger.enabled === false);
}

async function startTicket(issue, profile, options = {}) {
  const deps = options.deps || {};
  const source = options.source || "bucket";
  const eligibility = assessEligibility(issue, profile, { source });
  if (!eligibility.ok) {
    const slack = require("./slackService");
    await slack.emit(null, "skipped_ineligible", {
      jiraKey: issue && issue.key,
      project: profile && profile.jiraKey,
      reason: eligibility.reason,
      stage: issue && issue.status,
    });
    return { ok: false, reason: eligibility.reason, jiraKey: issue && issue.key };
  }

  const existing = await latestTicket(issue.key);
  if (existing && !ticketState.isTerminal(existing.state)) {
    return { ok: false, reason: "duplicate", jiraKey: issue.key, runId: existing.runId };
  }
  if (existing && existing.fingerprint && existing.fingerprint === issue.fingerprint) {
    return { ok: false, reason: "unchanged", jiraKey: issue.key, runId: existing.runId };
  }

  const workflow = await findProfileWorkflow(profile.jiraKey, deps, source);
  if (!workflow) {
    return { ok: false, reason: "missing_workflow", jiraKey: issue.key };
  }
  if (workflowPaused(workflow)) {
    return { ok: false, reason: "workflow_paused", jiraKey: issue.key };
  }

  const runId = new mongoose.Types.ObjectId();
  const jobId = `jira-${issue.key}-${String(runId)}`;
  const input = {
    issueKey: issue.key,
    issueId: issue.id,
    jira: issue,
    fingerprint: issue.fingerprint,
    profileKey: profile.jiraKey,
    source,
  };

  await Run.create({
    _id: runId,
    workflowId: workflow._id,
    jobId,
    status: "running",
    startedAt: new Date(),
    context: input,
    logs: [],
  });

  let ticket;
  try {
    ticket = await ticketState.createLive({
      jiraKey: issue.key,
      profileKey: profile.jiraKey,
      runId: String(runId),
      fingerprint: issue.fingerprint,
      stage: "claimed",
    });
  } catch (err) {
    await Run.deleteOne({ _id: runId });
    if (err && err.code === "TICKET_BUSY") {
      return { ok: false, reason: "duplicate", jiraKey: issue.key };
    }
    throw err;
  }

  const enqueue = deps.enqueue || enqueueWorkflowJob;
  try {
    const job = await enqueue(workflow._id, input, { jobId });
    return {
      ok: true,
      jiraKey: issue.key,
      profileKey: profile.jiraKey,
      runId: String(runId),
      jobId: job && job.id ? String(job.id) : jobId,
      workflowId: String(workflow._id),
      fingerprint: issue.fingerprint,
    };
  } catch (err) {
    await Run.updateOne({ _id: runId }, { $set: { status: "failed", endedAt: new Date() } });
    if (ticketState.isAllowed("claimed", "skipped")) {
      await ticketState.transition(ticket._id, "claimed", "skipped", {
        failureReason: err.message,
      });
    }
    throw err;
  }
}

async function startFromIssue(raw, options = {}) {
  const extraDeps = options.deps && typeof options.deps === "object" ? options.deps : {};
  const deps = { ...options, ...extraDeps };
  const key = jira.parseIssueRef(raw);
  if (!key) {
    throw httpError("Invalid issue key", 400, { reason: "invalid_issue" });
  }
  const profiles = profilesFrom(deps);
  const profile = resolveProfile(key, profiles);
  if (!profile) {
    throw httpError("Issue is not in MF, MFC, QUT, or TAC", 400, { reason: "unknown_project" });
  }
  const issue = await jira.fetchIssue(key, deps);
  const result = await startTicket(issue, profile, { source: "paste", deps });
  if (result.ok) return result;
  if (result.reason === "duplicate") {
    throw httpError("A live run already exists for this ticket", 409, result);
  }
  if (result.reason === "missing_workflow") {
    throw httpError(`No published workflow for ${profile.jiraKey}`, 404, result);
  }
  if (result.reason === "unknown_project") {
    throw httpError("Issue is not in MF, MFC, QUT, or TAC", 400, result);
  }
  const err = httpError(result.reason || "Ticket was not started", 400, result);
  throw err;
}

function emptyProfileReport(profile) {
  return {
    jiraKey: profile.jiraKey,
    enabled: profile.enabled,
    eligible: [],
    ineligible: [],
    started: [],
    skipped: [],
  };
}

function searchDepsFor(deps = {}) {
  const cfg = deps.config || require("../../config");
  const next = { ...deps };
  if (!Number.isInteger(next.maxIssues) || next.maxIssues <= 0) {
    next.maxIssues = cfg.jiraSearchMaxIssues;
  }
  if (!Number.isInteger(next.pageDelayMs) || next.pageDelayMs < 0) {
    next.pageDelayMs = cfg.jiraSearchPageDelayMs;
  }
  return next;
}

async function pollProfile(profile, deps, dryRun, report) {
  let issues = [];
  try {
    issues = await jira.searchIssues(profile.eligibleJql, searchDepsFor(deps));
    if (issues && issues.truncated) {
      report.truncated = true;
      report.truncateReason = issues.reason || "truncated";
    }
  } catch (err) {
    if (jira.is429(err)) {
      report.rateLimited = true;
      return;
    }
    throw err;
  }
  for (const issue of issues) {
    const eligibility = assessEligibility(issue, profile, {
      source: "bucket",
      ignoreEnabled: dryRun,
    });
    if (!eligibility.ok) {
      report.ineligible.push({ key: issue.key, reason: eligibility.reason, status: issue.status });
      if (!dryRun) {
        const slack = require("./slackService");
        await slack.emit(null, "skipped_ineligible", {
          jiraKey: issue.key,
          project: profile.jiraKey,
          reason: eligibility.reason,
          stage: issue.status,
        });
      }
      continue;
    }
    report.eligible.push({ key: issue.key, fingerprint: issue.fingerprint, status: issue.status });
    if (dryRun) continue;
    const started = await startTicket(issue, profile, { source: "bucket", deps });
    if (started.ok) report.started.push(started);
    else report.skipped.push({ key: issue.key, reason: started.reason });
  }
}

/**
 * @param {{ dryRun?: boolean, deps?: object }} [options]
 */
async function dispatch(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const extraDeps = options.deps && typeof options.deps === "object" ? options.deps : {};
  const deps = { ...options, ...extraDeps };
  const profiles = profilesFrom(deps);
  const report = {
    dryRun,
    recovered: null,
    lock: null,
    profiles: [],
  };

  if (!dryRun) {
    const recover = deps.recoverStale || recovery.recoverStale;
    report.recovered = await recover(deps);
    const lock = await resourceLocks.acquire(DISPATCHER_OWNER, [DISPATCHER_LOCK], {
      ttlMs: deps.ttlMs,
      token: deps.lockToken,
    });
    report.lock = { ok: lock.ok, reason: lock.reason || null };
    if (!lock.ok) return report;
    try {
      const list = Object.values(profiles).filter((profile) => profile.enabled);
      for (const profile of list) {
        const row = emptyProfileReport(profile);
        if (isAppTicketKey(profile.jiraKey) && !(await hasPublishedBucketWorkflow(profile.jiraKey, deps))) {
          row.skipped.push({ reason: "missing_workflow" });
          report.profiles.push(row);
          continue;
        }
        await pollProfile(profile, deps, false, row);
        report.profiles.push(row);
      }
    } finally {
      await resourceLocks.release(DISPATCHER_OWNER, lock.token, [DISPATCHER_LOCK]);
    }
    return report;
  }

  for (const profile of Object.values(profiles)) {
    const row = emptyProfileReport(profile);
    if (!profile.enabled) {
      row.skipped.push({ reason: "disabled_profile" });
    }
    await pollProfile(profile, deps, true, row);
    report.profiles.push(row);
  }
  return report;
}

async function pollOneProfile(profileKey, options = {}) {
  const extraDeps = options.deps && typeof options.deps === "object" ? options.deps : {};
  const deps = { ...options, ...extraDeps };
  const profiles = profilesFrom(deps);
  const profile = profiles[profileKey];
  if (!profile) return { ok: false, reason: "unknown_project", jiraKey: profileKey };
  const row = emptyProfileReport(profile);
  await pollProfile(profile, deps, Boolean(options.dryRun), row);
  return row;
}

module.exports = {
  DISPATCHER_LOCK,
  DISPATCHER_OWNER,
  assessEligibility,
  startTicket,
  startFromIssue,
  dispatch,
  searchDepsFor,
  findProfileWorkflow,
  pollOneProfile,
  hasPublishedBucketWorkflow,
};
