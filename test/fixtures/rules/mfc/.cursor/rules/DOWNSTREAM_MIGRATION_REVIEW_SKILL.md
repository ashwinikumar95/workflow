# SKILL — REVIEW the Mt-Fuji-Central gateway migration

> **VERIFY-AND-FIX companion** to `DOWNSTREAM_MIGRATION_FRONTEND_SKILL.md` (this SPA) and
> `DOWNSTREAM_MIGRATION_BACKEND_SKILL.md` (Central API repo — out of this tree). Those skills
> *implement*; this one *audits*. Prove every required file was created/edited, sits in the
> **correct Central folder**, is wired, and that redirect-loop **hygiene** is present.
>
> **Do NOT edit the implementation skill to make a review pass.** If a file is in the wrong
> place or skipped, fix the **app** (move/create/wire), and record it. Only touch the skill
> for a genuine doc bug (wrong Central path).
>
> Keep this file identical to `docs/migration/DOWNSTREAM_MIGRATION_REVIEW_SKILL.md`.

---

## 0. How to run

```
Step 1  DETECT    → confirm this is Mt-Fuji-Central (Vue 3 / JS / Vite / unprefixed env)
Step 2  PRESENCE  → every §0.1 manifest file exists (or a justified N/A)
Step 3  PLACEMENT → each file is in THIS app's folder (the #1 miss)
Step 4  WIRING    → files are referenced/registered, not just present
Step 5  SECURITY  → boundary audit (5a–5g) + loop-guard hygiene (§A)
Step 6  REPORT    → write docs/migration/REVIEW_RESULT.md: PASS / FAIL / FIXED
```

**Golden rule:** a file that exists but is in the wrong folder, or exists but is not wired,
is a **FAIL**. Presence is necessary, not sufficient.

**Scope boundary:** the migration starts at login and **ends** when a verified session is
handed over and Central bootstrap (`loginserviceapi/bootstrap`) has been attempted.
Do **not** redesign menus, `pagePermissions`, hierarchy, or business grids during review.

---

## STEP 1 — DETECT the stack (must match Central)

Do not assume React/TS or `VITE_*`. Read `package.json`, `vite-app-config.mjs`, `.cursor/rules/central-project-rules.mdc`.

| Signal | Expected in this repo | Fail if… |
|---|---|---|
| `package.json` `name` | `mt-fuji-central3-0` | This skill was pointed at DMS / another app |
| `dependencies.vue` + Vite | Vue 3 + Vite | Vue CLI (`VUE_APP_`) or CRA |
| Language | `.js` / `.vue` — **no** `tsconfig` as the app default | Skill applied TypeScript-only artifacts (`vite-env.d.ts`) as required |
| Env | Unprefixed keys via `vite-app-config.mjs` → `__APP_CONFIG_JSON__` | Gateway vars named `VITE_GATEWAY_URL` (they will be **undefined** at runtime) |
| State | Pinia `src/stores/*.store.js` | Zustand / `src/lib/` session module |
| HTTP | `src/service/index.js` axios factory + `src/utils/gatewayAuth.js` fetch | New parallel API client |
| Components | Vue 3 **Options API** | New `<script setup>` / `ref()` / `reactive()` added by the migration |
| UI kit | `vxceed*` / `Native*` | New `@syncfusion/*` or `<ejs-*>` |

Record at the top of `REVIEW_RESULT.md`:

```
Backend: N/A this repo (Central API is a separate review)
Frontend: Vue 3 Options API / JavaScript / Vite (env: unprefixed via vite-app-config.mjs)
```

If Step 1 does not match, **stop** and use a different skill. Do not "fix" Central to look like Engage.

---

## STEP 2 — PRESENCE: every manifest file exists

Open the frontend skill **§0.1 FILE MANIFEST**. For each row mark `PRESENT`, `MISSING`, or `N/A (reason)`.

Spot list (run from repo root):

```
src/config/index.js
vite-app-config.mjs
.env.example
.env
src/stores/session.store.js
src/components/SessionBootstrap.vue
src/utils/appContext.js
src/views/AuthSsoCallback.vue
src/utils/deepLink.js
src/utils/gatewayAuth.js
src/service/index.js
src/router/index.js
src/stores/authUser.store.js
src/views/layouts/main.vue
src/App.vue
src/main.js
docs/migration/TO_DELETE.txt
```

> **`.env` (real values) is the single most-skipped file.** `.env.example` ≠ a filled `.env`.
> If `.env` is missing the app will not start with real gateway values — FAIL: copy
> `.env.example` → `.env` and fill (or placeholder + TODO in the report).
>
> **C2 is `vite-app-config.mjs`, not `src/vite-env.d.ts`.** A review that FAILs Central for
> missing `vite-env.d.ts` is applying the wrong stack. Conversely, if `ENV_KEYS` in
> `vite-app-config.mjs` omits `GATEWAY_URL` / `USE_GLOBAL_AUTH`, C2 is FAIL.

Grep C2 keys:

```
USE_GLOBAL_AUTH APP_CODE APP_DOMAIN GATEWAY_URL GLOBAL_LOGIN_URL
```

must appear in `vite-app-config.mjs` `ENV_KEYS` **and** `.env.example` **and** `src/config/index.js`.

---

## STEP 3 — PLACEMENT: the file is in the RIGHT Central folder

Do not put files where Engage puts them. Derive from this app, then assert.

| Artifact | Central convention | Typical wrong place | Match? |
|---|---|---|---|
| Config module | `src/config/index.js` (existing config) | `src/config.ts`, `src/lib/config.ts` | |
| Env registry | `vite-app-config.mjs` (repo root) | `src/vite-env.d.ts` | |
| Session store | `src/stores/session.store.js` | `src/store/`, `src/state/`, `src/lib/` | |
| Session bootstrap | `src/components/SessionBootstrap.vue` | `src/pages/`, `src/composables/` | |
| App-context bridge | `src/utils/appContext.js` | `src/lib/appContext.ts` | |
| SSO callback | `src/views/AuthSsoCallback.vue` | `src/pages/AuthSsoCallback.tsx` | |
| Deep-link helpers | `src/utils/deepLink.js` | `src/lib/deepLink.ts` | |
| Gateway auth | `src/utils/gatewayAuth.js` | `src/service/gatewayAuth.js` or axios sibling | |
| HTTP client | `src/service/index.js` (edit in place) | a new `src/lib/api.ts` | |
| Route guard | `src/router/index.js` (edit in place) | a new `ProtectedRoute.vue` | |

If misplaced: **move**, fix imports, re-run Step 4. A moved-but-unrewired file breaks the build.

---

## STEP 4 — WIRING: present + placed is not enough

**Frontend (this repo):**
- [ ] `src/config/index.js` is imported by `gatewayAuth.js`, `deepLink.js`, `SessionBootstrap.vue`, `AuthSsoCallback.vue`, `session.store.js`, `service/index.js`, `router/index.js`, `main.js`, `authUser.store.js`. Not an orphan.
- [ ] `USE_GLOBAL_AUTH` is **opt-in** (`=== 'true'`). Default-ON (`!== 'false'`) is a FAIL for this app — it would silently cut over every environment.
- [ ] `App.vue` wraps the shell in `<session-bootstrap>`.
- [ ] Router registers `{ path: '/auth/sso', component: AuthSsoCallback }` with **no** `beforeEnter: ifAuthenticated`.
- [ ] `beforeEach` (flag ON): callback `next()`; `/login` → portal; idle/loading `next()`; unauthenticated → `redirectToGlobalLogin`.
- [ ] `ifAuthenticated` (flag ON) reads `sessionStore`, not `localStorage.AuthUser`.
- [ ] `src/service/index.js` attaches `sessionStore().accessToken` when flag ON; legacy `AuthUser` Bearer only when flag OFF.
- [ ] `main.js` `fetchUrl()` sets `API_BASE_URL` to `${GATEWAY_URL}/${APP_CODE}/` (**no** `/api/`) when flag ON.
- [ ] `main.js` every `app.mount('#app')` is inside `router.isReady().then(...)`.
- [ ] `authUserStore.signOut()` (flag ON) calls `gatewayLogout(false, …)` then `redirectToGlobalHome()`.
- [ ] `main.vue` `logOut()` returns after `signOut()` when flag ON (does not `router.push('/login')`).
- [ ] Env prefix: **none**. `.env` / `.env.example` / `vite-app-config.mjs` / `config/index.js` all unprefixed.

**Backend (N/A in this repo):** mark gate middleware, `App:Code` parsed-set, Redis `KeyPrefix` as **N/A — API repo**. Still record the cross-repo contracts in Step 5d for the app team.

Any unwired artifact → FAIL with the specific wiring fix.

---

## STEP 5 — SECURITY & CONTRACT AUDIT

> In scope: portal login → handoff → redeem → gateway session → signed headers →
> `GET …/loginserviceapi/bootstrap` attempted (best-effort).
> Out of scope: menu shape, hierarchy, `pagePermissions`, business query filters.
> Record those as app-team items. Do not implement them in this review.

### 5a · Anonymous / legacy login surfaces (FRONTEND)
This SPA has no `[AllowAnonymous]` attributes. Check instead:
- [ ] With flag ON, `/login` cannot stay as a working local auth page (must bounce to portal).
- [ ] `LoginView.vue` may still exist (rollback) — that is OK if unwired when flag ON.
- [ ] Flag OFF still reaches password / ADFS / Cognito (rollback proof).
- [ ] No leftover caller that POSTs `loginserviceapi/login` on the gateway path after handoff.

### 5b · App-session / bootstrap hook — EXISTS, FAIL CLOSED, APP-OWNED
- [ ] `src/utils/appContext.js` `loadAppContext()` exists, is called from `AuthSsoCallback` and `SessionBootstrap`, and **must not** bounce on 401 (`service/index.js` bootstrap URL exclusion).
- [ ] Failure is best-effort (warn, continue) — record blast radius if `role_id` / `principle_code` stay empty (wrong/empty business results). **Do not implement** role/hierarchy sourcing from Central tables.

### 5c · Token storage invariant
- [ ] Gateway access token: memory + `sessionStorage['lhu.central.access_token']` only.
- [ ] `grep` `localStorage.setItem('AuthUser'` / `JWTToken` on the **gateway write path** — must not persist the gateway token there. Legacy writes behind `!USE_GLOBAL_AUTH` are OK.
- [ ] Interceptor overwrites `Authorization` from `sessionStore` on the gateway path so leftover `AuthUser` headers cannot win.
- [ ] Auth-gates that used `localStorage.getItem('AuthUser')` on protected routes are re-pointed at `sessionStore` when the flag is on (`router/index.js`).
- [ ] `.env` is gitignored. Committed secrets rotated at source.

### 5d · CROSS-REPO boundary contracts
- [ ] `app_code` identical in three places: Central `APP_CODE`, API `App:Code`, gateway `gauth_applications`. Mismatch → `SESSION_APP_MISMATCH` 401 on every request.
- [ ] API `GlobalAuthRedis:KeyPrefix` == gateway `Redis:KeyPrefix`.
- [ ] Flag compatibility: Central `USE_GLOBAL_AUTH=true` and API gateway flag ON together. Central flag ON + API legacy-only cannot talk.
- [ ] Bootstrap reachable under `${GATEWAY_URL}/${APP_CODE}/loginserviceapi/bootstrap` and gate-protected. Payload **shape** is app-owned — do not redesign it.

### 5e · Session bootstrap must SKIP `/auth/sso`
- [ ] `SessionBootstrap` returns early when `window.location.pathname` (and `$route.path`) starts with `SSO_CALLBACK_PATH`. Status-only guard is a FAIL (`status` is still `idle` on callback).
- [ ] Splash must **not** hide `<slot>` on `/auth/sso` or `AuthSsoCallback` never mounts.
- [ ] Network on launch: `exchange/redeem` and **no** `refresh` first. A `POST /auth/refresh` 401 `"Invalid or expired refresh token"` right after launch is this bug.

Correct order:

| Situation | Call |
|---|---|
| `/auth/sso?token=…` | `exchange/redeem` **only** |
| Normal route, no in-memory token | `refresh` then `/auth/context` |
| Business 401 | one silent `refresh` + one retry |
| Refresh fails | portal login (`redirectToGlobalLogin`) |

### 5f · 401 interceptor must not refresh gateway-auth endpoints
`gatewayAuth.js` must use **fetch**, not `api()`. Confirm:

```
grep interceptors.response src/service/index.js
grep "from '@/service" src/utils/gatewayAuth.js
```

- [ ] Gateway helpers do not import the axios factory.
- [ ] If they ever share axios, first line of the 401 handler must exclude `/api/v1/_gw/auth`.
- [ ] Network: 401 from `/auth/context` does **not** trigger `POST /auth/refresh`.

### 5g · `router.isReady()` before mount
- [ ] `src/main.js` — no bare `app.mount('#app')`. Every mount path uses `router.isReady().then(() => app.mount('#app'))`.
- [ ] Hard-reload `/auth/sso?token=…` several times: intermittent extra `/auth/refresh` before redeem is this race (layered under 5e, not a replacement).

---

## A. REDIRECT-LOOP GUARD — required behavior

**Bug:** app 401 → portal (still has root session) auto-relaunches → 401 → infinite flicker.

**Exit is PORTAL-side** (`sessionStorage['lhu.relaunchGuard']`, `MAX_RELAUNCHES = 2`, `WINDOW_MS = 20s`). Central cannot fail the portal implementation.

### A.2a Central (downstream) hygiene — this is what you verify here
1. One silent `/auth/refresh` before bouncing on the first business 401 (`src/service/index.js`).
2. Logout redirect is **bare** portal URL via `redirectToGlobalHome()` — no `return_url`.
3. Empty `GLOBAL_LOGIN_URL` refuses redirect (log, no loop).

Portal rows in the report: `N/A — portal repo`.

### A.4 Verify
- [ ] Portal relaunchGuard: N/A this repo.
- [ ] Central: one silent refresh; bare logout URL; empty-URL guard.
- [ ] Behavior (when portal + API available): repeated 401s → at most 2 auto-resumes then portal panel.

---

## STEP 6 — Write `docs/migration/REVIEW_RESULT.md`

```markdown
# Mt-Fuji-Central — Migration Review Result

## Detected stack
- Backend: N/A this repo
- Frontend: Vue 3 Options API / JavaScript / Vite (unprefixed env via vite-app-config.mjs)

## Presence (Step 2)
- <manifest row>: PRESENT <path> | MISSING | N/A (<reason>)

## Placement (Step 3)
- <artifact>: convention=<folder> · found=<path> · MATCH / MOVED → <new path>

## Wiring (Step 4)
- config imported by http/guard/bootstrap: PASS/FAIL
- USE_GLOBAL_AUTH opt-in (`=== 'true'`): PASS/FAIL
- /auth/sso registered, no beforeEnter: PASS/FAIL
- guard on sessionStore when flag ON: PASS/FAIL
- API_BASE_URL = ${GATEWAY_URL}/${APP_CODE}/ (no /api/): PASS/FAIL
- router.isReady() before every mount: PASS/FAIL
- signOut → gatewayLogout(false) + redirectToGlobalHome: PASS/FAIL
- env keys unprefixed across config / vite-app-config / .env.example: PASS/FAIL

## Security & contract audit (Step 5)
- 5a /login unwired when flag ON; rollback intact when flag OFF: PASS/FAIL
- 5b appContext exists, fail-closed / non-blocking; stub recorded not implemented: PASS/FAIL
- 5c token not in localStorage on gateway path: PASS/FAIL
- 5e bootstrap skips /auth/sso (pathname + route): PASS/FAIL
- 5f gatewayAuth is fetch; 401 interceptor does not loop: PASS/FAIL
- 5g router.isReady() on all mount paths: PASS/FAIL
- 5d app_code 3-way match | Redis KeyPrefix | flag compatibility | bootstrap reachable: PASS/FAIL/N-A

## Redirect-loop guard (§A)
- portal rows: N/A — portal repo
- Central hygiene (silent refresh; bare logout URL; empty GLOBAL_LOGIN_URL guard): PASS/FAIL

## Project-rule regressions (must all PASS)
- No new <script setup> / Composition API in migration files: PASS/FAIL
- No @syncfusion/* / new <ejs-*> : PASS/FAIL
- No src/lib/ or src/composables/ invented: PASS/FAIL
- No VITE_ gateway keys: PASS/FAIL
- No new localStorage auth token keys: PASS/FAIL

## Fixes applied during review
- …

## Still open (needs owner)
- …

## Proofs
- npm run build green · app boots with real .env and USE_GLOBAL_AUTH=true · fail-closed 401 matrix
```

> **Definition of review-done:** every §0.1 row PRESENT (or justified N/A) **and** in the Central folder **and** wired; §A hygiene passes; build/boot proofs green; `REVIEW_RESULT.md` records it file-by-file.
