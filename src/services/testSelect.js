const fs = require("fs");
const path = require("path");
const git = require("./gitService");
const { matchGlob } = require("./rulesService");
const { summaryTags } = require("./jiraService");
const { parseProfiles, resolveProfile } = require("./projectRegistry");

const DEFAULT_FALLBACK = ["-g", "@sanity"];
const VIEW_GLOB = "src/views/*.vue";

function posix(file) {
  return String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function toKebab(name) {
  return String(name || "")
    .replace(/\.vue$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function listModuleFolders(testsRoot) {
  if (!testsRoot || !fs.existsSync(testsRoot)) return [];
  return fs
    .readdirSync(testsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function findExistingModule(name, existing) {
  const wanted = String(name || "");
  if (!wanted) return "";
  const lower = wanted.toLowerCase();
  const hit = (existing || []).find((entry) => entry === wanted || String(entry).toLowerCase() === lower);
  return hit || "";
}

function moduleMapOf(value) {
  const map = value && typeof value === "object" ? value : {};
  return {
    rules: Array.isArray(map.rules) ? map.rules : [],
    autoKebabFromViews: map.autoKebabFromViews !== false,
    sharedPaths: Array.isArray(map.sharedPaths) ? map.sharedPaths : [],
    sharedFallback: Array.isArray(map.sharedFallback) && map.sharedFallback.length
      ? map.sharedFallback
      : DEFAULT_FALLBACK,
  };
}

function isViewFile(file) {
  return matchGlob(VIEW_GLOB, posix(file));
}

function modulesForFile(file, map, existing) {
  const rel = posix(file);
  const found = [];
  for (const rule of map.rules) {
    if (!rule || !rule.match) continue;
    if (rel === posix(rule.match) || matchGlob(rule.match, rel)) {
      for (const name of Array.isArray(rule.modules) ? rule.modules : []) {
        const folder = findExistingModule(name, existing);
        if (folder && !found.includes(folder)) found.push(folder);
      }
    }
  }
  if (found.length) return found;
  if (map.autoKebabFromViews && isViewFile(rel)) {
    const kebab = toKebab(path.posix.basename(rel));
    const folder = findExistingModule(kebab, existing);
    if (folder) found.push(folder);
  }
  return found;
}

function isShared(file, map) {
  const rel = posix(file);
  return (map.sharedPaths || []).some((pattern) => rel === posix(pattern) || matchGlob(pattern, rel));
}

function grepFromTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const greps = [];
  for (const tag of list) {
    let text = String(tag || "").trim();
    if (!text) continue;
    if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
    if (!text.startsWith("@")) text = `@${text}`;
    if (!greps.includes(text)) greps.push(text);
  }
  return greps;
}

function extractTags(summary, tags) {
  if (Array.isArray(tags) && tags.length) return grepFromTags(tags);
  return grepFromTags(summaryTags(summary));
}

function modulePath(moduleRoot, folder) {
  const root = posix(moduleRoot || "tests/e2e").replace(/\/+$/, "");
  return `${root}/${folder}`;
}

function selectAppTests({ changedFiles, moduleMap, existingModules, moduleRoot } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles.map(posix).filter(Boolean) : [];
  const map = moduleMapOf(moduleMap);
  const existing = Array.isArray(existingModules) ? existingModules : [];
  const selectedModules = [];
  const unmappedFiles = [];
  let sharedHit = false;

  for (const file of files) {
    if (isShared(file, map)) sharedHit = true;
    const modules = modulesForFile(file, map, existing);
    if (modules.length) {
      for (const name of modules) {
        if (!selectedModules.includes(name)) selectedModules.push(name);
      }
      continue;
    }
    if (!isShared(file, map)) unmappedFiles.push(file);
  }

  const nothingMapped = selectedModules.length === 0;
  const fallback = sharedHit || unmappedFiles.length > 0 || nothingMapped;
  let reason = "mapped";
  if (nothingMapped && !files.length) reason = "no-changes";
  else if (nothingMapped) reason = "unmapped";
  else if (sharedHit) reason = "shared-path";
  else if (unmappedFiles.length) reason = "unmapped";

  const selectedPaths = fallback
    ? map.sharedFallback.slice()
    : selectedModules.map((folder) => modulePath(moduleRoot, folder));

  if (fallback && sharedHit) reason = nothingMapped ? "unmapped" : "shared-path";
  if (fallback && unmappedFiles.length && !sharedHit) reason = "unmapped";
  if (fallback && nothingMapped && !unmappedFiles.length && sharedHit) reason = "shared-path";

  return {
    mode: "app",
    selectedModules,
    selectedPaths,
    unmappedFiles,
    fallback,
    reason,
    tags: [],
  };
}

function selectAutomationTests({ changedFiles, summary, tags, moduleRoot } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles.map(posix).filter(Boolean) : [];
  const specs = files.filter((file) => file.endsWith(".spec.ts"));
  const greps = extractTags(summary, tags);
  const selectedPaths = specs.slice();
  if (greps.length) selectedPaths.push("-g", greps.join("|"));
  const fallback = selectedPaths.length === 0;
  return {
    mode: "automation",
    selectedModules: specs.map((file) => path.posix.dirname(file).replace(/^.*\//, "")),
    selectedPaths,
    unmappedFiles: files.filter((file) => !file.endsWith(".spec.ts")),
    fallback,
    reason: fallback ? "empty-selection" : greps.length && specs.length ? "specs-and-tags" : greps.length ? "tags" : "specs",
    tags: greps,
    moduleRoot: moduleRoot || "tests/e2e",
  };
}

function selectTests(opts = {}) {
  const mode = opts.mode === "automation" ? "automation" : "app";
  if (mode === "automation") return selectAutomationTests(opts);
  return selectAppTests(opts);
}

function appendSelection(command, selection) {
  const base = Array.isArray(command) ? command.slice() : [];
  const extra = selection && Array.isArray(selection.selectedPaths) ? selection.selectedPaths : [];
  for (const arg of extra) {
    if (arg == null || arg === "") continue;
    base.push(String(arg));
  }
  return base;
}

async function changedFilesFromGit(worktreePath, fromSha, toSha) {
  if (!worktreePath || !fromSha) return [];
  try {
    return await git.diffNameOnly(fromSha, toSha || "HEAD", worktreePath);
  } catch (err) {
    if (err && err.code === 1 && err.stdout != null) {
      return String(err.stdout)
        .split(/\r?\n/)
        .map((line) => posix(line.trim()))
        .filter(Boolean);
    }
    throw err;
  }
}

function testsRootFor(profile, linked, override) {
  if (typeof override === "string" && override.trim()) return override.trim();
  const auto = profile && profile.kind === "automation" ? profile : linked;
  if (!auto || !auto.repo) return "";
  const root = auto.repo.moduleRoot || "tests/e2e";
  return path.join(auto.repo.location, root);
}

async function selectForRun(opts = {}) {
  const input = opts.input && typeof opts.input === "object" ? opts.input : {};
  const cfg = opts.config && typeof opts.config === "object" ? opts.config : {};
  let profile = opts.profile || null;
  let linked = opts.linked || null;
  if (!profile) {
    try {
      const profiles = opts.profiles || parseProfiles();
      const key =
        input.profileKey ||
        (input.jira && input.jira.key) ||
        input.issueKey ||
        "";
      profile = resolveProfile(key, profiles);
      if (profile && profile.linkedProfile) linked = profiles[profile.linkedProfile] || null;
    } catch {
      profile = null;
    }
  }

  const mode =
    cfg.mode === "app" || cfg.mode === "automation"
      ? cfg.mode
      : profile && profile.kind === "automation"
        ? "automation"
        : "app";

  const changedFiles = Array.isArray(input.changedFiles)
    ? input.changedFiles
    : Array.isArray(opts.changedFiles)
      ? opts.changedFiles
      : await changedFilesFromGit(opts.worktreePath, opts.fromSha, opts.toSha);

  const testsRoot = testsRootFor(profile, linked, cfg.testsRoot || input.testsRoot);
  const existingModules = Array.isArray(input.existingModules)
    ? input.existingModules
    : Array.isArray(opts.existingModules)
      ? opts.existingModules
      : listModuleFolders(testsRoot);

  const moduleRoot =
    (linked && linked.repo && linked.repo.moduleRoot) ||
    (profile && profile.kind === "automation" && profile.repo && profile.repo.moduleRoot) ||
    "tests/e2e";

  const issue = input.jira || {};
  return selectTests({
    mode,
    changedFiles,
    moduleMap: cfg.moduleMap || input.moduleMap || (profile && profile.moduleMap),
    existingModules,
    moduleRoot,
    summary: issue.summary || input.summary || "",
    tags: issue.tags || input.tags,
  });
}

module.exports = {
  posix,
  toKebab,
  listModuleFolders,
  findExistingModule,
  extractTags,
  selectAppTests,
  selectAutomationTests,
  selectTests,
  appendSelection,
  changedFilesFromGit,
  selectForRun,
  DEFAULT_FALLBACK,
};
