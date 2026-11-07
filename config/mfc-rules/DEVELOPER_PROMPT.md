# Screen prompt for Mt-Fuji-Central (copy into Cursor)

Use this prompt to implement or fix **one screen** in Mt-Fuji-Central. Same one-path-per-chat flow as the Fuji-Vue3 prompt — **not** the same API style. This app stays on Vue 3 **Options API** and native `vxceed*` / `Native*` components.

1. Replace `<PATH>` with the Central route (example: `/outletsMaster`).
2. Optionally list companion files if you already know them.
3. Paste the block below into Cursor and run it.
4. Read [COMPOSITION_API_EXPLAINED.md](./COMPOSITION_API_EXPLAINED.md) if you need Options vs Composition — Central uses Options.

This is **not** Fuji-Vue3 (DMS). Do not migrate screens to `<script setup>`. Do not import `@syncfusion/*` or add `<ejs-*>`. Do not copy `vxceed-form-grid` from DMS.

---

```text
You are working in Mt-Fuji-Central (mt-fuji-central3-0): Vue 3 Options API, Vite, Pinia, Vue Router, vue-i18n.

Goal:
Change ONLY this screen unit. Keep functionality, UI, APIs, permissions, and tests the same unless the ticket says otherwise.

Assigned screen unit:
- Router path: <PATH>
- Include: the route view in src/views/ AND every locally imported companion SFC (forms, grids, local modals) used by that view
- Exclude: unrelated shared/global components (vxceedTabs, vxceedGrid, main-layout, App shell, SessionBootstrap) unless this screen uniquely owns them

Hard rules (do not break these):
1. Vue 3 Options API only: name, props, data, computed, watch, lifecycle hooks, methods. Do NOT add setup(), ref(), reactive(), or <script setup>.
2. Do NOT change business logic, calculations, validations, API endpoints, request/response handling, or permissions unless the ticket asks.
3. Do NOT change template structure, labels, CSS/classes, or TAC / data-testid / mfc-ejs-* selectors unless required for a real bugfix.
4. Do NOT change prop names, emit names, slot names, or public methods parents rely on.
5. User-facing strings go through $t(). Do not hardcode labels, buttons, or validation text.
6. Use native vxceed* / Native* components already in src/components/globalComponents/. Never add @syncfusion/* or <ejs-*> tags. There is no vxceed-form-grid in this repo.
7. List screens: vxceed-grid plus vxceed-column-chooser when the screen has column visibility. Wrap page content in main-layout like sibling views.
8. Call existing methods in src/service/ (api() + serviceApi()). Do not invent a parallel HTTP client. Do not read import.meta.env / VITE_* for app config — use src/config/index.js.
9. Keep component state in data(). Use Pinia only for shared app state (authUser, session, appData). Do not store auth tokens in new localStorage / sessionStorage keys.
10. Convert or edit leaf companions first, then the main view.
11. Keep EventBus event names the same; register/unregister in mounted / beforeUnmount (or created / beforeDestroy if that is what the sibling already does).
12. Clear timers, listeners, and modal state on destroy. Do not skip error handling on API calls.
13. If you are porting a companion from Fuji-Vue3 that uses <script setup>, convert it TO Options API. Do not leave Composition API in this repo.
14. After changes: summarize what changed; confirm behavior should be identical (unless the ticket changed it); list any companions left out of scope.

Workflow:
1. List all SFCs in this screen unit and mark each as Options API or (incorrectly) <script setup>.
2. Edit files one by one (children first). Convert any Composition companions to Options before touching the parent.
3. Keep each change mechanical. Match sibling screens in the same feature folder.
4. Stop if a change would alter behavior — ask before doing that.
5. Verify the screen: load, filter, page, save; empty / loading / forbidden (pagePermissions.VIEW) / error states.

Start now for path: <PATH>
```

---

## Tips for a safe run

- One path per Cursor chat / PR.
- If the view is already Options API, still check local companions for leftover `<script setup>` or Syncfusion tags.
- If `npm run build`, lint, or Playwright / TAC fails, fix without changing product behavior.
- Shared globals (`vxceedGrid`, `main-layout`, session/auth) belong in a separate task, not inside a normal screen PR.
- Gateway / login work uses `DOWNSTREAM_MIGRATION_FRONTEND_SKILL.md`, not this prompt.
