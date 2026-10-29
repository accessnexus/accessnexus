<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useData } from "vitepress";

/**
 * Hero demo of row-level security. The same query runs as different viewers;
 * the one-line rule from the schema decides which rows each of them gets back.
 * Rows outside the viewer's tenant fade out behind a lock. Frozen under
 * prefers-reduced-motion.
 */

const CYCLE_MS = 3600;

const ROWS = [
  { id: "p-01", name: "Website redesign", org: "acme" },
  { id: "p-02", name: "Q3 roadmap", org: "globex" },
  { id: "p-03", name: "Billing migration", org: "acme" },
  { id: "p-04", name: "Mobile app", org: "initech" },
  { id: "p-05", name: "Data warehouse", org: "globex" },
  { id: "p-06", name: "Onboarding flow", org: "acme" },
];

const VIEWERS = [
  { who: "alice", org: "acme", role: "admin" },
  { who: "bob", org: "globex", role: "member" },
  { who: "anon", org: null, role: null },
  { who: "carol", org: "initech", role: "member" },
] as const;

const { lang } = useData();
const pt = computed(() => lang.value.startsWith("pt"));

const step = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  timer = setInterval(() => {
    step.value = (step.value + 1) % VIEWERS.length;
  }, CYCLE_MS);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const viewer = computed(() => VIEWERS[step.value]);
const visible = (org: string) => viewer.value.org === org;
const count = computed(() => ROWS.filter((r) => visible(r.org)).length);

const viewerLabel = computed(() => {
  const v = viewer.value;
  if (!v.org) return pt.value ? "anônimo" : "anonymous";
  return `${v.who} · ${v.org} (${v.role})`;
});

const resultLabel = computed(() => {
  if (count.value === 0) return pt.value ? "0 linhas · negado por padrão" : "0 rows · denied by default";
  const n = count.value;
  if (pt.value) return n === 1 ? "1 linha visível" : `${n} linhas visíveis`;
  return n === 1 ? "1 row visible" : `${n} rows visible`;
});
</script>

<template>
  <div class="rls-demo" aria-hidden="true">
    <div class="rls-card">
      <div class="rls-rule">
        <span class="rls-file">accessnexus.schema.ts</span>
        <code><span class="k">read</span>: { <span class="k">scope</span>: <span class="s">'tenant'</span> }</code>
      </div>
      <div class="rls-query">
        <code><span class="kw">select</span> * <span class="kw">from</span> projects</code>
        <span class="rls-as">
          <span class="rls-as-label">{{ pt ? "como" : "as" }}</span>
          <Transition name="swap" mode="out-in">
            <span :key="step" class="rls-viewer" :class="{ anon: !viewer.org }">{{ viewerLabel }}</span>
          </Transition>
        </span>
      </div>

      <ul class="rls-rows">
        <li v-for="row in ROWS" :key="row.id" class="rls-row" :class="{ hidden: !visible(row.org) }">
          <span class="rls-id">{{ row.id }}</span>
          <span class="rls-name">{{ row.name }}</span>
          <span class="rls-org">{{ row.org }}</span>
          <svg class="rls-lock" viewBox="0 0 16 16">
            <path
              fill="currentColor"
              d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4zm1.5 0h5V5a2.5 2.5 0 0 0-5 0v2z"
            />
          </svg>
        </li>
      </ul>

      <div class="rls-footer">
        <span class="rls-dot" :class="{ empty: count === 0 }" />
        <Transition name="swap" mode="out-in">
          <span :key="step">{{ resultLabel }}</span>
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rls-demo {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 440px;
  margin: 0 auto;
  font-size: 13px;
}

.rls-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12);
}

.rls-rule {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 2px 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  border-radius: 12px 12px 0 0;
}

.rls-file {
  font-size: 11px;
  color: var(--vp-c-text-3);
}

.rls-rule code,
.rls-query code {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  background: none;
  padding: 0;
  color: var(--vp-c-text-1);
}

.k {
  color: var(--vp-c-brand-1);
}

.s {
  color: #0891b2;
}

.dark .s {
  color: #67e8f9;
}

.kw {
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.rls-query {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.rls-as {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}

.rls-as-label {
  color: var(--vp-c-text-3);
}

.rls-viewer {
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.rls-viewer.anon {
  color: var(--vp-c-text-2);
  background: var(--vp-c-default-soft);
}

.rls-rows {
  list-style: none;
  margin: 0;
  padding: 6px 0;
}

.rls-row {
  position: relative;
  display: grid;
  grid-template-columns: 44px 1fr auto;
  gap: 10px;
  padding: 6px 14px;
  color: var(--vp-c-text-1);
  transition:
    opacity 0.5s ease,
    filter 0.5s ease;
}

.rls-id,
.rls-org {
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
}

.rls-org {
  padding-right: 22px;
}

.rls-lock {
  position: absolute;
  right: 14px;
  top: 50%;
  width: 13px;
  height: 13px;
  transform: translateY(-50%);
  color: var(--vp-c-text-3);
  opacity: 0;
  transition: opacity 0.5s ease;
}

.rls-row.hidden {
  opacity: 0.28;
  filter: blur(1.5px);
}

.rls-row.hidden .rls-lock {
  opacity: 1;
  filter: none;
}

.rls-footer {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}

.rls-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #10b981;
  transition: background 0.3s;
}

.rls-dot.empty {
  background: #f59e0b;
}

.swap-enter-active,
.swap-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}

.swap-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .rls-row,
  .rls-lock,
  .swap-enter-active,
  .swap-leave-active {
    transition: none;
  }
}
</style>
