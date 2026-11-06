const axios = require("axios");
const mongoose = require("mongoose");
const config = require("../../config");
const Run = require("../models/Run");
const TicketRun = require("../models/TicketRun");
const { redactOutput } = require("./forbiddenEnv");

const EVENT_TYPES = [
  "waiting_for_approval",
  "plan_rejected",
  "gate_failed",
  "rules_violation",
  "playwright_failed",
  "env_failed",
  "app_bug_blocked",
  "interrupted",
  "cancelled",
  "crashed",
  "skipped_ineligible",
  "pr_created",
];

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const OUTBOX = "slack_outbox";
const STALE_MS = 30 * 1000;
const SEND_TIMEOUT_MS = 8000;

let sendImpl = defaultSend;

function setSender(fn) {
  sendImpl = typeof fn === "function" ? fn : defaultSend;
}

async function defaultSend(url, payload) {
  await axios.post(url, payload, { timeout: SEND_TIMEOUT_MS });
}

function sanitizeEventId(value) {
  const text = String(value == null ? "" : value).replace(/[^A-Za-z0-9_-]/g, "_");
  return text.slice(0, 120);
}

function eventIdFor(type, details = {}) {
  if (details.eventId) {
    const given = sanitizeEventId(details.eventId);
    if (given) return given;
  }
  const kind = sanitizeEventId(type) || "event";
  if (kind === "waiting_for_approval" && details.nodeId) {
    return sanitizeEventId(`waiting_for_approval_${details.nodeId}`);
  }
  if (kind === "skipped_ineligible" && details.jiraKey) {
    return sanitizeEventId(`skipped_ineligible_${details.jiraKey}`);
  }
  if (kind === "notify" && details.nodeId) {
    return sanitizeEventId(`notify_${details.nodeId}`);
  }
  return kind;
}

function typeFromFailure(message) {
  const text = String(message == null ? "" : message);
  if (/Pull request gate rejected/i.test(text)) return "gate_failed";
  if (/rules_violation|rules? violation/i.test(text)) return "rules_violation";
  if (
    /\bfailureClass["']?\s*[:=]\s*["']env["']/i.test(text) ||
    /\breason["']?\s*[:=]\s*["']env["']/i.test(text) ||
    /missing \.auth/i.test(text) ||
    /playwright\/\.auth/i.test(text)
  ) {
    return "env_failed";
  }
  return "crashed";
}

function redactText(value) {
  return redactOutput(String(value == null ? "" : value));
}

function redactDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = typeof value === "string" ? redactText(value) : value;
    }
  }
  return out;
}

function webhookUrl() {
  const url = config.slackWebhookUrl;
  return typeof url === "string" && url.trim() ? url.trim() : "";
}

function mongoReady() {
  return mongoose.connection.readyState === 1;
}

function appBaseUrl() {
  if (typeof config.appBaseUrl === "string" && config.appBaseUrl) return config.appBaseUrl.replace(/\/$/, "");
  return `http://localhost:${config.port || 3000}`;
}

function formatText({ type, project, jiraKey, stage, reason, runUrl, extra }) {
  const who = [jiraKey, project ? `(${project})` : ""].filter(Boolean).join(" ");
  const lines = [`*[${type}]*${who ? ` ${who}` : ""}`];
  if (stage) lines.push(`Stage: ${stage}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (extra) lines.push(String(extra));
  if (runUrl) lines.push(`Run: ${runUrl}`);
  return redactText(lines.join("\n"));
}

async function contextFor(runId, details = {}) {
  const extra = redactDetails(details);
  if (!runId) {
    return {
      project: extra.project || "",
      jiraKey: extra.jiraKey || "",
      stage: extra.stage || "",
      reason: extra.reason || extra.message || extra.type || "",
      runUrl: extra.runUrl || "",
      extra: extra.prUrl || extra.extra || "",
    };
  }
  const run = await Run.findById(runId).lean();
  const ticket = await TicketRun.findOne({ runId: String(runId) }).lean();
  const ctx = run && run.context && typeof run.context === "object" ? run.context : {};
  const jira = ctx.jira && typeof ctx.jira === "object" ? ctx.jira : {};
  const jiraKey =
    extra.jiraKey ||
    (ticket && ticket.jiraKey) ||
    ctx.issueKey ||
    ctx.jiraKey ||
    jira.key ||
    "";
  const project =
    extra.project || (ticket && ticket.profileKey) || ctx.profileKey || "";
  const stage =
    extra.stage ||
    (ticket && (ticket.stage || ticket.state)) ||
    (run && run.status) ||
    "";
  const workflowId = run && run.workflowId ? String(run.workflowId) : extra.workflowId || "";
  const runUrl =
    extra.runUrl ||
    (workflowId && runId ? `${appBaseUrl()}/workflows/${workflowId}/runs/${runId}` : "");
  return {
    project,
    jiraKey,
    stage,
    reason: extra.reason || extra.message || "",
    runUrl,
    extra: extra.prUrl || extra.extra || "",
  };
}

function now() {
  return new Date();
}

function isStale(record, at) {
  if (!record || record.status === "failed") return true;
  if (record.status !== "pending") return false;
  const claimed = record.claimedAt ? new Date(record.claimedAt).getTime() : 0;
  return !claimed || at - claimed >= STALE_MS;
}

async function claimOnRun(runId, eventId, record) {
  return Run.findOneAndUpdate(
    { _id: runId, [`notifications.${eventId}`]: { $exists: false } },
    {
      $set: { [`notifications.${eventId}`]: record },
      $addToSet: { notificationPending: eventId },
    },
    { returnDocument: "after" }
  );
}

async function reclaimOnRun(runId, eventId, at) {
  const stale = new Date(at.getTime() - STALE_MS);
  return Run.findOneAndUpdate(
    {
      _id: runId,
      $or: [
        { [`notifications.${eventId}.status`]: "failed" },
        {
          [`notifications.${eventId}.status`]: "pending",
          [`notifications.${eventId}.claimedAt`]: { $lte: stale },
        },
        {
          [`notifications.${eventId}.status`]: "pending",
          [`notifications.${eventId}.claimedAt`]: { $exists: false },
        },
      ],
    },
    {
      $set: {
        [`notifications.${eventId}.status`]: "pending",
        [`notifications.${eventId}.claimedAt`]: at,
      },
      $addToSet: { notificationPending: eventId },
      $inc: { [`notifications.${eventId}.attempts`]: 1 },
    },
    { returnDocument: "after" }
  );
}

async function finalizeOnRun(runId, eventId, patch) {
  const setDoc = {};
  for (const [key, value] of Object.entries(patch)) {
    setDoc[`notifications.${eventId}.${key}`] = value;
  }
  const update = { $set: setDoc };
  if (patch.status === "sent" || patch.status === "logged") {
    update.$pull = { notificationPending: eventId };
  }
  await Run.updateOne({ _id: runId, [`notifications.${eventId}`]: { $exists: true } }, update);
}

async function outboxCollection() {
  return mongoose.connection.collection(OUTBOX);
}

async function claimOutbox(eventId, record) {
  const col = await outboxCollection();
  try {
    await col.insertOne({ _id: eventId, ...record });
    return { _id: eventId, ...record };
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
}

async function reclaimOutbox(eventId, at) {
  const col = await outboxCollection();
  const stale = new Date(at.getTime() - STALE_MS);
  return col.findOneAndUpdate(
    {
      _id: eventId,
      $or: [
        { status: "failed" },
        { status: "pending", claimedAt: { $lte: stale } },
        { status: "pending", claimedAt: { $exists: false } },
      ],
    },
    {
      $set: { status: "pending", claimedAt: at },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" }
  );
}

async function finalizeOutbox(eventId, patch) {
  const col = await outboxCollection();
  await col.updateOne({ _id: eventId }, { $set: patch });
}

async function deliver(url, text, target) {
  if (!url) {
    console.log("[slack]", text);
    const logged = { status: "logged", lastError: null };
    if (target.runId) await finalizeOnRun(target.runId, target.eventId, logged);
    else await finalizeOutbox(target.eventId, logged);
    return { ok: true, skipped: true, status: "logged", eventId: target.eventId, text };
  }
  try {
    await sendImpl(url, { text });
    const sent = { status: "sent", sentAt: now(), lastError: null };
    if (target.runId) await finalizeOnRun(target.runId, target.eventId, sent);
    else await finalizeOutbox(target.eventId, sent);
    return { ok: true, status: "sent", eventId: target.eventId, text };
  } catch (err) {
    const message = redactText(err && err.message ? err.message : "send failed");
    const failed = { status: "failed", lastError: message };
    if (target.runId) await finalizeOnRun(target.runId, target.eventId, failed);
    else await finalizeOutbox(target.eventId, failed);
    console.error("[slack] send failed:", message);
    return { ok: false, status: "failed", eventId: target.eventId, text, error: message };
  }
}

/**
 * Store `notifications[eventId]` on the run (or the outbox when there is no run)
 * before posting. A second emit with the same id is a no-op. Send failures do
 * not throw; the worker timer retries them.
 */
async function emit(runId, type, details = {}) {
  try {
    const kind = sanitizeEventId(type);
    if (!kind) return { ok: false, error: "missing type" };
    const eventId = eventIdFor(kind, details);
    const ctx = await contextFor(runId, { ...details, type: kind });
    const text = formatText({ type: kind, ...ctx });
    const at = now();
    const record = {
      type: kind,
      status: "pending",
      text,
      details: {
        project: ctx.project,
        jiraKey: ctx.jiraKey,
        stage: ctx.stage,
        reason: ctx.reason,
        runUrl: ctx.runUrl,
      },
      attempts: 1,
      lastError: null,
      createdAt: at,
      claimedAt: at,
    };

    const url = webhookUrl();
    if (runId && mongoReady()) {
      const claimed = await claimOnRun(runId, eventId, record);
      if (!claimed) {
        const existing = await Run.findById(runId).lean();
        const prior = existing && existing.notifications && existing.notifications[eventId];
        return {
          ok: true,
          duplicate: true,
          status: prior && prior.status ? prior.status : "pending",
          eventId,
          text: prior && prior.text ? prior.text : text,
        };
      }
      return deliver(url, text, { runId, eventId });
    }

    if (!runId && mongoReady()) {
      const claimed = await claimOutbox(eventId, record);
      if (!claimed) {
        return { ok: true, duplicate: true, status: "pending", eventId, text };
      }
      return deliver(url, text, { eventId });
    }

    if (!url) {
      console.log("[slack]", text);
      return { ok: true, skipped: true, status: "logged", eventId, text };
    }
    try {
      await sendImpl(url, { text });
      return { ok: true, status: "sent", eventId, text };
    } catch (err) {
      const message = redactText(err && err.message ? err.message : "send failed");
      console.error("[slack] send failed:", message);
      return { ok: false, status: "failed", eventId, text, error: message };
    }
  } catch (err) {
    const message = err && err.message ? String(err.message) : "emit failed";
    console.error("[slack] emit failed:", message);
    return { ok: false, error: message };
  }
}

async function retryPending() {
  const retried = [];
  const url = webhookUrl();
  const at = now();

  const runs = await Run.find({ "notificationPending.0": { $exists: true } })
    .select("notifications notificationPending")
    .lean();
  for (const row of runs) {
    const pending = Array.isArray(row.notificationPending) ? row.notificationPending : [];
    const notes = row.notifications && typeof row.notifications === "object" ? row.notifications : {};
    for (const eventId of pending) {
      const rec = notes[eventId];
      if (!rec || !isStale(rec, at.getTime())) continue;
      const claimed = await reclaimOnRun(row._id, eventId, at);
      if (!claimed) continue;
      const latest = claimed.notifications && claimed.notifications[eventId];
      const text = latest && latest.text ? latest.text : rec.text;
      retried.push(await deliver(url, text, { runId: row._id, eventId }));
    }
  }

  try {
    const col = await outboxCollection();
    const stale = new Date(at.getTime() - STALE_MS);
    const rows = await col
      .find({
        $or: [
          { status: "failed" },
          { status: "pending", claimedAt: { $lte: stale } },
          { status: "pending", claimedAt: { $exists: false } },
        ],
      })
      .toArray();
    for (const row of rows) {
      const claimed = await reclaimOutbox(row._id, at);
      if (!claimed) continue;
      const doc = claimed.value || claimed;
      retried.push(await deliver(url, doc.text || row.text, { eventId: row._id }));
    }
  } catch (err) {
    if (!/ns does not exist|namespace/i.test(String(err && err.message))) {
      console.error("[slack] outbox retry failed:", err.message);
    }
  }

  return retried;
}

async function emitFromJob(job, err) {
  if (!job || (err && err.code === "RUN_CLAIM_BUSY")) return { ok: true, skipped: true };
  const data = job.data && typeof job.data === "object" ? job.data : {};
  let run = null;
  if (data.runId) run = await Run.findById(data.runId);
  if (!run && job.id) run = await Run.findOne({ jobId: String(job.id) });
  if (!run) return { ok: true, skipped: true, reason: "run_not_found" };
  const message = err && err.message ? err.message : "job failed";
  return emit(run._id, typeFromFailure(message), { reason: message, jobId: String(job.id) });
}

module.exports = {
  EVENT_TYPES,
  EVENT_TYPE_SET,
  emit,
  emitFromJob,
  retryPending,
  eventIdFor,
  typeFromFailure,
  setSender,
  formatText,
};
