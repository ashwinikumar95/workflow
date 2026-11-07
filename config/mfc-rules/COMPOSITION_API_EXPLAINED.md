# Options API in Mt-Fuji-Central (and why we do not switch)

This note explains **what Options API is**, **how it differs from Composition API**, **how we write a Central component**, and **what to do if you see Fuji-Vue3 `<script setup>`**.

Mt-Fuji-Central (`mt-fuji-central3-0`) **stays on Vue 3 Options API**. The DMS app (Fuji-Vue3) may migrate screens to Composition API. Those two rules must not be mixed.

See also: `.cursor/rules/central-project-rules.mdc`, `new-component-rules.mdc`, `DEVELOPER_PROMPT.md`.

---

## 1. What is Options API? (this project's default)

Options API is the Vue style this repo already uses. You put everything in one object with fixed sections:

```js
export default {
  name: 'OutletGrid',
  data() {
    return { count: 0, name: '' }
  },
  computed: {
    label() {
      return this.name + ' (' + this.count + ')'
    }
  },
  methods: {
    add() {
      this.count++
    }
  },
  mounted() {
    // run when screen opens
  }
}
```

**How it feels:** Logic for one feature is split across `data`, `methods`, `computed`, and `watch`. That matches every Central list/form screen (`Outlet-Grid.vue`, `distributor-form.vue`, `trade-promotion-form.vue`, …). New work must look like those siblings.

---

## 2. What is Composition API? (used in Fuji-Vue3, not here)

Composition API is the newer Vue 3 style, usually written with `<script setup>`:

```js
import { ref, computed, onMounted } from 'vue'

const count = ref(0)
const name = ref('')

const label = computed(() => name.value + ' (' + count.value + ')')

function add() {
  count.value++
}

onMounted(() => {
  // run when screen opens
})
```

Fuji-Vue3 may convert screens this way. **Do not do that in Central** unless a ticket explicitly asks for Composition API.

`App.vue` has a leftover `<script setup>` block next to the Options `export default`. That is **not** a pattern to copy. Do not grow it; do not add `<script setup>` to SessionBootstrap, views, or feature components.

---

## 3. Main differences (side by side)

| Topic | Options API (**Central**) | Composition API (`<script setup>` — DMS only) |
|--------|---------------------------|-----------------------------------------------|
| State | `data() { return { ... } }` | `ref()` / `reactive()` |
| Derived values | `computed: { ... }` | `computed(() => ...)` |
| Functions | `methods: { ... }` | Normal `function` |
| Watch | `watch: { ... }` | `watch(...)` |
| Lifecycle | `mounted()`, `created()`, … | `onMounted()`, `onBeforeMount()`, … |
| Props / events | `props`, `emits` options | `defineProps()`, `defineEmits()` |
| Access values in script | `this.count` | `count.value` (for `ref`) |
| Access in template | `{{ count }}` | Same — `{{ count }}` |
| Reuse logic | existing `src/utils/` + Pinia stores | composables (`useXxx.js`) — **do not invent `src/composables/` here** |
| i18n | `this.$t()` / `$t()` | `useI18n()` |
| Router | `this.$route` / `this.$router` | `useRoute()` / `useRouter()` |
| Pinia | `someStore()` then `this`/local vars | `storeToRefs` + `useXxxStore()` |

**Same UI, same behavior** if you were converting. In Central we **keep Options** so screens stay consistent with `main-layout`, vxceed grids, and TAC selectors.

---

## 4. How a Central screen is written (simple steps)

For one `.vue` file in this repo:

1. Keep or add `<script>` with `export default { name, … }` — not `<script setup>`.
2. Put local state in `data()`.
3. Put derived values in `computed`.
4. Put functions in `methods`.
5. Put watchers in `watch`.
6. Use `created` / `mounted` / `beforeUnmount` like sibling screens.
7. Use `this.$route` / `this.$router` (already on the instance).
8. Call Pinia stores as functions (`authUserStore()`, `sessionStore()`, `appDataStore()`) inside methods/lifecycle — same as existing screens.
9. Keep the **template** aligned with siblings: `main-layout`, `vxceed-grid`, `form-control form-control-sm`, `$t()` labels.

**Example — Central Options (correct):**

```js
export default {
  name: 'OutletGrid',
  data() {
    return { loading: false }
  },
  methods: {
    async load() {
      this.loading = true
      // existing serviceApi / api() call
      this.loading = false
    }
  },
  mounted() {
    this.load()
  }
}
```

**Example — Composition (do not add this in Central):**

```js
import { ref, onMounted } from 'vue'
const loading = ref(false)
async function load() {
  loading.value = true
  loading.value = false
}
onMounted(() => { load() })
```

---

## 5. If you are porting a Fuji-Vue3 screen into Central

Convert Composition **to** Options (the opposite of the DMS migration):

| Fuji-Vue3 Composition | Central Options |
|----------------------|-----------------|
| `const x = ref(0)` | `data() { return { x: 0 } }` then `this.x` |
| `const y = computed(() => …)` | `computed: { y() { return … } }` |
| `function save() { … }` | `methods: { save() { … } }` |
| `watch(x, …)` | `watch: { x() { … } }` |
| `onMounted(() => …)` | `mounted() { … }` |
| `defineProps` / `defineEmits` | `props` / `emits` options |
| `useRoute()` / `useRouter()` | `this.$route` / `this.$router` |
| `useI18n()` | `this.$t()` |
| `useXxxStore` + `storeToRefs` | `const store = xxxStore()` in a method |
| `src/composables/useXxx.js` | `src/utils/` helper or methods on the SFC — do not add a composables folder |
| `ejs-grid` / Syncfusion | `vxceed-grid` + `vxceed-column-chooser` |
| `vxceed-form-grid` | **does not exist here** — use the sibling form pattern |

Do not change business rules, API URLs, or TAC ids while converting.

---

## 6. How this keeps the codebase smaller *in this repo*

Central reduces size by **sharing native components and services**, not by extracting composables:

- One `vxceedGrid` / `vxceedTabs` / `NativeDatePicker` — do not add a second UI kit.
- One HTTP factory (`src/service/index.js`) + `serviceApi()` — do not add axios wrappers per screen.
- Pinia only for **shared** app state. Screen filters, paging, and form fields stay in `data()`.
- Delete unused imports/variables (`performance-optimization-rules.mdc`) instead of rewriting the API style.

Composition API does not magically shrink Central files. Mixing both styles **increases** size and breaks the Options-only review bar.

---

## 7. What we do / do not change during a normal screen task

**Do:**
- Write or keep Options API
- Keep the same APIs, UI, `$t()` keys, and test ids
- Use `vxceed*` / `Native*` like siblings
- Convert inbound Fuji-Vue3 `<script setup>` to Options if you must port a companion

**Do not:**
- Migrate Central screens to Composition API
- Turn off vue-i18n legacy mode
- Rewrite Pinia stores in one go
- Add `src/composables/`
- Add Syncfusion / `vxceed-form-grid`
- Redesign the screen "while converting"

---

## 8. One-line takeaway

**Options API** = logic in fixed buckets (`data` / `methods` / …) — **this is Mt-Fuji-Central**.  
**Composition API** = `ref` / `computed` / `<script setup>` — **Fuji-Vue3 only, unless a Central ticket says otherwise**.  
**Why we do not migrate Central** = same behavior, one style across `src/views` and `src/components`, native vxceed screens, and no mixed API tax.
