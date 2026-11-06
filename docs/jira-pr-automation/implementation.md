# Jira-to-PR automation: phase-wise implementation

This file is the build order for the Jira-to-PR automation covering MF, MFC, QUT and TAC. Each phase ends with something you can run and test before the next one starts. Don't start a phase until the previous phase's exit criteria pass.

The design itself is in the plan (`jira-to-pr_automation_1f7cc9ad.plan.md`). This file says what to build, in which order, and how to prove each part works.

## Ground rules for every phase

- Existing workflows, nodes and the Docker code paths keep working. The new behaviour applies only to workflows generated from the project profiles, and only when `runtime: "host"` is selected.
- `npm test` (the existing `test/phase*.test.js` suites) must pass at the end of every phase.
- No Cursor agent runs against Fuji-Vue3, Mt-Fuji-Central, vxc-ui-automation or central-ui-automation before Phase 9. Until then, agent runs use a scratch repository.
- Main checkouts under `D:\Projects` are never reset, cleaned or switched by the automation.
- Nothing is merged automatically.

## Project mapping

| Jira key | Kind | Repo the agent changes | Linked repo | Default branch (from `origin/HEAD`) |
| --- | --- | --- | --- | --- |
| MF | app | `D:/Projects/MT_FUJI/FE/Fuji-Vue3` (`Vxceed-IN/Fuji-Vue3`) | vxc-ui-automation | `main` |
| MFC | app | `D:/Projects/MT-Fuji_Central_Master/FE/Mt-Fuji-Central` (`Vxceed-IN/Mt-Fuji-Central`) | central-ui-automation | `main` |
| QUT | automation | `D:/Projects/vxc-ui-automation` (`Vxceed-IN/vxc-ui-automation`) | Fuji-Vue3 | `main` |
| TAC | automation | `D:/Projects/central-ui-automation` (`Vxceed-IN/central-ui-automation`) | Mt-Fuji-Central | `central-ui-automation-main` |

## What the current code does that the phases must account for

These were found by reading the engine. Each one is fixed in the phase listed.

| Finding | Where | Why it matters | Fixed in |
| --- | --- | --- | --- |
| A node that throws marks the run `failed` and then deletes its worktree | `walkClaimed` calls `cleanupWorktree` in [src/services/executionengine.js](../../src/services/executionengine.js) | Evidence of a failed run would be lost | Phase 2 |
| `cursorAgent` and `playwright` nodes delete the worktree on a `false` branch | `removeQuiet` in [src/nodes/lifecycle.js](../../src/nodes/lifecycle.js) | A failed test would delete the worktree before a fix attempt could use it | Phase 2 |
| The worker timer deletes any worktree folder whose run isn't `running` or `waiting`, every 5 seconds | `reconcileWorktrees` in [src/services/gitService.js](../../src/services/gitService.js) | Failed, blocked or interrupted runs would lose their worktree | Phase 2 |
| `createWorktree` deletes an existing folder at the target path if it isn't the expected registered worktree | [src/services/gitService.js](../../src/services/gitService.js) | Recovery must never call it on a path that holds partial work | Phase 2 |
| The agent writes its receipt to `.workflow/agent-execution.json` inside the worktree, and none of the four target repos ignore `.workflow/` | [scripts/agent-sandbox-lib.mjs](../../scripts/agent-sandbox-lib.mjs), [src/services/agentAttempt.js](../../src/services/agentAttempt.js) | The tree is never clean after an agent run, so every agent step would be judged a failure | Phase 2 |
| The agent entry hard-codes `cwd: "/worktree"`, the Docker mount path | [scripts/agent-sandbox-entry.mjs](../../scripts/agent-sandbox-entry.mjs) | Can't run on the host | Phase 3 |
| `settingSources: []` ignores each repo's `.cursor/rules` | [scripts/agent-sandbox-lib.mjs](../../scripts/agent-sandbox-lib.mjs) | Repo rules would not load | Phase 7 |
| The Playwright worker never passes `runSuite`, `install` or `browsers`, so every suite settles as failed with a missing report. It also requires a pinned Docker image | [src/workers/playwrightWorker.js](../../src/workers/playwrightWorker.js), [src/services/playwrightAttempt.js](../../src/services/playwrightAttempt.js) | Tests don't actually run today | Phase 3 |
| Docker isn't installed on this machine | `docker` not found | The host runtime is required, not optional | Phase 3 |
| `external` on a run is one flat object (`worktreePath`, `branch`, `repoPath`, `testedSha`, `playwrightByNode`) | [src/nodes/lifecycle.js](../../src/nodes/lifecycle.js), [src/services/pullRequestGate.js](../../src/services/pullRequestGate.js) | App tickets that also change scripts need two repos in one run | Phase 2 |
| `githubPrNode` uses the global `config.githubOwner` and `config.githubRepo`, an empty body, and the workflow-level base branch | [src/nodes/lifecycle.js](../../src/nodes/lifecycle.js) | PRs must go to the right repo of the four, with a full description | Phase 2 and Phase 9 |
| `executeWithRetry` runs every node up to 3 times when it throws | [src/services/executionengine.js](../../src/services/executionengine.js) | Jira comments, PR creation and agent launches must not repeat | Phase 2 |
| The engine only treats `approval`, `cursorAgent` and `playwright` nodes as waits | `isWaitControl` in [src/services/executionengine.js](../../src/services/executionengine.js) | Plan and rules-review agents reuse `cursorAgent` with a `mode` instead of new node types | Phase 7 |
| A waiting run drops its engine lease (`executionClaim: null`), and `beginResume` takes a new one | [src/services/executionengine.js](../../src/services/executionengine.js) | Resource locks must be separate from the engine lease | Phase 4 |
| Re-running the same `jobId` continues a failed run from `currentNodeId` | `loadOrCreateRun` and `positionFromRun` in [src/services/executionengine.js](../../src/services/executionengine.js) | Retry can reuse this. No new run ledger is needed | Phase 4 |
| `Run.status` is `running`, `success`, `failed` or `waiting` | [src/models/Run.js](../../src/models/Run.js) | `interrupted` and `cancelled` must be added, and shown in the UI | Phase 2 |
| Approval is `POST /runs/:runId/decision` with no plan hash. The UI already has approve and reject buttons | [src/services/approvalService.js](../../src/services/approvalService.js), [frontend/src/pages/WorkflowRunDetail.jsx](../../frontend/src/pages/WorkflowRunDetail.jsx) | Approval must be bound to the plan that was shown | Phase 7 |
| Slack is posted only when a node throws. A worker `failed` event only logs | [src/services/executionengine.js](../../src/services/executionengine.js), [src/workers/worker.js](../../src/workers/worker.js) | Waits, deliberate stops and crashes must all reach Slack | Phase 6 |
| `redactSecrets.js` removes secret-named keys from API responses, and `redactOutput` only replaces the values of the forbidden environment variables | [src/utils/redactSecrets.js](../../src/utils/redactSecrets.js), [src/services/forbiddenEnv.js](../../src/services/forbiddenEnv.js) | Text artifacts need pattern-based and `.env`-value redaction | Phase 8 |
| Both automation repos already write `test-results/report.json`, and `scripts/playwright-test.js` passes path filters and `-g` straight to Playwright | `playwright.config.ts` in both repos | Test selection can use the wrapper as it is | Phase 8 |
| `branchForRun` already produces `wf/<KEY>/<runId>`, checked with `git check-ref-format` | [src/services/gitService.js](../../src/services/gitService.js) | Keep this branch format | none |
| `openPullRequest` already returns the open PR for a branch instead of opening a second one | [src/services/githubPrService.js](../../src/services/githubPrService.js) | PR creation is already safe to repeat | none |

## Phase overview

| Phase | What you get at the end | Touches target repos? |
| --- | --- | --- |
| 0 | Everything installed and the manual loop proven | You run commands by hand |
| 1 | Validated project profiles for MF, MFC, QUT and TAC | Read only |
| 2 | Engine changes that keep evidence and support two repos per run | No |
| 3 | Agent, Vite and Playwright run on the host | Playwright runs, read only |
| 4 | Ticket and resource locks, run states, recovery, cancel and retry | No |
| 5 | Jira search, eligibility, claim and comments, with dry run | Jira only |
| 6 | Slack events with no duplicates | No |
| 7 | Rules manifest, plan mode, approval with plan hash, rules checks | Read only |
| 8 | Test selection, reports, artifacts, failure classification, baseline | Playwright runs, read only |
| 9 | Templates, generator, PRs, and the first real MF ticket | Yes, MF pilot |
| 10 | Automation tickets and linked PRs, QUT then TAC pilots | Yes |
| 11 | MFC rules and pilot, then hardening | Yes |

---

## Phase 0: Prerequisites and spike

**Goal:** prove that the pieces work on this machine before writing pipeline code.

**Your part:**
1. Put these in the workflow server's `.env`: Jira base URL, email and API token, a GitHub token with contents and pull-request write access to the four `Vxceed-IN` repos, `CURSOR_API_KEY`, and `SLACK_WEBHOOK_URL`.
2. Start MongoDB and Redis.
3. Run `npm ci` in each of the four repos and check it succeeds.
4. Prove the manual loop for each app pair:
   - Fuji-Vue3: `npx vite --port 5182 --strictPort` with your `.env`, then log in through the browser.
   - vxc-ui-automation: set `BASE_URL=http://localhost:5182`, run `node scripts/playwright-test.js tests/e2e/stock-transfer`, and check that it passes and writes `test-results/report.json`.
   - Mt-Fuji-Central: `npx vite --port 5181 --strictPort`, then log in through the browser.
   - central-ui-automation: set `BASE_URL=http://localhost:5181`, run its suite the same way, and check that it passes and writes `test-results/report.json`.
5. Write down the exact status names for each project: start, in progress, in review and blocked. An `ai-ready` label is optional and is not required.
6. Pick one small, well-described pilot ticket per project.

**My part:**
- Install `@cursor/sdk` in the workflow repo. It's listed in `package.json` but missing from `node_modules`.
- Spike: run `runSandbox` from [scripts/agent-sandbox-lib.mjs](../../scripts/agent-sandbox-lib.mjs) on the host, against a scratch git repo created for the test, with `settingSources: ["project"]` and a test `.cursor/rules` file.
- Spike: read Jira statuses, transitions and the acceptance-criteria field id with your token. This is read only.

**Exit criteria:**
- The Cursor SDK edits and commits in the scratch repo on Windows, and the test rule is visible in its behaviour.
- The manual Vite and Playwright loop passes for both app pairs.
- The Jira statuses, transitions and field id are written into this file under "Decisions".

---

## Phase 1: Project profiles and registry

**Goal:** one validated configuration for each Jira project.

**New files:**
- `config/projects/MF.json`, `MFC.json`, `QUT.json`, `TAC.json`
- [src/services/projectRegistry.js](../../src/services/projectRegistry.js), with a zod schema in the style of `analysisSchema` in [src/services/analysisService.js](../../src/services/analysisService.js)

**Profile contents:**
- `jiraKey`, `kind` (`app` or `automation`), `linkedProfile`, `enabled`, `eligibleJql`
  - `eligibleJql` is the bucket query. Default is `assignee = currentUser()` plus that project's start statuses. A label such as `ai-ready` is optional and is left out unless you add it to the query.
- `transitions`, using the status names from Phase 0
- `repo`: `location`, `defaultBranch`, `github.owner` and `github.repo`, `credentialRef`, `credentialFiles`, `installCommand`, `appCommand`, `readiness`, `testCommand`, `moduleRoot` and `gates`
- `rules`: `forceInclude` and `extraDocs`
- `moduleMap`
- `agent`: `model` and `maxFixAttempts`
- `approvalExpiryHours`

MFC starts with `enabled: false`.

**Startup checks:**
- Every linked profile exists and links back.
- App profiles link to automation profiles, and the reverse.
- Each location is a git checkout.
- `origin/<defaultBranch>` exists.

**Tests** (`test/jira-pr-phase1.test.js`):
- the schema accepts all four profiles
- missing fields and non-reciprocal links are rejected
- an app profile linked to another app profile is rejected
- a missing default branch is reported
- key prefix lookup: `MF-123` and `MFC-123` resolve to different profiles

**Exit criteria:** the tests pass, and the registry loads the four real profiles on your machine.

---

## Phase 2: Engine changes the pipeline depends on

**Goal:** fix the behaviours in the findings table without changing how existing workflows behave.

**Changes:**
- **Keep evidence.** Add `workflow.retention.keepWorktreeOnFailure`, which defaults to `false` so existing workflows are unchanged.
  - When it's `true`, `cleanupWorktree` in [src/services/executionengine.js](../../src/services/executionengine.js) and `removeQuiet` in [src/nodes/lifecycle.js](../../src/nodes/lifecycle.js) don't delete the worktree.
  - `reconcileWorktrees` in [src/services/gitService.js](../../src/services/gitService.js) skips worktrees whose run belongs to such a workflow, unless that run is `success` and older than the retention period.
- **Recovery safety.** Add `gitService.openExistingWorktree`, which never deletes. Recovery uses it instead of `createWorktree`.
- **Receipt outside the worktree.** `runSandbox` already accepts `writeReceipt`. Pass it a path under `<worktreesDir>/<runId>/receipts/`, and read it from there in `defaultInspect` in [src/services/agentAttempt.js](../../src/services/agentAttempt.js).
- **Several repos in one run.**
  - `external.repos.<role>`, where `role` is `app` or `automation`, holds `worktreePath`, `branch`, `repoPath`, `preAgentSha`, `testedSha` and `prUrl`.
  - Old flat fields are still read when `repos` is absent.
  - `assertPullRequestGate` in [src/services/pullRequestGate.js](../../src/services/pullRequestGate.js) reads the role's entry.
- **Per-node repository.** `gitBranch`, `cursorAgent`, `playwright` and `githubPr` accept `config.repository` with `location`, `defaultBranch`, `credentialRef`, `owner` and `repo`.
  - `resolveRepoPath`, `resolveBaseBranch` and `tokenFromWorkflow` use it first, then fall back to `workflow.repository`.
  - `githubPrNode` uses it instead of `config.githubOwner` and `config.githubRepo`.
- **No repeats for non-idempotent nodes.** A node config can set `retries: 1`. `executeWithRetry` uses it, and the default stays 3.
- **New statuses.** `Run.status` gains `interrupted` and `cancelled` in [src/models/Run.js](../../src/models/Run.js), and [frontend/src/pages/WorkflowRunDetail.jsx](../../frontend/src/pages/WorkflowRunDetail.jsx) shows them.

**Tests** (`test/jira-pr-phase2.test.js`, using temp git repos):
- With the flag off, existing behaviour is unchanged. The existing tests cover this.
- With it on, a failed node keeps the worktree, and the reconcile timer leaves it alone.
- A worktree with a receipt is still clean.
- Two repos in one run keep separate SHAs.
- `githubPr` uses the node-level owner and repo.
- A node with `retries: 1` runs once.

**Exit criteria:** the new tests and the existing `npm test` pass.

---

## Phase 3: Host runtime (agent, Vite, Playwright)

**Goal:** run the agent and the tests as local processes on Windows.

**New files:**
- `src/services/hostProcess.js`:
  - `spawn` with `shell: false`
  - full paths for `node`, `npm.cmd` and `npx.cmd`
  - an environment built from an allowlist, checked with `assertEnvAllowed`
  - a timeout, and `taskkill /PID <pid> /T /F` on timeout or cancel
  - a PID registry on the run (`pid`, `startedAt`, `role`)
  - stdout and stderr streamed to a log file
- `src/services/hostRunners.js`: `startAgentHost`, `installHost`, `runSuiteHost` and `startViteHost`.

**Changes:**
- [scripts/agent-sandbox-entry.mjs](../../scripts/agent-sandbox-entry.mjs): `cwd` comes from `WORKFLOW_CWD` instead of `/worktree`, and the prompt comes from a file path.
- [src/workers/agentWorker.mjs](../../src/workers/agentWorker.mjs): when `runtime` is `host`, call `startAgentHost` instead of `startContainer`. The settle path stays the same (`settle-wait` and `prepareExternalSettle`).
- [src/workers/playwrightWorker.js](../../src/workers/playwrightWorker.js):
  - When `runtime` is `host`, skip the pinned-image check.
  - Pass `install`, `browsers` and `runSuite` from `hostRunners` into `handlePlaywrightJob`, which already accepts them.
- [src/services/forbiddenEnv.js](../../src/services/forbiddenEnv.js): add `JIRA_EMAIL`, `JIRA_WEBHOOK_SECRET` and every profile `credentialRef` name.
- **Credentials in the test worktree.** Copy only the profile's `credentialFiles` from the main checkout into the worktree used for tests, and add them to that worktree's `info/exclude`. If `playwright/.auth` is missing, stop with an `env` reason.
- **Vite.** Each app has a fixed port: Fuji-Vue3 `5182`, Mt-Fuji-Central `5181`. Reserve that port through the lock in Phase 4 (a simple in-process reservation until then). A second run for the same app waits. Start with `--port <n> --strictPort`, poll `readiness`, retry up to 3 times, and set `BASE_URL`. Kill the process tree at the end of the stage.

**Tests** (`test/jira-pr-phase3.test.js`):
- The child environment never contains forbidden names.
- A timed-out fake process tree is fully killed.
- A second run for the same app waits for that app's port. Fuji stays on 5182 and Central stays on 5181.
- A missing `.auth` stops with `env`.
- The agent settle path works with a fake agent script that commits in a temp repo.

**Manual check:** run the Playwright node by hand against Fuji-Vue3 and vxc-ui-automation, with one module and no agent. It must pass and settle `branch: "true"`.

**Exit criteria:** the tests pass, and the manual check passes for both app pairs.

---

## Phase 4: Locks, run states, recovery, cancel and retry

**Goal:** never two runs on the same ticket or the same app plus automation pair, and nothing lost when a process dies.

**New files:**
- `src/models/TicketRun.js`, with a partial unique index on `jiraKey` while the state isn't terminal.
- `src/models/ResourceLock.js`, where `_id` is the resource name (`env:dms`, `env:central`, `port:<n>`, `dispatcher`), plus `owner`, `token` and `expiresAt`.
- `src/services/resourceLocks.js`: all-or-nothing acquisition in sorted order with rollback, a heartbeat from the existing worker timer, and release by owner and token.
- `src/services/ticketState.js`: `transition(from, to)` as a compare-and-set, using the allowed transitions from the plan.
- `src/services/recovery.js`: implements the per-stage recovery table from the plan.

**Changes:**
- [src/services/executionengine.js](../../src/services/executionengine.js): before each node of a profile workflow, update the `TicketRun` stage. If it was cancelled meanwhile, stop the walk.
- New routes `POST /runs/:runId/cancel` and `POST /runs/:runId/retry`, with buttons in [frontend/src/pages/WorkflowRunDetail.jsx](../../frontend/src/pages/WorkflowRunDetail.jsx).
- Retry re-enqueues the same `jobId` after setting `currentNodeId`, which the engine already supports.

**Tests** (`test/jira-pr-phase4.test.js`):
- An MF and a QUT run at the same time: one gets `env:dms`, the other waits as `queued`.
- MF and MFC at the same time both run.
- A failure on the second lock rolls back the first.
- An expired lock is released only by recovery.
- Every listed transition is allowed, and an invalid one is refused.
- Killed during implementation becomes `interrupted` with the worktree kept, and Cursor is not run again.
- Killed during Playwright reruns the same SHA.
- Cancel kills processes and releases locks.

**Exit criteria:** the tests pass. Killing the worker by hand during a fake agent run leaves the run `interrupted` with its worktree intact.

---

## Phase 5: Jira intake

**Goal:** pick the right tickets from your bucket, or run the one ticket whose link you paste, and update Jira safely.

**Changes:**
- [src/services/jiraService.js](../../src/services/jiraService.js):
  - `searchIssues(jql)` using `/rest/api/3/search/jql`, with `nextPageToken` paging and a `Retry-After` backoff on 429
  - `getTransitions`, `transitionIssue(key, statusName)` and `addComment(key, text, marker)`
  - richer `fetchIssue` fields: labels, components, issue type, acceptance criteria, updated time and summary tags such as `[@TAC-3-2]`
  - a content fingerprint (hash of the summary, description and acceptance criteria)
- New `src/services/jiraDispatcher.js`:
  - holds the `dispatcher` lock
  - runs recovery first, then each enabled profile's JQL
  - bucket eligibility is whatever `eligibleJql` says (assignee and start status by default). A description is still required, and an automation ticket still needs a module or TC reference. The `ai-ready` label is not required.
  - creates the `TicketRun` and enqueues the profile's workflow
  - has a `--dry-run` mode
- **Run one ticket.** A second start, separate from the bucket poll. You paste a Jira browse link (`https://<site>.atlassian.net/browse/MF-123`) or a bare key (`MF-123`).
  - The key is taken from the link. The project prefix picks the profile (`MF-123` and `MFC-123` stay different).
  - Bucket filters are not applied: assignee, status, and labels are ignored because you named the ticket.
  - The same workflow, locks, and "one live run per ticket" rules still apply. A key outside MF, MFC, QUT, and TAC is refused.
  - `POST /jira/run` accepts `{ "issue": "<url or key>" }` and returns the run id. The published workflow page has the same field next to Run now.
- New `jiraUpdate` node in [src/nodes/lifecycle.js](../../src/nodes/lifecycle.js) and [src/nodes/index.js](../../src/nodes/index.js), with a canvas component in `frontend/src/components/nodes/`. It handles transitions and comments, carries a run and stage marker so a repeated step doesn't post twice, and uses `retries: 1`.
- A cron entry through [src/services/schedulerService.js](../../src/services/schedulerService.js).

**Tests** (`test/jira-pr-phase5.test.js`, with a mocked HTTP client):
- routing by prefix
- paging through several pages
- 429 backoff
- ineligible tickets are reported and keep their status
- a duplicate poll creates nothing
- a changed fingerprint after completion creates a new run
- a transition that isn't offered becomes a comment, not a failure
- a browse URL and a bare key for the same issue start one run
- a pasted ticket runs even when it is not assigned to you and has no `ai-ready` label
- `MFC-1` is not treated as `MF-1`
- a key outside the four projects is refused

**Manual check:** a dry run against your real bucket lists the expected tickets for all four prefixes and changes nothing in Jira.

**Exit criteria:** the tests and the dry run pass.

---

## Phase 6: Slack events

**Goal:** every wait, stop, crash and finished PR posts exactly once.

**Changes:**
- New `src/services/slackService.js` with `emit(runId, type, details)`. It stores the event on the run as `notifications[eventId]` before sending, and the worker timer retries failed sends.
- Event types: `waiting_for_approval`, `plan_rejected`, `gate_failed`, `rules_violation`, `playwright_failed`, `env_failed`, `app_bug_blocked`, `interrupted`, `cancelled`, `crashed`, `skipped_ineligible`, `pr_created`.
- `maybeNotifyRunFailure` in [src/services/executionengine.js](../../src/services/executionengine.js) and the `notify` node in [src/nodes/index.js](../../src/nodes/index.js) call `emit`.
- The engine emits `waiting_for_approval` when a run enters an approval wait.
- [src/workers/worker.js](../../src/workers/worker.js) emits `crashed` on a BullMQ `failed` event. The event id is the same as the engine's, so a crash posts once.
- Messages carry the project, Jira key, stage, reason and run URL, and are redacted.

**Tests** (`test/jira-pr-phase6.test.js`): one message per event even when two components emit it; a failed send is retried; no webhook means the event is logged and the run continues; secrets are redacted.

**Exit criteria:** the tests pass, and a manual approval wait plus a forced crash each produce one message in your channel.

---

## Phase 7: Rules, plan mode and approval

**Goal:** Cursor follows each repo's rules, plans before it implements, and you approve the exact plan.

**Changes:**
- [scripts/agent-sandbox-lib.mjs](../../scripts/agent-sandbox-lib.mjs): `settingSources: ["project"]`.
- New `src/services/rulesService.js`:
  - reads `.cursor/rules/*.mdc` and `*.md` plus `AGENTS.md`
  - selects rules that are `alwaysApply`, match the planned or changed files' globs, or are force-included; `test-automation-rule.mdc` is forced for QUT and TAC
  - builds a manifest of file, reason, matched files, sha256, and inline or referenced
  - inlines the always-on and forced rules within the size budget, and lists the rest by path
- [src/services/cursorPromptService.js](../../src/services/cursorPromptService.js):
  - `buildPlanPrompt`, `buildImplementPrompt(issue, plan, manifest, feedback)` and `buildReviewPrompt`
  - a separate rules section outside the untrusted ticket block
- `cursorAgent` node gains `config.mode`: `plan`, `implement`, `fix` or `review`.
  - `plan` and `review` must leave the tree clean and HEAD unchanged.
  - `plan` writes `plan.json` outside the worktree.
  - All modes produce zod-validated JSON (`plan.json`, `result.json` or the review result).
  - Using one node type avoids changing `isWaitControl`.
- [src/services/approvalService.js](../../src/services/approvalService.js) and the decision route accept `planHash`.
  - The decision stores the plan hash, the Jira fingerprint and an expiry.
  - Before implementation, the plan hash and the fingerprint are checked again. On a mismatch or an expired approval, the run re-plans.
- [frontend/src/pages/WorkflowRunDetail.jsx](../../frontend/src/pages/WorkflowRunDetail.jsx) shows the plan and the rules applied, and sends `planHash` with the decision.
- New `src/services/rulesChecks.js` and `config/rules-checks/<repo>.json`. These are mechanical checks on added diff lines, each linked to its source rule, with a severity. I draft them while reading each rule file, and you review them before they're enabled.
- The AI rules review returns `confirmed`, `potential` and `uncertainties`, and the blocking table from the plan is applied.

**Tests** (`test/jira-pr-phase7.test.js`):
- manifest selection for Fuji-Vue3 and the automation repos (copies of the rule files as fixtures)
- the size budget
- a plan-mode run that edits a file fails
- a stale `planHash` is refused
- an expired approval re-plans
- a changed fingerprint re-plans
- each mechanical check fires on its positive fixture and not on its negative one
- an uncertainty makes the run wait for you

**Exit criteria:** the tests pass, and a plan run against a scratch copy of the Fuji-Vue3 rules lists the expected `rulesApplied`.

---

## Phase 8: Test selection, reports and failure handling

**Goal:** run the right Playwright tests and know exactly why they failed.

**Changes:**
- New `testSelect` node:
  - **App tickets:** diff to module folders. Explicit `moduleMap` rules first, then kebab-case of `src/views/*.vue`, keeping only existing `tests/e2e` folders. Shared paths or unmapped files fall back to `@sanity`.
  - It outputs `selectedModules`, `selectedPaths`, `unmappedFiles`, `fallback` and `reason`.
  - **Automation tickets:** the changed `*.spec.ts` files plus the TC tags from the summary.
- `playwrightNode` in [src/nodes/lifecycle.js](../../src/nodes/lifecycle.js) appends the selection to `testCommand` (`node scripts/playwright-test.js`).
- New `src/services/playwrightReport.js` parses `test-results/report.json` into `passed`, `failed`, `flaky` and `failures`.
- New `src/services/artifactRedactor.js`:
  - Text artifacts are redacted, using patterns plus the values from the copied `.env`, into `<artifactsDir>/<runId>/public`.
  - Traces and screenshots go to `private`, which is never published.
  - Retention runs on the worker timer.
- **Baseline only on failure.** Rerun only the failed tests on the default branch with the same environment, and record the configuration of both runs. A baseline failure doesn't clear the ticket's own scenario.
- **Failure classification** is zod-validated: `app-bug`, `script-bug`, `test-outdated`, `env`, `data-issue` or `unknown`, routed as in the plan.

**Tests** (`test/jira-pr-phase8.test.js`):
- module mapping, including folders with spaces such as `Load Out`
- the shared-path fallback
- unmapped files are listed
- tag extraction
- report parsing with real `report.json` samples from both repos
- redaction
- the baseline comparison table
- each classification's routing

**Manual check:** for a hand-made change to one Fuji-Vue3 view, `testSelect` picks the right folder, and the run passes.

**Exit criteria:** the tests and the manual check pass.

---

## Phase 9: Templates, PRs and the MF pilot

**Goal:** the first complete ticket-to-PR run, on MF.

**Changes:**
- New `config/workflow-templates/app-ticket.json`. Every stop path ends in `notify`, then `jiraUpdate` where one applies. Fix attempts are unrolled `maxFixAttempts` times, because the graph can't have cycles.
- New `scripts/create-project-workflow.js <KEY>` creates or updates the published workflow from the profile, with `runtime: "host"` and `keepWorktreeOnFailure: true`.
- **Commit and push guard**, before tests and before push. It checks `git status --porcelain --untracked-files=all --ignored` and the diff from `baseSha`. Any `.env*` other than `.env.example`, anything under `playwright/.auth/`, keys, or added lines containing `.env` values cause a hard stop.
- `githubPrNode`:
  - The body has the Jira link, plan, rules applied, deviations, gate results, the tests run and their counts, and the linked PR.
  - The PR URL is saved before Jira is updated.
  - It uses `retries: 1`. A retry finds the existing PR through `openPullRequest`.

**Tests:** the template unrolls correctly; every terminal path has a notify node; the guard catches each forbidden file; a retried PR step finds the existing PR.

**Pilot:** one MF ticket labelled `ai-ready`, with plan approval on. You review the PR by hand.

**Exit criteria:** the PR is in `Vxceed-IN/Fuji-Vue3` against `main`, on a `wf/MF-.../...` branch, with complete evidence. Jira is in review, Slack posted the wait and the PR, and nothing was merged.

---

## Phase 10: Automation tickets and linked PRs

**Goal:** QUT and TAC tickets, and MF tickets that also need script changes.

**Changes:**
- New `config/workflow-templates/automation-ticket.json`:
  - The agent changes the automation repo.
  - The app comes from a clean worktree at its default branch.
  - An `app-bug` result comments on Jira, blocks and posts to Slack.
- In `app-ticket.json`, the `test-outdated` and `script-bug` routes add a second worktree, agent run, gates, tests and PR in the linked automation repo. The two PRs link to each other.

**Tests:** both templates generate for all four profiles; the linked PR flow keeps separate SHAs and gates per repo; an app bug never leads to a script change.

**Pilots:** one QUT ticket, then one TAC ticket, then one MF ticket that needs a script update.

**Exit criteria:** each pilot produces correct PRs, and you've reviewed them by hand.

---

## Phase 11: MFC and hardening

**Goal:** enable MFC, and finish the operational details.

**Steps:**
- Draft `.cursor/rules` for Mt-Fuji-Central from its own code, using the Fuji-Vue3 rules only where they fit. These go to its repo through a normal PR that you review. Then set `enabled: true` in `MFC.json`.
- Pilot one MFC ticket.
- Hardening:
  - artifact and worktree retention jobs
  - Jira rate-limit behaviour under a large bucket
  - cleanup of leftover processes after a crashed worker
  - a short section in the root [implementation.md](../../implementation.md) pointing to this file

**Exit criteria:** the MFC pilot passes, and all phase test suites plus the existing `npm test` pass.

---

## Decisions to fill in

Write each one down as it's settled, mostly in Phase 0.

- Jira status names per project (start, in progress, in review, blocked):

  There is no status named `In Review` on any of the four projects. Review is `READY FOR REVIEW`. `On Hold` exists on all four and is the blocked target.

  | Project | Start (eligible) | In progress (claim target) | In review | Blocked |
  | --- | --- | --- | --- | --- |
  | MF | `To Do`, `Open`, `Reopened`, `Ready for Assign` | `In Progress` (transition from Ready for Assign is `dev in progress`) | `READY FOR REVIEW` | `On Hold` |
  | MFC | `To Do`, `Open`, `Reopened`, `Ready for Assign` | `In Progress` (transition from To Do is `ready for dev`) | `READY FOR REVIEW` | `On Hold` |
  | QUT | `To Do`, `Script Prep`, `Reopened`, `Ready for Assign` | `Script In progress` | `READY FOR REVIEW` | `On Hold` |
  | TAC | `To Do`, `Script Prep`, `Reopened`, `Ready for Assign` | `Script In progress` | `READY FOR REVIEW` | `On Hold` |

  Other blocked-like names that exist but are not the pipeline target: MF/MFC `Testing Blocked`, `SIT BLOCKED`; QUT/TAC `QA Blocked`, `PT Blocked`.

- Acceptance-criteria field id:

  None. `/rest/api/3/field` has no field whose name matches acceptance criteria (318 fields checked). A populated MF issue also has no such field on the screen. Criteria live in `description`. Closest optional text fields, unused by the fingerprint unless we add them later: `customfield_11860` (`Test Scenarios`), `customfield_11827` (`Unit Testing Scenarios`).

- Confirm the PR target branches (`main`, `main`, `main`, `central-ui-automation-main`):

  Confirmed from `origin/HEAD` in the four checkouts: Fuji-Vue3 `main`, Mt-Fuji-Central `main`, vxc-ui-automation `main`, central-ui-automation `central-ui-automation-main`.

- Approval expiry in hours (suggested 24): 24
- `maxFixAttempts`: app (suggested 2), automation (suggested 3): app 2, automation 3
- Vite ports: Fuji-Vue3 (MF and QUT) `http://localhost:5182`. Mt-Fuji-Central (MFC and TAC) `http://localhost:5181`. One port per app. A second run for the same app waits.
- Artifact retention in days: public (suggested 30), private (suggested 7): public 30, private 7
- How a run starts:

  Two ways. The bucket poll uses `eligibleJql`: assigned to you, in that project's start statuses. The `ai-ready` label is not required. The other way is a pasted Jira link or key, which runs that ticket only and skips the bucket filters. A key that is not MF, MFC, QUT, or TAC is refused.

- Pilot tickets: MF, QUT, TAC, MFC:

  Not picked yet. Any ticket in the four projects can be used. Paste its link when the pilot starts. No label is required.

### Phase 0 notes

- Host worktrees live outside the repo at `D:\Projects\workflow-worktrees`. Playwright worktrees (Phase 3) can use `D:\Projects\workflow-playwright-worktrees`. Add these to the workflow `.env` (do not commit the file):

  ```
  WORKTREES_DIR=D:\Projects\workflow-worktrees
  PLAYWRIGHT_WORKTREES_DIR=D:\Projects\workflow-playwright-worktrees
  ```

- `GITHUB_TOKEN` is set in the workflow `.env` (contents and pull-request write access to the four `Vxceed-IN` repos). Used from Phase 9 for PR creation.
- Sandbox spike passed on the host: `runSandbox` against a scratch git repo under `WORKTREES_DIR`, with `settingSources: ["project"]`. The agent loaded the test rule (wrote `PHASE0-RULE-APPLIED` and committed it). The scratch repo was removed after the spike.
- Jira spike was read only. Statuses, transitions, and the missing acceptance-criteria field are recorded above.

## Progress checklist

- [x] Phase 0: prerequisites and spike
- [x] Phase 1: project profiles and registry
- [x] Phase 2: engine changes
- [x] Phase 3: host runtime
- [x] Phase 4: locks, states, recovery, cancel and retry
- [ ] Phase 5: Jira intake
- [ ] Phase 6: Slack events
- [ ] Phase 7: rules, plan mode, approval
- [ ] Phase 8: test selection, reports, failure handling
- [ ] Phase 9: templates, PRs, MF pilot
- [ ] Phase 10: automation tickets, linked PRs, QUT and TAC pilots
- [ ] Phase 11: MFC and hardening

A phase is ticked only when its exit criteria pass. Generated code alone doesn't count.
