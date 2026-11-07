const TicketRun = require("../models/TicketRun");
const { TERMINAL_STATES } = TicketRun;

const ALLOWED = {
  claimed: ["planning", "skipped", "cancelled", "failed"],
  planning: ["awaiting_approval", "blocked", "interrupted", "failed", "cancelled"],
  awaiting_approval: ["rejected", "expired", "queued", "cancelled", "failed"],
  queued: ["implementing", "planning", "cancelled", "failed"],
  implementing: ["verifying", "blocked", "interrupted", "cancelled", "failed"],
  verifying: ["implementing", "pr_open", "blocked", "interrupted", "cancelled", "failed"],
  pr_open: ["completed", "blocked", "interrupted", "cancelled", "failed"],
  interrupted: ["planning", "implementing", "verifying", "cancelled", "failed"],
  expired: ["planning", "cancelled", "failed"],
};

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

function isAllowed(from, to) {
  const next = ALLOWED[from];
  return Boolean(next && next.includes(to));
}

function listedTransitions() {
  const pairs = [];
  for (const [from, tos] of Object.entries(ALLOWED)) {
    for (const to of tos) pairs.push([from, to]);
  }
  return pairs;
}

async function createLive(doc) {
  try {
    return await TicketRun.create({
      state: "claimed",
      stage: "claimed",
      ...doc,
    });
  } catch (err) {
    if (err && (err.code === 11000 || /E11000/.test(String(err.message || "")))) {
      const dup = new Error("TICKET_BUSY");
      dup.code = "TICKET_BUSY";
      throw dup;
    }
    throw err;
  }
}

async function markEnded(runId, to, patch = {}) {
  const dest = to === "cancelled" ? "cancelled" : "failed";
  const ticket = await TicketRun.findOne({ runId: String(runId) });
  if (!ticket || isTerminal(ticket.state)) return { ok: true, skipped: true, ticket };
  if (isAllowed(ticket.state, dest)) {
    return transition(ticket._id, ticket.state, dest, patch);
  }
  if (dest !== "cancelled" && isAllowed(ticket.state, "cancelled")) {
    return transition(ticket._id, ticket.state, "cancelled", patch);
  }
  return { ok: false, reason: "invalid_transition", from: ticket.state, to: dest };
}

async function transition(id, from, to, patch = {}) {
  if (!isAllowed(from, to)) {
    console.error(`[ticketState] refused ${from} -> ${to}`);
    return { ok: false, reason: "invalid_transition", from, to };
  }
  const extra = patch && typeof patch === "object" && !Array.isArray(patch) ? { ...patch } : {};
  delete extra.state;
  const updated = await TicketRun.findOneAndUpdate(
    { _id: id, state: from },
    { $set: { ...extra, state: to } },
    { returnDocument: "after" }
  );
  if (!updated) {
    return { ok: false, reason: "cas_failed", from, to };
  }
  return { ok: true, ticket: updated };
}

module.exports = {
  ALLOWED,
  TERMINAL_STATES,
  isTerminal,
  isAllowed,
  listedTransitions,
  createLive,
  transition,
  markEnded,
};
