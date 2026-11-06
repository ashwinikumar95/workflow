const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { describe, test } = require("node:test");
const {
  PROJECTS_DIR,
  profileSchema,
  parseProfile,
  parseProfiles,
  validateRegistry,
  loadRegistry,
  resolveProfile,
} = require("../src/services/projectRegistry");

function readProject(key) {
  return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, `${key}.json`), "utf8"));
}

function sampleApp(extra = {}) {
  return {
    jiraKey: "MF",
    kind: "app",
    linkedProfile: "QUT",
    enabled: true,
    eligibleJql: 'project = MF AND assignee = currentUser() AND status in ("To Do")',
    transitions: { claim: "In Progress", review: "READY FOR REVIEW", blocked: "On Hold" },
    repo: {
      location: "D:/tmp/app",
      defaultBranch: "main",
      github: { owner: "Vxceed-IN", repo: "Fuji-Vue3" },
      credentialRef: "GITHUB_TOKEN",
      credentialFiles: [".env"],
      installCommand: ["npm", "ci"],
      appCommand: ["npx", "vite", "--port", "5182", "--strictPort"],
      readiness: "/",
      testCommand: [],
      moduleRoot: "",
      gates: [["npm", "run", "lint"]],
    },
    rules: { forceInclude: [], extraDocs: [] },
    moduleMap: {
      rules: [],
      autoKebabFromViews: true,
      sharedPaths: [],
      sharedFallback: ["-g", "@sanity"],
    },
    agent: { model: "composer-2.5", maxFixAttempts: 2 },
    approvalExpiryHours: 24,
    ...extra,
  };
}

function sampleAutomation(extra = {}) {
  return {
    ...sampleApp(),
    jiraKey: "QUT",
    kind: "automation",
    linkedProfile: "MF",
    eligibleJql: 'project = QUT AND assignee = currentUser() AND status in ("To Do")',
    transitions: { claim: "Script In progress", review: "READY FOR REVIEW", blocked: "On Hold" },
    repo: {
      ...sampleApp().repo,
      location: "D:/tmp/auto",
      github: { owner: "Vxceed-IN", repo: "vxc-ui-automation" },
      credentialFiles: [".env", "playwright/.auth"],
      appCommand: [],
      readiness: "",
      testCommand: ["node", "scripts/playwright-test.js"],
      moduleRoot: "tests/e2e",
      gates: [["npm", "run", "lint"]],
    },
    agent: { model: "composer-2.5", maxFixAttempts: 3 },
    ...extra,
  };
}

describe("jira-pr phase 1 project profiles", () => {
  test("schema accepts all four profiles", () => {
    for (const key of ["MF", "MFC", "QUT", "TAC"]) {
      const checked = profileSchema.safeParse(readProject(key));
      assert.equal(checked.success, true, key);
    }
  });

  test("missing fields and non-reciprocal links are rejected", async () => {
    const missingKey = { ...sampleApp() };
    delete missingKey.jiraKey;
    assert.equal(profileSchema.safeParse(missingKey).success, false);

    const missingLocation = sampleApp();
    delete missingLocation.repo.location;
    assert.equal(profileSchema.safeParse(missingLocation).success, false);

    const profiles = {
      MF: parseProfile(sampleApp()),
      QUT: parseProfile(sampleAutomation({ linkedProfile: "TAC" })),
    };
    await assert.rejects(() => validateRegistry(profiles, { skipGit: true }), /non-reciprocal/i);
  });

  test("an app profile linked to another app profile is rejected", async () => {
    const profiles = {
      MF: parseProfile(sampleApp({ linkedProfile: "MFC" })),
      MFC: parseProfile(sampleApp({ jiraKey: "MFC", linkedProfile: "MF" })),
    };
    await assert.rejects(() => validateRegistry(profiles, { skipGit: true }), /automation/i);
  });

  test("a missing default branch is reported", async () => {
    const profiles = {
      MF: parseProfile(sampleApp()),
      QUT: parseProfile(sampleAutomation()),
    };
    async function runGit(args) {
      if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) {
        return { stdout: "true\n" };
      }
      throw new Error("unknown revision");
    }
    await assert.rejects(
      () => validateRegistry(profiles, { runGit, exists: () => true }),
      /missing default branch/i
    );
  });

  test("key prefix lookup: MF-123 and MFC-123 resolve to different profiles", () => {
    const profiles = parseProfiles();
    assert.equal(resolveProfile("MF-123", profiles).jiraKey, "MF");
    assert.equal(resolveProfile("MFC-123", profiles).jiraKey, "MFC");
    assert.notEqual(resolveProfile("MF-123", profiles), resolveProfile("MFC-123", profiles));
  });

  test("registry loads the four real profiles", async () => {
    const profiles = await loadRegistry();
    assert.deepEqual(Object.keys(profiles).sort(), ["MF", "MFC", "QUT", "TAC"]);
    assert.equal(profiles.MF.enabled, true);
    assert.equal(profiles.MFC.enabled, false);
    assert.equal(profiles.MF.linkedProfile, "QUT");
    assert.equal(profiles.QUT.linkedProfile, "MF");
    assert.equal(profiles.MFC.linkedProfile, "TAC");
    assert.equal(profiles.TAC.linkedProfile, "MFC");
    assert.equal(profiles.MF.kind, "app");
    assert.equal(profiles.QUT.kind, "automation");
    assert.equal(profiles.TAC.repo.defaultBranch, "central-ui-automation-main");
  });
});
