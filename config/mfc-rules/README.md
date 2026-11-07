Draft `.cursor/rules` for `Vxceed-IN/Mt-Fuji-Central`.

The seven `.mdc` files are the always-on and glob rules (Options API, native `vxceed*` components, no Syncfusion, `mfc-ejs-*` CSS compatibility). Fuji-Vue3 rules were used only where the same constraints apply.

These four docs are mirrored from the Central repo:

- `DEVELOPER_PROMPT.md` and `COMPOSITION_API_EXPLAINED.md` are force-included on every MFC ticket. They keep screen work on Options API and native `vxceed*` components. They are not a Composition API migration.
- `DOWNSTREAM_MIGRATION_FRONTEND_SKILL.md` and `DOWNSTREAM_MIGRATION_REVIEW_SKILL.md` load only when the ticket is Global Identity / gateway login work (`USE_GLOBAL_AUTH`, not `VITE_*`). The gateway access token may use `sessionStorage` key `lhu.central.access_token` and must not be written to `localStorage`.
