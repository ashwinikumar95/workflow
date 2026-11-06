const { v4: uuidv4 } = require("uuid");
const ResourceLock = require("../models/ResourceLock");
const Run = require("../models/Run");
const TicketRun = require("../models/TicketRun");
const ticketState = require("./ticketState");

const TTL_MS = 5 * 60 * 1000;
const LIVE_RUN_STATUSES = new Set(["running", "waiting"]);

const ENV_BY_PROFILE = {
  MF: "env:dms",
  QUT: "env:dms",
  MFC: "env:central",
  TAC: "env:central",
};

const PORT_BY_PROFILE = {
  MF: "port:5182",
  QUT: "port:5182",
  MFC: "port:5181",
  TAC: "port:5181",
};

function isDup(err) {
  return Boolean(err && (err.code === 11000 || err.code === 11001 || /E11000/.test(String(err.message || ""))));
}

function envResourcesForProfile(profileKey) {
  const env = ENV_BY_PROFILE[String(profileKey || "").toUpperCase()];
  return env ? [env] : [];
}

function portResourceForProfile(profileKey) {
  return PORT_BY_PROFILE[String(profileKey || "").toUpperCase()] || "";
}

function resourcesForProfile(profileKey) {
  const names = envResourcesForProfile(profileKey);
  const port = portResourceForProfile(profileKey);
  if (port) names.push(port);
  return names;
}

function sortNames(names) {
  return [...new Set((names || []).map((name) => String(name)).filter(Boolean))].sort();
}

async function acquire(owner, names, options = {}) {
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TTL_MS;
  const token = options.token || uuidv4();
  const sorted = sortNames(names);
  const acquired = [];
  const now = options.now instanceof Date ? options.now : new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    for (const name of sorted) {
      try {
        await ResourceLock.create({
          _id: name,
          owner: String(owner),
          token,
          acquiredAt: now,
          expiresAt,
        });
        acquired.push(name);
      } catch (err) {
        if (isDup(err)) {
          if (acquired.length) {
            await ResourceLock.deleteMany({
              _id: { $in: acquired },
              owner: String(owner),
              token,
            });
          }
          return { ok: false, reason: "busy", held: name, token: null, names: [] };
        }
        throw err;
      }
    }
    return { ok: true, token, names: sorted };
  } catch (err) {
    if (acquired.length) {
      await ResourceLock.deleteMany({ owner: String(owner), token });
    }
    throw err;
  }
}

async function release(owner, token, names) {
  if (!owner || !token) return { deletedCount: 0 };
  const filter = { owner: String(owner), token };
  if (Array.isArray(names) && names.length) filter._id = { $in: names };
  return ResourceLock.deleteMany(filter);
}

async function releaseByOwner(owner) {
  const locks = await ResourceLock.find({ owner: String(owner) }).lean();
  let deletedCount = 0;
  for (const lock of locks) {
    const result = await ResourceLock.deleteOne({
      _id: lock._id,
      owner: String(owner),
      token: lock.token,
    });
    deletedCount += result.deletedCount || 0;
  }
  return { deletedCount };
}

async function heartbeat(now = new Date()) {
  const locks = await ResourceLock.find({ expiresAt: { $gt: now } }).lean();
  let extended = 0;
  const nextExpiry = new Date(now.getTime() + TTL_MS);
  for (const lock of locks) {
    const run = await Run.findById(lock.owner).select("status").lean();
    if (!run || !LIVE_RUN_STATUSES.has(run.status)) continue;
    const result = await ResourceLock.updateOne(
      {
        _id: lock._id,
        owner: lock.owner,
        token: lock.token,
        expiresAt: { $gt: now },
      },
      { $set: { expiresAt: nextExpiry } }
    );
    if (result.modifiedCount) extended += 1;
  }
  return extended;
}

async function acquireForTicket(ticket) {
  if (!ticket) return { ok: false, reason: "missing_ticket" };
  const names = envResourcesForProfile(ticket.profileKey);
  if (!names.length) return { ok: false, reason: "unknown_profile" };
  const result = await acquire(ticket.runId, names);
  if (!result.ok) {
    if (ticket.state !== "queued" && ticketState.isAllowed(ticket.state, "queued")) {
      await ticketState.transition(ticket._id, ticket.state, "queued");
    }
    return { ...result, queued: true };
  }
  await TicketRun.updateOne({ _id: ticket._id }, { $set: { lockToken: result.token } });
  let state = ticket.state;
  if (state === "awaiting_approval" && ticketState.isAllowed("awaiting_approval", "queued")) {
    const moved = await ticketState.transition(ticket._id, "awaiting_approval", "queued");
    if (moved.ok) state = "queued";
  }
  if (state === "queued" && ticketState.isAllowed("queued", "implementing")) {
    await ticketState.transition(ticket._id, "queued", "implementing", { lockToken: result.token });
  }
  return result;
}

module.exports = {
  TTL_MS,
  ENV_BY_PROFILE,
  envResourcesForProfile,
  portResourceForProfile,
  resourcesForProfile,
  acquire,
  release,
  releaseByOwner,
  heartbeat,
  acquireForTicket,
};
