<script setup lang="ts">
import { computed, ref } from "vue";
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
    codeLead: "Auth calls wrapped for the planner, FORCE RLS, separate USING and WITH CHECK — every time, for every table.",
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
    codeLead: "Chamadas de auth otimizadas para o planner, FORCE RLS, USING e WITH CHECK separados — sempre, em toda tabela.",
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
      <div class="hero-demo">
        <HeroRls />
      </div>
    </section>

    <!-- Schema → SQL -->
    <section class="block">
      <h2>{{ t.codeTitle }}</h2>
      <p class="sub">{{ t.codeLead }}</p>
      <div class="split">
        <div class="pane">
          <div class="pane-head"><span class="dots"><i /><i /><i /></span>accessnexus.schema.ts</div>
<pre><code><span class="c-k">import</span> { defineSchema, policy, table } <span class="c-k">from</span> <span class="c-s">'accessnexus'</span>;

<span class="c-k">export default</span> defineSchema({
  notes: table({
    columns: { id: <span class="c-s">'uuid'</span>, user_id: <span class="c-s">'uuid'</span>, body: <span class="c-s">'text'</span> },
    primaryKey: <span class="c-s">'id'</span>,
    policies: {
      select: policy.<span class="c-f">isOwner</span>(<span class="c-s">'user_id'</span>),
      insert: policy.<span class="c-f">isOwner</span>(<span class="c-s">'user_id'</span>),
    },
  }),
});</code></pre>
        </div>
        <div class="pane">
          <div class="pane-head"><span class="dots"><i /><i /><i /></span>generated/policies/notes_rls.sql</div>
<pre><code><span class="c-k">ALTER TABLE</span> notes <span class="c-k">ENABLE ROW LEVEL SECURITY</span>;
<span class="c-k">ALTER TABLE</span> notes <span class="c-k">FORCE ROW LEVEL SECURITY</span>;

<span class="c-k">CREATE POLICY</span> <span class="c-s">"accessnexus_notes_select"</span>
  <span class="c-k">ON</span> notes <span class="c-k">FOR SELECT TO</span> authenticated
  <span class="c-k">USING</span> ((<span class="c-k">SELECT</span> auth.<span class="c-f">uid</span>()) = user_id);

<span class="c-k">CREATE POLICY</span> <span class="c-s">"accessnexus_notes_insert"</span>
  <span class="c-k">ON</span> notes <span class="c-k">FOR INSERT TO</span> authenticated
  <span class="c-k">WITH CHECK</span> ((<span class="c-k">SELECT</span> auth.<span class="c-f">uid</span>()) = user_id);</code></pre>
        </div>
      </div>
    </section>

    <!-- Bento -->
    <section class="block">
      <div class="bento">
        <div v-for="(item, i) in t.bento" :key="item.k" class="cell" :class="{ wide: i === 0 || i === 3 || i === 4 }">
          <h3>{{ item.t }}</h3>
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
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding-top: 88px;
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
  font-size: clamp(40px, 7vw, 76px);
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
  max-width: 480px;
  margin-top: 64px;
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
  padding: 32px;
  background: var(--l-card);
  transition: background 0.2s;
}

.cell:hover {
  background: var(--l-code);
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
