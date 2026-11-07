# SKILL — Migrate **Mt-Fuji-Central** onto the LightHouse Global Identity Platform

> **This is the Central-specific implementation skill.** Same 7-phase flow as the generic
> downstream frontend skill. Paths, env, HTTP, and Vue style are **pinned to this repo**
> (`mt-fuji-central3-0`). Do **not** copy Engage React/TSX, Fuji-Vue3 `<script setup>`,
> `src/lib/`, `VITE_*` env vars, or `@syncfusion/*` into this app.
>
> **This repo is the Central SPA only** — outlets, distributors, trade promotions, targets,
> routes, and related master data. It is **not** the DMS (Fuji-Vue3) app and **not** the
> Central API. Backend companion: `DOWNSTREAM_MIGRATION_BACKEND_SKILL.md` in the API repo.
>
> Keep this file identical to `docs/migration/DOWNSTREAM_MIGRATION_FRONTEND_SKILL.md`.

---

## 0. How to use this skill

Execute **7 phases in order**. Do **not** skip Phase 0 — the change **adapts to the current login code**.

```
Phase 0  DISCOVER   → read THIS app, fill the "Current-State Audit"
Phase 1  MAP        → Central gap map (current → target)
Phase 2  PLAN       → ordered, flag-gated task list
Phase 3  IMPLEMENT  → ADD / CHANGE / RETIRE→_backup/
Phase 4  REVIEW     → self + adversarial checklist; fix findings
Phase 5  VERIFY     → drive the real flows in a browser; prove it
Phase 6  REPORT     → write docs/migration/MIGRATION_RESULT.md
Phase 7  REVIEW     → run DOWNSTREAM_MIGRATION_REVIEW_SKILL.md — proves every file landed,
                      is in the right Central folder, is wired, and the redirect-loop
                      hygiene is in. MANDATORY.
```

**Golden rules (every phase):**
1. **Login leaves this app.** Authentication happens at the LightHouse Global-Auth SPA. Central only *receives* a session and *reads* who you are.
2. **Never hard-delete.** Retired files move to `_backup/` and are listed in `docs/migration/TO_DELETE.txt`. Unwire from routing/imports. **Rotate** any committed secret (moving is not enough).
3. **Ship additively behind `USE_GLOBAL_AUTH`.** In this app the flag **defaults OFF** — it is `true` only when the env value is literally `'true'`. Legacy login (password / ADFS / Cognito) stays intact until the gateway path is proven.
4. **Gateway access token:** memory + per-tab `sessionStorage` key `lhu.central.access_token` only. Do **not** write it to `localStorage`. Do not add new auth token keys (see `.cursor/rules/security-rules.mdc`).
5. **Business screens are kept.** Only how they get "who am I" and how requests are authorized changes. Do not rewrite grids, forms, or APIs as part of this migration.

### Central stack invariants (do not "translate" these away)

| Topic | This repo |
|---|---|
| App | `mt-fuji-central3-0` (Vue 3 Central SPA) |
| API style | Vue 3 **Options API** (`name`, `props`, `data`, `computed`, `watch`, lifecycle, `methods`). No `setup()` / `ref` / `reactive` / `<script setup>` unless a ticket explicitly asks. |
| Language | **JavaScript**. No `vite-env.d.ts`. |
| Build | Vite. Env keys are **unprefixed** (`API_BASE_URL`, `USE_GLOBAL_AUTH`, …) via `vite-app-config.mjs` → `__APP_CONFIG_JSON__` → `src/config/index.js`. **Not** `import.meta.env.VITE_*`. |
| Router | Vue Router 4 — `src/router/index.js` |
| State | Pinia — `src/stores/*.store.js` (`state` / `getters` / `actions`) |
| HTTP (business) | Axios factory `src/service/index.js` (`api()`). `baseURL` comes from `localStorage.API_BASE_URL`. |
| HTTP (gateway auth) | Native `fetch` in `src/utils/gatewayAuth.js` — **never** the shared axios instance (REVIEW §5f). |
| i18n | `vue-i18n` via `this.$t()` / `$t()`. Do not hardcode user-facing strings. |
| UI | Native `vxceed*` / `Native*` under `src/components/globalComponents/`. **No** `@syncfusion/*` or new `<ejs-*>` tags. |
| Folders | Views `src/views/`. Feature UI `src/components/<Feature>/`. Shared helpers `src/utils/` (**no** `src/lib/`, **no** `src/composables/`). Services `src/service/`. |
| Gateway business prefix | `${GATEWAY_URL}/${APP_CODE}/` — **no** `/api/` segment. |
| Flag default | `USE_GLOBAL_AUTH` is **opt-in** (`=== 'true'`). Empty/undefined/false → legacy login. |

---

## 0.1 FILE MANIFEST — every file this migration touches (READ FIRST, VERIFY LAST)

> Fill **Actual path** during Phase 0 if a file already exists under a different name. Do the work in Phase 3. Confirm every row in **§10** before calling the migration done.
>
> **ADD** = create it (if it already exists, EDIT in place — never duplicate). **EDIT** = modify an existing file. Paths below are **this repo's** convention, not Engage's.

### Config & env — the trio that is MOST often missed (do these FIRST, §5.0)

| # | Action | Artifact | Central path | Notes |
|---|--------|----------|--------------|-------|
| C1 | **ADD/EDIT** | Central config module | `src/config/index.js` | Gateway exports + `assertGatewayConfig()` live **next to** the existing `config` / `serviceApi()` — do not add a parallel `src/config.ts`. |
| C2 | **EDIT** | Env key registry | `vite-app-config.mjs` | Add `USE_GLOBAL_AUTH`, `APP_CODE`, `APP_DOMAIN`, `GATEWAY_URL`, `GLOBAL_LOGIN_URL` to `ENV_KEYS`, `DEFAULTS`, and `buildAppConfig()`. This **replaces** Engage's `vite-env.d.ts`. |
| C3 | **ADD/EDIT** | Committed env template | `.env.example` | Unprefixed keys. Safe to commit. |
| C4 | **ADD** | **Local env file (REAL values)** | `.env` | Gitignored. Copy `.env.example` → `.env` and fill. Most-skipped file. |

### Session / auth plumbing (§5.1–5.3)

| # | Action | Artifact | Central path | Notes |
|---|--------|----------|--------------|-------|
| S1 | **ADD/EDIT** | Session store | `src/stores/session.store.js` | Pinia `defineStore` with `state`/`getters`/`actions`. Hydrate from `/auth/context`. Token in memory + `sessionStorage`. |
| S2 | **ADD** | Session bootstrap component | `src/components/SessionBootstrap.vue` | Options API SFC. Wrap `App.vue` slot. Skip `/auth/sso`. |
| S3 | **ADD** | Legacy app-context bridge | `src/utils/appContext.js` | `GET` `serviceApi('LOGIN_SERVICE_BASE_URL', '/bootstrap')` via `api()`. Fills `principle_code` / `role_id` / `sso_type`. |
| S4 | **ADD** | Landing / SSO callback | `src/views/AuthSsoCallback.vue` | Options API view. Route `/auth/sso`. Redeem only — never refresh. |
| S5 | **ADD** | Deep-link + logout helpers | `src/utils/deepLink.js` | `redirectToGlobalLogin` (with `return_url`) vs `redirectToGlobalHome` (bare portal URL). |
| S6 | **ADD** | Gateway auth lib | `src/utils/gatewayAuth.js` | `fetch` (not axios): redeem / refresh / context / logout. |

### Edits to existing files (§5.4–5.6)

| # | Action | Artifact | Central path | Notes |
|---|--------|----------|--------------|-------|
| L1 | **EDIT** | Redirect-loop hygiene | `src/service/index.js` 401 path + `src/utils/deepLink.js` | One silent `/auth/refresh` before bounce; logout → bare portal URL. Counter/exit is **portal-side**. |
| E1 | **EDIT** | HTTP client | `src/service/index.js` | Gateway: Bearer from `sessionStore().accessToken`. Legacy: `AuthUser` Bearer + `app-auth-fetch-qualifier`. |
| E2 | **EDIT** | Route guard | `src/router/index.js` (`beforeEach` + `ifAuthenticated`) | Gate on `sessionStore` when flag ON; keep `authUserStore` when flag OFF. |
| E3 | **EDIT** | Router / routes | `src/router/index.js` | Register `/auth/sso` with **no** `beforeEnter`. Under flag, `/login` bounces to the portal. |
| E4 | **EDIT** | Existing logout | `src/stores/authUser.store.js` `signOut()` + `src/views/layouts/main.vue` | Wire gateway logout into the **existing** sidebar logout. No new widget. |
| E5 | **EDIT** | App shell wrap | `src/App.vue` | Wrap `<router-view>` in `<session-bootstrap>`. Keep Options API `export default`. Do not expand the leftover `<script setup>`. |
| E6 | **EDIT** | Boot / API base | `src/main.js` | Flag ON → `localStorage.API_BASE_URL = ${GATEWAY_URL}/${APP_CODE}/`. Mount only after `router.isReady()`. |

### Retire → `_backup/` (never delete, §5.6)

| # | Action | Artifact | Central path | Notes |
|---|--------|----------|--------------|-------|
| R1 | **RETIRE (flag-gate, do not delete yet)** | Local login | `src/views/LoginView.vue` | Keep the file for rollback. Copy to `_backup/LoginView.vue.bak`. List in `TO_DELETE.txt`. Under flag ON the router must not land on `/login`. Cognito/ADFS/password stay behind the flag. |

> Add rows for anything Phase 0 turns up (SSOHome, Amplify, announcement bootstrap). **Do not delete a row because it is inconvenient — mark N/A with a reason in §10.**

---

## 1. The INVARIANT target (never changes)

Reference for **gateway contracts**: LightHouse Global-Auth (Universe) + Engage. Reference for **file placement and Vue style**: **this repo**.

### 1.1 Session model
- **No local login** when `USE_GLOBAL_AUTH=true`. Unauthenticated → redirect to the Global-Auth SPA.
- **Session from the gateway:** httpOnly refresh cookie + in-memory (and `sessionStorage`) access token. Confirm with the gateway team in Phase 0-H.
- **Identity from `GET /auth/context`** on load. Splash until resolved so protected pages do not flash.

### 1.2 Routing / guard
- One guard in `src/router/index.js` gates protected routes on `sessionStore` (loading → let `SessionBootstrap` finish; none → global login; ok → render). Not on `localStorage.AuthUser` or a client-computed expiry.

### 1.3 The three URL cases
- **API calls** → through the gateway under `/{APP_CODE}/…`. Send the gateway session (cookie `withCredentials` + Bearer from the session store).
- **Opening a Central page** → a page load, not an API call; it carries no `app_code`. Deep-link handling lives in §1.4.

### 1.4 Deep-link & mobile return
When Central loads with **no session**, redirect to global login carrying `return_url` (encoded current origin + path) and `app={APP_CODE}`. After login, honor that reference and land on the original page. Keep `location.pathname+search`.

### 1.4a Redirect-loop guard — the PORTAL owns the exit
A 401 bounce + portal auto-relaunch can loop. The **portal** counts continuous auto-relaunches in `sessionStorage` and, after **2** that did not stick, stays put. See `DOWNSTREAM_MIGRATION_REVIEW_SKILL.md` §A.
- **Central's only duties:** (1) one silent `/auth/refresh` before bouncing on the first business 401; (2) intentional logout redirects to the **bare** portal URL (no `return_url`). **No** `auth_retry` query param and **no** per-app counter in this app.

### 1.5 Gateway logout is a capability, not a new UI
Call gateway logout, clear local state, redirect to global login — from the **existing** sidebar logout (`side-nav-menu` → `logoutclicked` → `main.vue` `logOut()` / `sessionlogOut()` → `authUserStore.signOut()`). **Do not** add a profile menu, account switcher, or floating avatar.

### 1.5a Account switching is PORTAL-only
`GET /auth/context` for a launched app session returns **one** account. Do not build an in-app account switcher. A "switch account" link, if product ever wants one, must go back to the portal.

### 1.6 Config — ONE module (`src/config/index.js`) plus `vite-app-config.mjs`
All gateway wiring is exported from `src/config/index.js`. Zero scattered `import.meta.env` / `process.env` reads for gateway values.
Must export:
- `USE_GLOBAL_AUTH` — **true only when the env value is literally `'true'`**
- `APP_CODE`, `APP_DOMAIN`, `GATEWAY_URL`, `GLOBAL_LOGIN_URL` (trailing-slash-stripped)
- `GATEWAY_AUTH_BASE = ${GATEWAY_URL}/api/v1/_gw/auth`, `GATEWAY_ORIGIN`
- `BUSINESS_API_BASE` from existing `API_BASE_URL` (repointed at boot when the flag is on)
- `SSO_CALLBACK_PATH = '/auth/sso'`, `DEFAULT_APP_ROUTE = '/'`
- `assertGatewayConfig()` — returns missing keys; log, do not crash

Env keys are registered in `vite-app-config.mjs` (C2) and documented in `.env.example` (C3).

---

## 2. PHASE 0 — Discover (fill the Current-State Audit)

Read the actual code; quote files; assume nothing. Expected Central answers (verify, do not skip):

**A. Stack & build**
- [ ] Vue 3 + Vite + Pinia + Vue Router 4 + axios + vue-i18n. Env: `vite-app-config.mjs` unprefixed keys. Auth libs today: hand-rolled login + ADFS (`/SSOHome`) + AWS Amplify Cognito (`aws-amplify`). Committed secrets?

**B. Routing**
- [ ] `src/router/index.js`: public `/login`, `/register`; protected routes use `beforeEnter: ifAuthenticated`. Landing `/` vs `/home` via `resolveLandingRoute`.

**C. Guard**
- [ ] Legacy: `beforeEach` reads `authUserStore().isUserAuthenticated` (`localStorage.AuthUser` AES). Failure → `/login`.

**D. Login flow**
- [ ] `LoginView.vue` password → `authUserStore.signIn` → `POST loginserviceapi/login`. ADFS/SSO: `main.js` `userinfoDetails()`. Cognito Amplify hosted UI. Stored in `localStorage.AuthUser` (AES, key `'AuthUser'`).

**E. Token handling**
- [ ] `src/service/index.js` injects `Authorization: Bearer` + `app-auth-fetch-qualifier` from `AuthUser`. 401/406 → toast + `/login`.

**F. Session / user context**
- [ ] `authUserStore` + `appDataStore` (profile, menus, branding). Shell bootstrap: `/user/profile`, getmenu, Getbranding.

**G. Account / role / tenant**
- [ ] `{TENANT_KEY}` = `principle_code` (localStorage). `role_id`, `sso_type`. No in-app account switcher.

**H. API layer & gateway session model**
- [ ] `api()` axios factory; `baseURL = localStorage.API_BASE_URL`. Paths via `serviceApi('LOGIN_SERVICE_BASE_URL', '/…')`. Confirm cookie vs hand-off token with gateway team. Same-site if cookie.

**I. Shell / profile / logout**
- [ ] `src/views/layouts/main.vue` + `side-nav-menu.vue`. Logout: `signOut()` / ADFS logout. Profile is existing UI — do not replace it.

**Output:** `{APP_CODE}`, `{ROUTER}=vue-router`, `{STATE}=pinia`, `{HTTP}=axios+fetch`, `{TENANT_KEY}=principle_code`, session model, route table, guard, committed-secret list.

---

## 3. PHASE 1 — Map (current → target)

Gap table: one row per concern (login, session receipt, guard, token attach, refresh, user context, account switch, role switch, profile, logout, API base/prefix, committed secrets). Each: **Current · Target (§1) · Action (ADD/CHANGE/RETIRE→backup/KEEP)**.

---

## 4. PHASE 2 — Plan (adaptive, flag-gated)

- **Critical:** C1–C4 first. Session store + `/auth/context` bootstrap. Guard on the store. HTTP uses gateway session; drop legacy Bearer/API-key **on the gateway path only**. `/auth/sso` callback. Repoint `API_BASE_URL` in `fetchUrl()`. `router.isReady()` before mount.
- **High:** Flag-gate local login (keep `LoginView.vue`). Wire gateway logout into existing `signOut()`. Deep-link send + honor. Rotate committed keys.
- **Medium/Low:** Remove hardcoded tenant literals if Phase 0 finds them; double-prefix URL bugs; dead providers.

**Rollback:** `USE_GLOBAL_AUTH` not `'true'` → 100% legacy login.

---

## 5. PHASE 3 — Implement (Central transformation rules)

### 5.0 ADD/EDIT — config module FIRST

**1) `src/config/index.js`** — keep existing `config` + `serviceApi()`. Add gateway block:

```js
const _stripSlash = (s) => (s || '').replace(/\/+$/, '')

export const USE_GLOBAL_AUTH =
  String(_config.USE_GLOBAL_AUTH ?? '').trim().toLowerCase() === 'true'

export const APP_CODE   = _config.APP_CODE   || 'central'
export const APP_DOMAIN = _config.APP_DOMAIN || ''
export const GATEWAY_URL      = _stripSlash(_config.GATEWAY_URL      || '')
export const GLOBAL_LOGIN_URL = _stripSlash(_config.GLOBAL_LOGIN_URL || '')
export const GATEWAY_AUTH_BASE = GATEWAY_URL ? `${GATEWAY_URL}/api/v1/_gw/auth` : ''
export const SSO_CALLBACK_PATH = '/auth/sso'
export const DEFAULT_APP_ROUTE = '/'

export function assertGatewayConfig() {
  const missing = []
  if (!GATEWAY_URL) missing.push('GATEWAY_URL')
  if (!GLOBAL_LOGIN_URL) missing.push('GLOBAL_LOGIN_URL')
  return missing
}
```

**2) `vite-app-config.mjs`** — register the same unprefixed keys in `ENV_KEYS`, `DEFAULTS` (`USE_GLOBAL_AUTH: 'false'`), and the object returned by `buildAppConfig()`.

**3) `.env.example`**
```
USE_GLOBAL_AUTH=false
APP_CODE=CENTRAL_LOCAL
APP_DOMAIN=http://localhost:5181
GATEWAY_URL=https://npglobalauthapi.lh.vxceed.net
GLOBAL_LOGIN_URL=https://npglobalauth.lh.vxceed.net
# When flag is true, boot repoints API_BASE_URL to ${GATEWAY_URL}/${APP_CODE}/
```

Do not log raw env values. Do not add a ConfigProvider / composable.

### 5.1 ADD — session bootstrap + store
On app start (not on `/auth/sso`): if a gateway session exists, `GET /auth/context`, populate `sessionStore` (user, accounts, roles, apps, selection, distributor). Access token in memory + `sessionStorage['lhu.central.access_token']`. Splash until resolved. **Options API** in `SessionBootstrap.vue`. Guard splash on **route** (`window.location.pathname` **and** `$route.path`) so `/auth/sso` is never swallowed.

### 5.1a ADD — legacy-bridge app bootstrap
Call Central `GET {LOGIN_SERVICE_BASE_URL}/bootstrap` via `api()` (so the axios interceptor attaches Bearer and Network shows `bootstrap`). Map response into the localStorage keys pages already read: `principle_code`, `role_id`, `sso_type`. Best-effort — failure must not block login. Set `sessionStore.appContextReady` in a `finally`. Keep splash up until that flag is true.

Then run existing shell bootstrap (`ensureShellBootstrapData` in `src/router/index.js`) so menus/profile/branding load without poll-waiting in `beforeEach`.

### 5.2 ADD — landing / callback + deep-link
`AuthSsoCallback.vue` at `/auth/sso`:
1. `POST /auth/exchange/redeem` (handoff token from `?token=`)
2. `GET /auth/context`
3. `loadAppContext()` (bootstrap)
4. `router.replace(consumeReturnPath('/'))`

Never call `/auth/refresh` on this route.

### 5.3 ADD — gateway logout ONLY
In `authUserStore.signOut()`, when the flag is on: `gatewayLogout(false, accessToken)` (never `all_devices: true`), `clearSession()`, clear local state, `redirectToGlobalHome()` (bare `${GLOBAL_LOGIN_URL}/login`). `main.vue` `logOut()` returns early after `signOut()` so it does not `router.push('/login')`.

### 5.3a Logout vs session-expiry redirects are different functions
- Expiry / unauthenticated → `redirectToGlobalLogin(path)` (sends `return_url` + `app`)
- Logout → `redirectToGlobalHome()` (no query). Reusing the expiry helper makes logout relaunch the app.

`gatewayLogout` in this app also best-effort `POST` Central `loginserviceapi/logout` **before** the gateway logout (two different APIs). Keep that order.

### 5.4 CHANGE — guard
`beforeEach` when flag ON:
- `/auth/sso` → `next()` (callback must mount)
- `/login` → `redirectToGlobalLogin('/')` + `next(false)`
- idle/loading → `next()` (SessionBootstrap owns reload bootstrap)
- unauthenticated → `redirectToGlobalLogin(to.fullPath)`
- authenticated → continue; `ifAuthenticated` uses `sessionStore`, not `AuthUser`

Refuse redirect if `GLOBAL_LOGIN_URL` is empty (log, do not bounce).

### 5.5 CHANGE — HTTP layer
`src/service/index.js`:
- Flag ON: attach `Authorization: Bearer ${sessionStore().accessToken}`; skip `AuthUser` / `app-auth-fetch-qualifier`.
- 401: skip bounce for the bootstrap URL; else one `silentRefresh()` + retry; then `clearSession()` + `redirectToGlobalLogin`.
- `gatewayAuth.js` stays on `fetch` so gateway 401s never re-enter this interceptor.
- `main.js` `fetchUrl()`: `localStorage.setItem('API_BASE_URL', `${GATEWAY_URL}/${APP_CODE}/`)` when flag ON. **No** `/api/` suffix.

### 5.6 RETIRE → `_backup/` (never delete)
Copy `LoginView.vue` to `_backup/`. Do not delete Cognito/ADFS/password code until UAT soak — flag-gate it. Rotate committed API/license keys. List leftovers in `docs/migration/TO_DELETE.txt`.

### 5.7 KEEP
All business screens, `main-layout`, vxceed grids/forms, Pinia `appDataStore`, `serviceApi()` call sites, theme, i18n, TAC selectors (`mfc-ejs-tab`, `mfc-ejs-grid`).

### 5.8 Vue / project rules while implementing
- New/edited SFCs: Options API only. File kebab-case where new; `name` PascalCase.
- User-facing strings: `$t()`.
- Do not invent a second HTTP client.
- Do not store the gateway token in `localStorage`.
- `App.vue` already has a leftover `<script setup>` — do not copy that pattern; do not grow it.

---

## 6. PHASE 4 — Review (self + adversarial)

- [ ] Single `src/config/index.js` + `vite-app-config.mjs` keys? No raw `VITE_*` / `import.meta.env` for gateway values?
- [ ] Flag default OFF unless `'true'`?
- [ ] Protected route reachable without a session? Race before bootstrap?
- [ ] Reload hydrates from `/auth/context` (not `AuthUser`)?
- [ ] Gateway token not in `localStorage`? (`lhu.central.access_token` is sessionStorage only)
- [ ] Deep link while logged out returns to the original page?
- [ ] Old Bearer injection skipped when flag ON?
- [ ] Nothing hard-deleted; `_backup/` + `TO_DELETE.txt`?
- [ ] Business screens still use `api()` / `serviceApi()`?
- [ ] Legacy login still works with flag false?
- [ ] Empty `GLOBAL_LOGIN_URL` refuses redirect?
- [ ] Bootstrap skips `/auth/sso` (route + `window.location`)?
- [ ] `app.mount` waits for `router.isReady()`?
- [ ] 401 interceptor does not refresh on gateway-auth URLs (fetch exclusion)?
- [ ] Bootstrap 401 does not bounce to the portal?
- [ ] No new Syncfusion / Composition API / `src/lib/`?

---

## 7. PHASE 5 — Verify (drive it in a browser)

1. `npm run lint` / `npm run build` green (this repo has **no** `typecheck` script).
2. Flag **false**: password / ADFS / Cognito login still works.
3. Flag **true**: `/login` bounces to the portal; no local login form.
4. Logged-out deep link → portal with `return_url`+`app` → land on original Central page.
5. Fresh load with session → `/auth/context` then bootstrap; splash then shell; no flash of `/login`.
6. Launch from portal → `/auth/sso?token=…` shows **redeem then context then bootstrap**, **no** `refresh` first.
7. Hard-reload `/auth/sso?token=…` several times: no intermittent extra `/auth/refresh` before redeem.
8. API calls go to `${GATEWAY_URL}/${APP_CODE}/…` with Bearer; foreign session rejected.
9. Logout → Central login-service logout + gateway logout `all_devices:false` → bare portal `/login` (launcher, still signed in to the platform). Back button does not restore a live Central session.
10. Reload mid-session → still logged in.
11. Force a business 401: exactly one silent refresh then retry; refresh fail → portal. Force a 401 from `/auth/context`: **no** `/auth/refresh` loop.

Record observations for the report.

---

## 8. PHASE 6 — Write the result file

Create **`docs/migration/MIGRATION_RESULT.md`**:

```markdown
# Mt-Fuji-Central — Gateway Migration Result

## Summary
Login moved out when USE_GLOBAL_AUTH=true; session from /auth/context; gateway logout
wired into existing sidebar; business screens unchanged; flag defaults false.

## Detected stack
Vue 3 Options API · JS · Vite (unprefixed env via vite-app-config.mjs) · Pinia · Vue Router 4 · axios + fetch

## Current-state audit (Phase 0)
- …

## What was ADDED / CHANGED / RETIRED / KEPT
- …

## Config required at deploy
USE_GLOBAL_AUTH=true
APP_CODE=<must match gateway gauth_applications and API App:Code>
APP_DOMAIN=…
GATEWAY_URL=…   (no trailing slash)
GLOBAL_LOGIN_URL=…
API_BASE_URL is overwritten at boot to ${GATEWAY_URL}/${APP_CODE}/

## File checklist
(paste §10)

## Verification evidence (Phase 5)
- …

## Rollback
Set USE_GLOBAL_AUTH=false (or omit). Legacy LoginView + AuthUser path.

## Open items / risks
- …
```

---

## 9. Adaptivity notes (this app)

- **Cookie + hand-off token:** portal `POST /auth/launch` → `handoff_token` → Central `/auth/sso?token=` → `POST /auth/exchange/redeem` (no Bearer) → httpOnly refresh cookie + access token → `GET /auth/context`.
- **Session bootstrap MUST skip `/auth/sso`.** Prefer `window.location.pathname` over `$route.path` (router can still report `'/'` on first paint even after `isReady()`).
- **401 interceptor MUST NOT see gateway auth calls.** Keep them on `fetch`. If anyone later points `gatewayAuth.js` at `api()`, add `if (url includes '/api/v1/_gw/auth') reject`.
- **`router.isReady().then(() => app.mount('#app'))`** is required in every mount path in `main.js` (this file historically created more than one app instance).
- **`{TENANT_KEY} == principle_code == account_code`.** Mirror from context / bootstrap so business pages need zero edits.
- **Do not port Fuji-Vue3 Composition screens or `vxceed-form-grid`.** Central has neither.
- **Account switching is portal-only.**

> **Definition of done:** C1–C4 landed; login gone when flag ON; session from `/auth/context`; deep links and reload work; logout uses existing UI + bare portal URL; nothing deleted; secrets rotated; `MIGRATION_RESULT.md` written; legacy revertible by flag; **§10 filled**.

---

## 10. FINAL FILE CHECKLIST — fill before declaring done (MANDATORY)

For each row: `✅ CREATED <path>` · `✅ EDITED <path>` · `⤫ N/A — <reason>`.

**Config & env:**
- [ ] **C1** `src/config/index.js`
- [ ] **C2** `vite-app-config.mjs`
- [ ] **C3** `.env.example`
- [ ] **C4** `.env` (real or placeholder + TODO)

**Session / auth plumbing:**
- [ ] **S1** `src/stores/session.store.js`
- [ ] **S2** `src/components/SessionBootstrap.vue`
- [ ] **S3** `src/utils/appContext.js`
- [ ] **S4** `src/views/AuthSsoCallback.vue`
- [ ] **S5** `src/utils/deepLink.js`
- [ ] **S6** `src/utils/gatewayAuth.js`

**Edits:**
- [ ] **L1** silent refresh + bare logout URL
- [ ] **E1** `src/service/index.js`
- [ ] **E2** `src/router/index.js` guard
- [ ] **E3** `/auth/sso` route
- [ ] **E4** `authUser.store.js` `signOut()` + `main.vue`
- [ ] **E5** `src/App.vue`
- [ ] **E6** `src/main.js` (`API_BASE_URL` repoint + `router.isReady()`)

**Retire:**
- [ ] **R1** `LoginView.vue` → `_backup/` copy + `TO_DELETE.txt`; still flag-gated, not deleted

**Two proofs:**
1. `npm run build` is green.
2. App boots with flag ON and a filled `.env` (no missing `GATEWAY_URL` / cannot-read-config at startup).

Copy this checklist into `MIGRATION_RESULT.md`.
