const TicketRun = require("../models/TicketRun");
const { TERMINAL_STATES } = TicketRun;

const ALLOWED = {
  claimed: ["planning", "skipped", "cancelled"],
  planning: ["awaiting_approval", "interrupted", "failed", "cancelled"],
  awaiting_approval: ["rejected", "expired", "queued", "cancelled"],
  queued: ["implementing", "planning", "cancelled"],
  implementing: ["verifying", "interrupted", "cancelled"],
  verifying: ["implementing", "pr_open", "blocked", "interrupted", "cancelled"],
  pr_open: ["completed", "interrupted", "cancelled"],
  interrupted: ["planning", "implementing", "verifying", "cancelled"],
  expired: ["planning", "cancelled"],
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
};
