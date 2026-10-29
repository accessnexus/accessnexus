<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useData, withBase } from "vitepress";
import HeroRls from "./HeroRls.vue";

/** Landing page shared by the English and Portuguese homes; copy switches on `lang`. */

const { lang } = useData();
const pt = computed(() => lang.value.startsWith("pt"));
const prefix = computed(() => (pt.value ? "/pt" : ""));
const link = (path: string) => withBase(`${prefix.value}${path}`);

const COPY = {
  en: {
    badge: "v0.1.0 · Built for AI coding agents",
    title: ["Row-level security", "you can trust."],
    lead: "Define tables and access rules in TypeScript. AccessNexus generates correct RLS, RBAC, migrations and a typed SDK for Supabase — in a form your coding agent can't get wrong.",
    start: "Get started",
    why: "Why AccessNexus",
    copied: "Copied",
    codeTitle: "One rule in TypeScript. Correct SQL in Postgres.",
    codeLead: "Write the intent. AccessNexus writes the SQL — and gets right the details that break in production.",
    after: "generated SQL",
    drag: "Drag to compare",
    goods: [
      "ENABLE + FORCE RLS: not even the table owner skips it",
      "(SELECT auth.uid()) is evaluated once per query, not per row",
      "inserts and updates are pinned with WITH CHECK",
      "no delete rule? The policy is dropped: deny-all",
    ],
    bento: [
      { k: "secure", t: "Secure by default", d: "ENABLE + FORCE RLS everywhere. No rule means deny-all. Removing a rule revokes it." },
      { k: "tenant", t: "Multi-tenant RBAC", d: "Org and team roles become policies through recursion-safe SECURITY DEFINER helpers. No self-promotion paths." },
      { k: "agents", t: "Agent-native CLI", d: "llms.txt in the package, an AGENTS.md block, --json output, exit codes 0/1/2 and a fix hint on every error." },
      { k: "validate", t: "Validate before push", d: "Unknown columns, open writes, impersonation and cross-tenant holes are caught before SQL reaches the database." },
      { k: "fast", t: "Fast policies", d: "(SELECT auth.uid()) runs once per query, and policy columns are indexed for you." },
      { k: "drift", t: "Drift-checked pushes", d: "Content-hashed migrations under an advisory lock. Edited history is refused." },
    ],
    agentTitle: "Your agent already knows the rules.",
    agentLead: "init writes the contract into your project's AGENTS.md. The agent edits one schema file, validates, and ships SQL that holds.",
    prompt: "Add a projects table: org members read, admins create and update, only the owner deletes.",
    ctaTitle: "Stop hand-writing policies.",
    ctaLead: "Start with one table. Keep every rule in one file.",
    docs: "Read the docs",
  },
  pt: {
    badge: "v0.1.0 · Feito para agentes de IA",
    title: ["Row-level security", "em que você confia."],
    lead: "Defina tabelas e regras de acesso em TypeScript. O AccessNexus gera RLS, RBAC, migrations e um SDK tipado corretos para o Supabase — num formato que o seu agente não consegue errar.",
    start: "Começar",
    why: "Por que AccessNexus",
    copied: "Copiado",
    codeTitle: "Uma regra em TypeScript. SQL correto no Postgres.",
    codeLead: "Escreva a intenção. O AccessNexus escreve o SQL — e acerta os detalhes que quebram em produção.",
    after: "SQL gerado",
    drag: "Arraste para comparar",
    goods: [
      "ENABLE + FORCE RLS: nem o dono da tabela escapa",
      "(SELECT auth.uid()) avaliado uma vez por consulta, não por linha",
      "insert e update travados com WITH CHECK",
      "sem regra de delete? A policy é removida: tudo negado",
    ],
    bento: [
      { k: "secure", t: "Seguro por padrão", d: "ENABLE + FORCE RLS em tudo. Sem regra, tudo negado. Remover uma regra revoga o acesso." },
      { k: "tenant", t: "RBAC multi-tenant", d: "Papéis de org e time viram policies com helpers SECURITY DEFINER sem recursão. Sem caminho para se autopromover." },
      { k: "agents", t: "CLI nativa para agentes", d: "llms.txt no pacote, bloco no AGENTS.md, saída --json, exit codes 0/1/2 e dica de correção em todo erro." },
      { k: "validate", t: "Valide antes do push", d: "Colunas inexistentes, escrita aberta, personificação e furos entre tenants são pegos antes do SQL chegar ao banco." },
      { k: "fast", t: "Policies rápidas", d: "(SELECT auth.uid()) roda uma vez por consulta, e as colunas das policies ganham índice." },
      { k: "drift", t: "Push com detecção de drift", d: "Migrations com hash de conteúdo sob advisory lock. Histórico editado é recusado." },
    ],
    agentTitle: "Seu agente já conhece as regras.",
    agentLead: "O init escreve o contrato no AGENTS.md do projeto. O agente edita um arquivo de schema, valida e entrega SQL que se sustenta.",
    prompt: "Adicione uma tabela projects: membros da org leem, admins criam e editam, só o dono apaga.",
    ctaTitle: "Pare de escrever policies à mão.",
    ctaLead: "Comece com uma tabela. Mantenha todas as regras num arquivo só.",
    docs: "Ler a documentação",
  },
};

const t = computed(() => (pt.value ? COPY.pt : COPY.en));

/** Lucide-style icon paths per bento cell. */
const ICONS: Record<string, string[]> = {
  secure: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "m9 12 2 2 4-4"],
  tenant: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 7a4 4 0 1 0 0 .01", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  agents: ["m4 17 6-6-6-6", "M12 19h8"],
  validate: ["M21.8 10A10 10 0 1 1 17 3.34", "m9 11 3 3L22 4"],
  fast: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  drift: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9"],
};

type Tok = { t: string; c?: string };
const K = "c-k", S = "c-s", F = "c-f", B = "c-bad";

/** The schema typed live in the "after" pane. */
const TS: Tok[] = [
  { t: "import", c: K }, { t: " { defineSchema, policy, table } " }, { t: "from", c: K }, { t: " " }, { t: "'accessnexus'", c: S }, { t: ";\n\n" },
  { t: "export default", c: K }, { t: " defineSchema({\n  notes: table({\n    columns: { id: " }, { t: "'uuid'", c: S },
  { t: ", user_id: " }, { t: "'uuid'", c: S }, { t: ", body: " }, { t: "'text'", c: S }, { t: " },\n    primaryKey: " }, { t: "'id'", c: S },
  { t: ",\n    policies: {\n      select: policy." }, { t: "isOwner", c: F }, { t: "(" }, { t: "'user_id'", c: S },
  { t: "),\n      insert: policy." }, { t: "isOwner", c: F }, { t: "(" }, { t: "'user_id'", c: S },
  { t: "),\n      update: policy." }, { t: "isOwner", c: F }, { t: "(" }, { t: "'user_id'", c: S },
  { t: "),\n    },\n  }),\n});" },
];
const TOTAL = TS.reduce((n, tok) => n + tok.t.length, 0);

/** What `generate` writes for that schema (trimmed to the policies). */
const SQL: Tok[][] = [
  [{ t: "ALTER TABLE", c: K }, { t: " notes " }, { t: "ENABLE ROW LEVEL SECURITY", c: K }, { t: ";" }],
  [{ t: "ALTER TABLE", c: K }, { t: " notes " }, { t: "FORCE ROW LEVEL SECURITY", c: K }, { t: ";" }],
  [{ t: "CREATE POLICY", c: K }, { t: " " }, { t: '"accessnexus_notes_select"', c: S }, { t: " " }, { t: "ON", c: K }, { t: " notes " }, { t: "FOR SELECT TO", c: K }, { t: " authenticated" }],
  [{ t: "  USING", c: K }, { t: " ((" }, { t: "SELECT", c: K }, { t: " auth." }, { t: "uid", c: F }, { t: "()) = user_id);" }],
  [{ t: "CREATE POLICY", c: K }, { t: " " }, { t: '"accessnexus_notes_insert"', c: S }, { t: " " }, { t: "ON", c: K }, { t: " notes " }, { t: "FOR INSERT TO", c: K }, { t: " authenticated" }],
  [{ t: "  WITH CHECK", c: K }, { t: " ((" }, { t: "SELECT", c: K }, { t: " auth." }, { t: "uid", c: F }, { t: "()) = user_id);" }],
  [{ t: "CREATE POLICY", c: K }, { t: " " }, { t: '"accessnexus_notes_update"', c: S }, { t: " " }, { t: "ON", c: K }, { t: " notes " }, { t: "FOR UPDATE TO", c: K }, { t: " authenticated" }],
  [{ t: "  USING", c: K }, { t: " ((" }, { t: "SELECT", c: K }, { t: " auth." }, { t: "uid", c: F }, { t: "()) = user_id)" }],
  [{ t: "  WITH CHECK", c: K }, { t: " ((" }, { t: "SELECT", c: K }, { t: " auth." }, { t: "uid", c: F }, { t: "()) = user_id);" }],
  [{ t: "DROP POLICY IF EXISTS", c: K }, { t: " " }, { t: '"accessnexus_notes_delete"', c: S }, { t: " " }, { t: "ON", c: K }, { t: " notes;" }],
];
void B;

const typed = ref(TOTAL);
const shownSql = ref(SQL.length);
const typing = computed(() => typed.value < TOTAL);
const typedTokens = computed(() => {
  let left = typed.value;
  const out: Tok[] = [];
  for (const tok of TS) {
    if (left <= 0) break;
    out.push({ t: tok.t.slice(0, left), c: tok.c });
    left -= tok.t.length;
  }
  return out;
});

/** Type the schema, run "generate", then reveal the SQL — once, when the panel scrolls into view. */
function play() {
  typed.value = 0;
  shownSql.value = 0;
  const typer = setInterval(() => {
    typed.value = Math.min(TOTAL, typed.value + 3);
    if (typed.value >= TOTAL) {
      clearInterval(typer);
      setTimeout(() => {
        const reveal = setInterval(() => {
          shownSql.value += 1;
          if (shownSql.value >= SQL.length) clearInterval(reveal);
        }, 110);
      }, 450);
    }
  }, 18);
}

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !compare.value) return;
  typed.value = 0;
  shownSql.value = 0;
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      play();
    }
  }, { threshold: 0.35 });
  io.observe(compare.value);
});

// Before/after comparison: drag anywhere on the panel, or use the keyboard via the range input.
const pos = ref(50);
const compare = ref<HTMLElement | null>(null);
function moveTo(clientX: number) {
  const box = compare.value?.getBoundingClientRect();
  if (!box) return;
  pos.value = Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100));
}
function startDrag(event: PointerEvent) {
  moveTo(event.clientX);
  const move = (e: PointerEvent) => moveTo(e.clientX);
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
}

const INSTALL = "npx accessnexus init --yes";
const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(INSTALL);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    // clipboard blocked: the command is still visible to select
  }
}
</script>

<template>
  <div class="landing">
    <div class="grid-bg" aria-hidden="true" />
    <div class="glow" aria-hidden="true" />

    <!-- Hero -->
    <section class="hero">
      <div class="hero-copy">
        <a class="badge" :href="link('/guide/ai-agents')">
          <span class="badge-dot" />{{ t.badge }}<span class="arrow">→</span>
        </a>
        <h1>
          <span>{{ t.title[0] }}</span>
          <span class="muted">{{ t.title[1] }}</span>
        </h1>
        <p class="lead">{{ t.lead }}</p>
        <div class="actions">
          <a class="btn primary" :href="link('/guide/quick-start')">{{ t.start }}</a>
          <button class="install" type="button" @click="copy">
            <span class="dollar">$</span>
            <code>{{ INSTALL }}</code>
            <span class="copy">{{ copied ? t.copied : "⧉" }}</span>
          </button>
        </div>
      </div>
      <div class="hero-demo">
        <HeroRls />
      </div>
    </section>

    <!-- Before / after -->
    <section class="block versus">
      <div class="versus-copy">
        <h2>{{ t.codeTitle }}</h2>
        <p class="sub left">{{ t.codeLead }}</p>
        <ul class="bug-list">
          <li v-for="g in t.goods" :key="g"><span class="v">✓</span>{{ g }}</li>
        </ul>
        <p class="hint left">↔ {{ t.drag }}</p>
      </div>
      <div class="versus-demo">
      <div
        ref="compare"
        class="compare"
        :style="{ '--pos': pos + '%' }"
        @pointerdown="startDrag"
      >
        <div class="pane before">
          <div class="pane-head"><span class="dots"><i /><i /><i /></span>accessnexus.schema.ts<span class="tag ts">TypeScript</span></div>
<pre><code><template v-for="(tok, i) in typedTokens" :key="i"><span :class="tok.c">{{ tok.t }}</span></template><span v-if="typing" class="caret">▍</span></code></pre>
        </div>
        <div class="pane after">
          <div class="pane-head"><span class="dots"><i /><i /><i /></span>generated/policies/notes_rls.sql<span class="tag good">{{ t.after }}</span></div>
          <div class="gen-cmd"><span class="c-p">$</span> npx accessnexus generate <span v-if="shownSql > 0" class="c-ok">✓</span></div>
<pre><code><template v-for="(line, i) in SQL" :key="i"><span v-if="i < shownSql" class="sql-line"><template v-for="(tok, j) in line" :key="j"><span :class="tok.c">{{ tok.t }}</span></template>
</span></template></code></pre>
        </div>
        <div class="handle" aria-hidden="true"><span class="knob">⟷</span></div>
        <input
          class="range"
          type="range"
          min="0"
          max="100"
          :value="pos"
          :aria-label="t.drag"
          @input="pos = Number(($event.target as HTMLInputElement).value)"
        />
      </div>
      </div>
    </section>

    <!-- Bento -->
    <section class="block">
      <div class="bento">
        <div v-for="(item, i) in t.bento" :key="item.k" class="cell" :class="{ wide: i === 0 || i === 3 || i === 4 }">
          <div class="cell-head">
          <span class="icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path v-for="d in ICONS[item.k]" :key="d" :d="d" />
            </svg>
          </span>
          <h3>{{ item.t }}</h3>
          </div>
          <p>{{ item.d }}</p>
        </div>
      </div>
    </section>

    <!-- Agents -->
    <section class="block agent">
      <div class="agent-copy">
        <h2>{{ t.agentTitle }}</h2>
        <p class="sub left">{{ t.agentLead }}</p>
        <a class="btn ghost" :href="link('/guide/ai-agents')">{{ t.why }} →</a>
      </div>
      <div class="terminal">
        <div class="pane-head"><span class="dots"><i /><i /><i /></span>agent</div>
<pre><code><span class="c-p">›</span> {{ t.prompt }}

<span class="c-m">reading node_modules/accessnexus/llms.txt</span>
<span class="c-m">editing accessnexus.schema.ts</span>
<span class="c-p">$</span> npx accessnexus validate --json
<span class="c-ok">{ "ok": true, "summary": { "errors": 0, "warnings": 0 } }</span>
<span class="c-p">$</span> npx accessnexus generate --json
<span class="c-ok">{ "ok": true, "command": "generate", ... }</span></code></pre>
      </div>
    </section>

    <!-- CTA -->
    <section class="cta">
      <h2>{{ t.ctaTitle }}</h2>
      <p class="sub">{{ t.ctaLead }}</p>
      <div class="actions center">
        <a class="btn primary" :href="link('/guide/quick-start')">{{ t.start }}</a>
        <a class="btn ghost" :href="link('/guide/introduction')">{{ t.docs }}</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing {
  --l-fg: #0a0a0a;
  --l-muted: #666;
  --l-line: rgba(0, 0, 0, 0.08);
  --l-card: #fff;
  --l-code: #fafafa;
  position: relative;
  overflow: hidden;
  font-family: "Geist", var(--vp-font-family-base);
  color: var(--l-fg);
  padding: 0 24px 96px;
}

.dark .landing {
  --l-fg: #ededed;
  --l-muted: #a1a1a1;
  --l-line: rgba(255, 255, 255, 0.1);
  --l-card: #0a0a0a;
  --l-code: #111;
}

.grid-bg {
  position: absolute;
  inset: 0 0 auto;
  height: 820px;
  background-image:
    linear-gradient(var(--l-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--l-line) 1px, transparent 1px);
  background-size: 64px 64px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 0%, #000 40%, transparent 100%);
  pointer-events: none;
}

.glow {
  position: absolute;
  top: -260px;
  left: 50%;
  width: 900px;
  height: 520px;
  transform: translateX(-50%);
  background: radial-gradient(closest-side, rgba(99, 102, 241, 0.28), rgba(6, 182, 212, 0.12), transparent);
  filter: blur(40px);
  pointer-events: none;
}

section {
  position: relative;
  max-width: 1120px;
  margin: 0 auto;
}

.hero {
  display: grid;
  grid-template-columns: 1fr;
  gap: 56px;
  align-items: center;
  padding-top: 88px;
}

.hero-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

@media (min-width: 1000px) {
  .hero {
    grid-template-columns: 1.15fr 1fr;
    padding-top: 112px;
  }

  .hero-copy {
    align-items: flex-start;
    text-align: left;
  }

  .hero-copy .actions {
    justify-content: flex-start;
  }
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border: 1px solid var(--l-line);
  border-radius: 999px;
  font-size: 13px;
  color: var(--l-muted);
  background: var(--l-card);
  text-decoration: none;
  transition: color 0.2s, border-color 0.2s;
}

.badge:hover {
  color: var(--l-fg);
  border-color: var(--l-muted);
}

.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: linear-gradient(120deg, #6366f1, #06b6d4);
}

.arrow {
  transition: transform 0.2s;
}

.badge:hover .arrow {
  transform: translateX(2px);
}

h1 {
  margin: 28px 0 0;
  font-size: clamp(40px, 6vw, 68px);
  line-height: 1.02;
  font-weight: 700;
  letter-spacing: -0.045em;
}

h1 span {
  display: block;
}

h1 .muted {
  background: linear-gradient(180deg, var(--l-fg) 0%, var(--l-muted) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.lead {
  max-width: 640px;
  margin: 24px 0 0;
  font-size: 18px;
  line-height: 1.6;
  color: var(--l-muted);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 36px;
}

.btn {
  display: inline-flex;
  align-items: center;
  height: 44px;
  padding: 0 22px;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 500;
  text-decoration: none;
  transition: opacity 0.2s, background 0.2s, border-color 0.2s;
}

.btn.primary {
  color: var(--l-card);
  background: var(--l-fg);
}

.btn.primary:hover {
  opacity: 0.86;
}

.btn.ghost {
  color: var(--l-fg);
  border: 1px solid var(--l-line);
  background: var(--l-card);
}

.btn.ghost:hover {
  border-color: var(--l-muted);
}

.install {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 16px;
  border: 1px solid var(--l-line);
  border-radius: 8px;
  background: var(--l-card);
  cursor: pointer;
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  color: var(--l-fg);
}

.install code {
  background: none;
  padding: 0;
  font-size: 14px;
  color: inherit;
}

.dollar,
.copy {
  color: var(--l-muted);
}

.hero-demo {
  width: 100%;
  max-width: 460px;
  margin: 0 auto;
}

.block {
  margin-top: 128px;
}

h2 {
  margin: 0;
  border: 0;
  padding: 0;
  text-align: center;
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.1;
  font-weight: 700;
  letter-spacing: -0.035em;
}

.sub {
  max-width: 620px;
  margin: 16px auto 0;
  text-align: center;
  font-size: 17px;
  line-height: 1.6;
  color: var(--l-muted);
}

.sub.left {
  margin-left: 0;
  text-align: left;
}

.split {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  margin-top: 48px;
}

@media (min-width: 900px) {
  .split {
    grid-template-columns: 1fr 1fr;
  }
}

.pane,
.terminal {
  overflow: hidden;
  border: 1px solid var(--l-line);
  border-radius: 12px;
  background: var(--l-code);
}

.pane-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--l-line);
  font-size: 12px;
  color: var(--l-muted);
  font-family: var(--vp-font-family-mono);
}

.dots {
  display: inline-flex;
  gap: 6px;
}

.dots i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--l-line);
}

pre {
  margin: 0;
  padding: 18px 20px;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.7;
  color: var(--l-fg);
}

pre code {
  background: none;
  padding: 0;
  font-size: inherit;
  color: inherit;
}

.c-k { color: #8b5cf6; }
.c-s { color: #0891b2; }
.c-f { color: #4f46e5; }
.c-m { color: var(--l-muted); }
.c-p { color: var(--l-muted); }
.c-ok { color: #059669; }

.dark .c-k { color: #c4b5fd; }
.dark .c-s { color: #67e8f9; }
.dark .c-f { color: #a5b4fc; }
.dark .c-ok { color: #34d399; }

.versus {
  display: grid;
  grid-template-columns: 1fr;
  gap: 40px;
  align-items: center;
}

.versus h2 {
  text-align: left;
}

@media (min-width: 1000px) {
  .versus {
    grid-template-columns: 1fr 2fr;
  }
}

.versus-demo {
  min-width: 0;
}

.bug-list {
  list-style: none;
  margin: 24px 0 0;
  padding: 0;
  font-size: 15px;
  line-height: 1.5;
  color: var(--l-muted);
}

.bug-list li {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.bug-list .v {
  color: #10b981;
  text-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
}

.tag.ts {
  color: #6366f1;
  background: rgba(99, 102, 241, 0.12);
}

.hint.left {
  text-align: left;
  margin-top: 24px;
}

.caret {
  color: #06b6d4;
  text-shadow: 0 0 8px rgba(6, 182, 212, 0.9);
  animation: blink 1s steps(1) infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.gen {
  border-top: 1px dashed var(--l-line);
  opacity: 0.35;
  transition: opacity 0.3s;
}

.gen.on {
  opacity: 1;
}

.gen-cmd {
  padding: 10px 16px 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--l-fg);
}

.sub-head {
  border-bottom: 0;
  padding-bottom: 0;
}

.sql-line {
  animation: line-in 0.25s ease;
}

@keyframes line-in {
  from { text-shadow: 0 0 10px rgba(16, 185, 129, 0.9); }
}

.compare .pane pre {
  font-size: 11.5px;
  padding: 14px 16px;
}

.compare {
  position: relative;
  display: grid;
  grid-template-columns: var(--pos) 1fr;
  border: 1px solid var(--l-line);
  border-radius: 12px;
  overflow: hidden;
  cursor: ew-resize;
  user-select: none;
  touch-action: pan-y;
}

.compare .pane {
  min-width: 0;
  overflow: hidden;
  border: 0;
  border-radius: 0;
}

.compare .pane pre {
  overflow: hidden;
}

.compare .pane-head {
  white-space: nowrap;
}

.compare .after {
  background:
    radial-gradient(ellipse 80% 60% at 100% 0%, rgba(16, 185, 129, 0.08), transparent),
    var(--l-code);
}

.compare .before {
  background:
    radial-gradient(ellipse 80% 60% at 0% 0%, rgba(99, 102, 241, 0.08), transparent),
    var(--l-code);
}

.compare .pane-head {
  position: relative;
}

.tag {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  font-family: "Geist", var(--vp-font-family-base);
}

.tag.bad {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.tag.good {
  color: #10b981;
  background: rgba(16, 185, 129, 0.1);
}

.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--pos);
  width: 1px;
  background: linear-gradient(180deg, transparent, #6366f1 20%, #06b6d4 80%, transparent);
  box-shadow: 0 0 6px rgba(99, 102, 241, 0.8);
  animation: neon-pulse 2.4s ease-in-out infinite;
  pointer-events: none;
}

.knob {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(129, 140, 248, 0.9);
  border-radius: 50%;
  font-size: 13px;
  color: #a5b4fc;
  background: var(--l-card);
  box-shadow: 0 0 10px rgba(99, 102, 241, 0.55);
  animation: neon-pulse 2.4s ease-in-out infinite;
}

.range {
  position: absolute;
  inset: auto 0 0;
  width: 100%;
  opacity: 0;
  pointer-events: none;
}

.range:focus-visible + * {
  outline: none;
}

.compare:has(.range:focus-visible) .knob {
  outline: 2px solid var(--l-fg);
  outline-offset: 3px;
}

.hint {
  margin: 12px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--l-muted);
}

.c-bad { color: #ef4444; }
.dark .c-bad { color: #f87171; }

.cell-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.icon {
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: 1px solid var(--l-line);
  border-radius: 10px;
  color: #6366f1;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(6, 182, 212, 0.08));
  transition: box-shadow 0.3s, color 0.3s;
}

.icon svg {
  width: 18px;
  height: 18px;
  filter: drop-shadow(0 0 6px rgba(99, 102, 241, 0.55));
}

.dark .icon {
  color: #a5b4fc;
}

.dark .icon svg {
  filter: drop-shadow(0 0 6px rgba(129, 140, 248, 0.9)) drop-shadow(0 0 14px rgba(6, 182, 212, 0.45));
}

.cell:nth-child(2)::after { animation-delay: -1.2s; }
.cell:nth-child(3)::after { animation-delay: -2.4s; }
.cell:nth-child(4)::after { animation-delay: -3.6s; }
.cell:nth-child(5)::after { animation-delay: -4.8s; }
.cell:nth-child(6)::after { animation-delay: -6s; }

.icon {
  animation: neon-breathe 3.2s ease-in-out infinite;
}

@keyframes neon-spin {
  to { --neon-angle: 360deg; }
}

@keyframes neon-pulse {
  50% { box-shadow: 0 0 14px rgba(6, 182, 212, 0.85); }
}

@keyframes neon-breathe {
  50% { box-shadow: 0 0 10px rgba(99, 102, 241, 0.35); }
}

@media (prefers-reduced-motion: reduce) {
  .cell::after,
  .icon,
  .handle,
  .knob,
  .caret {
    animation: none;
  }
}

.cell:hover .icon {
  color: #06b6d4;
  box-shadow:
    0 0 14px rgba(99, 102, 241, 0.45),
    0 0 32px rgba(6, 182, 212, 0.25);
}

.bento {
  display: grid;
  grid-template-columns: 1fr;
  border: 1px solid var(--l-line);
  border-radius: 12px;
  overflow: hidden;
  background: var(--l-line);
  gap: 1px;
}

@media (min-width: 760px) {
  .bento {
    grid-template-columns: repeat(3, 1fr);
  }

  .cell.wide {
    grid-column: span 2;
  }
}

.cell {
  position: relative;
  padding: 32px;
  background: var(--l-card);
  transition: background 0.2s;
}

/* Neon edge that lights up on hover. */
.cell::after {
  content: "";
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: inherit;
  background: conic-gradient(from var(--neon-angle), transparent 0 72%, #6366f1 84%, #06b6d4 94%, transparent);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0.45;
  animation: neon-spin 7s linear infinite;
  transition: opacity 0.3s;
  pointer-events: none;
}

.cell:hover {
  background:
    radial-gradient(ellipse 70% 90% at 0% 0%, rgba(99, 102, 241, 0.08), transparent),
    var(--l-code);
}

.cell:hover::after {
  opacity: 1;
}

.cell h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.cell p {
  margin: 10px 0 0;
  font-size: 15px;
  line-height: 1.6;
  color: var(--l-muted);
}

.agent {
  display: grid;
  grid-template-columns: 1fr;
  gap: 40px;
  align-items: center;
}

.agent h2 {
  text-align: left;
}

.agent .btn {
  margin-top: 28px;
}

@media (min-width: 900px) {
  .agent {
    grid-template-columns: 2fr 3fr;
  }
}

.cta {
  margin-top: 144px;
  padding: 72px 24px;
  border: 1px solid var(--l-line);
  border-radius: 16px;
  text-align: center;
  background:
    radial-gradient(ellipse 60% 80% at 50% 0%, rgba(99, 102, 241, 0.14), transparent),
    var(--l-card);
}

.actions.center {
  justify-content: center;
}
</style>
