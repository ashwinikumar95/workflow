const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { z } = require("zod");

const PROJECTS_DIR = path.join(__dirname, "..", "..", "config", "projects");

const commandSchema = z.array(z.string().min(1));

const profileSchema = z.object({
  jiraKey: z.string().min(1),
  kind: z.enum(["app", "automation"]),
  linkedProfile: z.string().min(1),
  enabled: z.boolean(),
  eligibleJql: z.string().min(1),
  transitions: z.object({
    claim: z.string().min(1),
    review: z.string().min(1),
    blocked: z.string().min(1),
  }),
  repo: z.object({
    location: z.string().min(1),
    defaultBranch: z.string().min(1),
    github: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
    }),
    credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    credentialFiles: z.array(z.string().min(1)),
    installCommand: commandSchema.min(1),
    appCommand: commandSchema,
    readiness: z.string(),
    testCommand: commandSchema,
    moduleRoot: z.string(),
    gates: z.array(commandSchema.min(1)),
  }),
  rules: z.object({
    forceInclude: z.array(z.string()),
    extraDocs: z.array(z.string()),
  }),
  moduleMap: z.object({
    rules: z.array(
      z.object({
        match: z.string().min(1),
        modules: z.array(z.string().min(1)).min(1),
      })
    ),
    autoKebabFromViews: z.boolean(),
    sharedPaths: z.array(z.string()),
    sharedFallback: z.array(z.string()),
  }),
  agent: z.object({
    model: z.string().min(1),
    maxFixAttempts: z.number().int().positive(),
  }),
  approvalExpiryHours: z.number().int().positive(),
});

function parseProfile(data) {
  const checked = profileSchema.safeParse(data);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue && issue.path && issue.path.length ? issue.path.join(".") : "profile";
    throw new Error(`Invalid profile: ${where} ${issue ? issue.message : "failed schema validation"}`);
  }
  return checked.data;
}

function defaultGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      shell: false,
      windowsHide: true,
      cwd: options.cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const err = new Error((stderr || stdout || `git exited ${code}`).trim());
        err.code = code;
        reject(err);
      }
    });
  });
}

function parseProfiles(dir = PROJECTS_DIR) {
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  const profiles = {};
  for (const name of names) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const profile = parseProfile(raw);
    const fileKey = name.slice(0, -".json".length);
    if (fileKey !== profile.jiraKey) {
      throw new Error(`Profile file ${name} must match jiraKey ${profile.jiraKey}`);
    }
    if (profiles[profile.jiraKey]) {
      throw new Error(`Duplicate profile ${profile.jiraKey}`);
    }
    profiles[profile.jiraKey] = profile;
  }
  return profiles;
}

function assertLinkedProfiles(profiles) {
  for (const [key, profile] of Object.entries(profiles)) {
    const linked = profiles[profile.linkedProfile];
    if (!linked) {
      throw new Error(`Profile ${key} linkedProfile ${profile.linkedProfile} does not exist`);
    }
    if (linked.linkedProfile !== key) {
      throw new Error(`Non-reciprocal link: ${key} -> ${profile.linkedProfile} -> ${linked.linkedProfile}`);
    }
    if (profile.kind === "app" && linked.kind !== "automation") {
      throw new Error(`App profile ${key} must link to an automation profile`);
    }
    if (profile.kind === "automation" && linked.kind !== "app") {
      throw new Error(`Automation profile ${key} must link to an app profile`);
    }
  }
}

async function assertRepoCheckouts(profiles, deps = {}) {
  const runGit = deps.runGit || defaultGit;
  const exists = deps.exists || ((location) => fs.existsSync(location));
  for (const profile of Object.values(profiles)) {
    const location = profile.repo.location;
    if (!exists(location)) {
      throw new Error(`Repo location does not exist: ${location}`);
    }
    let inside = "";
    try {
      const result = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: location });
      inside = String(result.stdout || "").trim();
    } catch {
      throw new Error(`Repo location is not a git checkout: ${location}`);
    }
    if (inside !== "true") {
      throw new Error(`Repo location is not a git checkout: ${location}`);
    }
    const branch = profile.repo.defaultBranch;
    try {
      await runGit(["rev-parse", "--verify", "--quiet", `origin/${branch}`], { cwd: location });
    } catch {
      throw new Error(`Missing default branch origin/${branch} at ${location}`);
    }
  }
}

async function validateRegistry(profiles, deps = {}) {
  assertLinkedProfiles(profiles);
  if (!deps.skipGit) {
    await assertRepoCheckouts(profiles, deps);
  }
  return profiles;
}

async function loadRegistry(deps = {}) {
  const profiles = parseProfiles(deps.dir || PROJECTS_DIR);
  return validateRegistry(profiles, deps);
}

function resolveProfileKey(issueKey, profiles) {
  const text = String(issueKey || "").trim();
  let found = null;
  for (const key of Object.keys(profiles)) {
    if (text === key || text.startsWith(`${key}-`)) {
      if (!found || key.length > found.length) found = key;
    }
  }
  return found;
}

function resolveProfile(issueKey, profiles) {
  const key = resolveProfileKey(issueKey, profiles);
  return key ? profiles[key] : null;
}

module.exports = {
  PROJECTS_DIR,
  profileSchema,
  parseProfile,
  parseProfiles,
  assertLinkedProfiles,
  assertRepoCheckouts,
  validateRegistry,
  loadRegistry,
  resolveProfileKey,
  resolveProfile,
};
