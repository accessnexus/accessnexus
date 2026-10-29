<script setup lang="ts">
import { onMounted, ref } from "vue";

const REPO = "accessnexus/accessnexus";
const CACHE_KEY = "accessnexus:stars";

const stars = ref<number | null>(null);

function format(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

onMounted(async () => {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached !== null) {
      stars.value = Number(cached);
      return;
    }
  } catch {
    // sessionStorage can throw in private mode; the fetch below still works.
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`);
    if (!response.ok) return; // rate limited or private: show the button without a count
    const data = await response.json();
    if (typeof data.stargazers_count !== "number") return;
    stars.value = data.stargazers_count;
    try {
      sessionStorage.setItem(CACHE_KEY, String(data.stargazers_count));
    } catch {
      // ignore
    }
  } catch {
    // offline or blocked: the link still works
  }
});
</script>

<template>
  <a
    class="gh-star"
    :href="`https://github.com/${REPO}`"
    target="_blank"
    rel="noreferrer"
    aria-label="Star AccessNexus on GitHub"
  >
    <svg class="gh-star-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"
      />
    </svg>
    <span class="gh-star-label">Star</span>
    <span v-if="stars !== null" class="gh-star-count">{{ format(stars) }}</span>
  </a>
</template>

<style scoped>
.gh-star {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  margin-left: 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 13px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  color: var(--vp-c-text-2);
  background-color: var(--vp-c-bg-alt);
  transition:
    color 0.25s,
    border-color 0.25s,
    background-color 0.25s;
  white-space: nowrap;
}

.gh-star:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background-color: var(--vp-c-brand-soft);
}

.gh-star-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

.gh-star-count {
  padding-left: 7px;
  border-left: 1px solid var(--vp-c-divider);
  font-variant-numeric: tabular-nums;
}

/* The navbar hides social links on narrow screens; match that behavior. */
@media (max-width: 767px) {
  .gh-star {
    display: none;
  }
}
</style>
