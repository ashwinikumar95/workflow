const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const config = require("../../config");

const MODES = ["plan", "implement", "fix", "review"];

const ruleAppliedSchema = z.union([
  z.string().min(1),
  z.object({
    file: z.string().min(1),
    how: z.string().optional(),
    affect: z.string().optional(),
  }),
]);

const planSchema = z.object({
  approach: z.string().min(1),
  filesToChange: z.array(z.string()),
  modules: z.array(z.string()),
  testsToRunOrWrite: z.array(z.string()),
  rulesApplied: z.array(ruleAppliedSchema),
  risks: z.array(z.string()),
  questions: z.array(z.string()),
});

const resultSchema = z.object({
  summary: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  rulesApplied: z.array(ruleAppliedSchema),
  deviations: z.array(z.string()),
});

const severitySchema = z.enum(["high", "medium", "low"]);

const confirmedSchema = z.object({
  rule: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  detail: z.string().min(1),
  severity: severitySchema,
  evidence: z.string().min(1),
});

const potentialSchema = z.object({
  rule: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  detail: z.string().min(1),
  severity: severitySchema,
  whatWouldConfirm: z.string().min(1),
  evidence: z.string().optional(),
});

const uncertaintySchema = z.object({
  rule: z.string().min(1),
  question: z.string().min(1),
});

const reviewSchema = z.object({
  confirmed: z.array(confirmedSchema),
  potential: z.array(potentialSchema),
  uncertainties: z.array(uncertaintySchema),
});

function normalizeMode(value) {
  if (typeof value !== "string") return "";
  const mode = value.trim().toLowerCase();
  return MODES.includes(mode) ? mode : "";
}

function isReadOnlyMode(mode) {
  return mode === "plan" || mode === "review";
}

function artifactDirFor(runId, worktreesDir) {
  const root = worktreesDir || config.worktreesDir || "";
  return path.join(root, String(runId || ""));
}

function artifactPath(runId, name, worktreesDir) {
  return path.join(artifactDirFor(runId, worktreesDir), name);
}

function planPath(runId, worktreesDir) {
  return artifactPath(runId, "plan.json", worktreesDir);
}

function resultPath(runId, worktreesDir) {
  return artifactPath(runId, "result.json", worktreesDir);
}

function reviewPath(runId, worktreesDir) {
  return artifactPath(runId, "review.json", worktreesDir);
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text == null ? "" : text), "utf8").digest("hex");
}

function sha256File(file) {
  return sha256Text(fs.readFileSync(file));
}

function parseJsonFile(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: "missing_artifact" };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  return { ok: true, value: parsed, hash: sha256File(file) };
}

function parseWith(schema, value) {
  const checked = schema.safeParse(value);
  if (!checked.success) return { ok: false, reason: "schema" };
  return { ok: true, value: checked.data };
}

function readPlan(file) {
  const raw = parseJsonFile(file);
  if (!raw.ok) return raw;
  const checked = parseWith(planSchema, raw.value);
  if (!checked.ok) return checked;
  return { ok: true, value: checked.value, hash: raw.hash };
}

function readResult(file) {
  const raw = parseJsonFile(file);
  if (!raw.ok) return raw;
  const checked = parseWith(resultSchema, raw.value);
  if (!checked.ok) return checked;
  return { ok: true, value: checked.value, hash: raw.hash };
}

function readReview(file) {
  const raw = parseJsonFile(file);
  if (!raw.ok) return raw;
  const checked = parseWith(reviewSchema, raw.value);
  if (!checked.ok) return checked;
  return { ok: true, value: checked.value, hash: raw.hash };
}

function validateModeArtifact(mode, dir) {
  if (mode === "plan") return readPlan(path.join(dir || "", "plan.json"));
  if (mode === "review") return readReview(path.join(dir || "", "review.json"));
  if (mode === "implement" || mode === "fix") return readResult(path.join(dir || "", "result.json"));
  return { ok: true, value: null };
}

module.exports = {
  MODES,
  planSchema,
  resultSchema,
  reviewSchema,
  confirmedSchema,
  potentialSchema,
  uncertaintySchema,
  normalizeMode,
  isReadOnlyMode,
  artifactDirFor,
  planPath,
  resultPath,
  reviewPath,
  sha256Text,
  sha256File,
  readPlan,
  readResult,
  readReview,
  validateModeArtifact,
};
