import { defineConfig } from "vitepress";

const REPO = "https://github.com/accessnexus/accessnexus";
const NPM = "https://www.npmjs.com/package/accessnexus";

/** Sidebar entries; `prefix` is "" for English (root) and "/pt" for Portuguese. */
function sidebar(prefix: string, t: Record<string, string>) {
  const g = (slug: string) => `${prefix}/guide/${slug}`;
  const a = (slug: string) => `${prefix}/api/${slug}`;
  return [
    {
      text: t.start,
      items: [
        { text: t.introduction, link: g("introduction") },
        { text: t.quickStart, link: g("quick-start") },
        { text: t.howItWorks, link: g("how-it-works") },
        { text: t.aiAgents, link: g("ai-agents") },
      ],
    },
    {
      text: t.modeling,
      items: [
        { text: t.schema, link: g("schema") },
        { text: t.policies, link: g("policies") },
        { text: t.permissions, link: g("permissions") },
        { text: t.triggers, link: g("triggers") },
        { text: t.rpcs, link: g("rpcs") },
        { text: t.seed, link: g("seed") },
      ],
    },
    {
      text: t.operating,
      items: [
        { text: t.cli, link: g("cli") },
        { text: t.security, link: g("security") },
        { text: t.existingProject, link: g("existing-project") },
        { text: t.cookbook, link: g("cookbook") },
        { text: t.troubleshooting, link: g("troubleshooting") },
        { text: t.limits, link: g("limits") },
      ],
    },
    {
      text: t.reference,
      collapsed: false,
      items: [
        { text: "defineSchema / table", link: a("schema") },
        { text: "policy", link: a("policy") },
        { text: "definePermissions", link: a("permissions") },
        { text: "trigger", link: a("trigger") },
        { text: "rpc", link: a("rpc") },
        { text: "defineSeed / defineConfig", link: a("seed-config") },
        { text: "SupabaseAdapter", link: a("adapter") },
        { text: t.sdk, link: a("sdk") },
        { text: "CLI", link: a("cli") },
        { text: t.errors, link: a("errors") },
      ],
    },
  ];
}

const EN = {
  start: "Getting started",
  introduction: "Introduction",
  quickStart: "Quick start",
  howItWorks: "How it works",
  aiAgents: "Built for AI agents",
  modeling: "Modeling",
  schema: "Schema",
  policies: "Policies",
  permissions: "Permissions & tenants",
  triggers: "Triggers",
  rpcs: "RPCs",
  seed: "Seed",
  operating: "In practice",
  cli: "CLI",
  security: "Security model",
  existingProject: "Existing projects",
  cookbook: "Cookbook",
  troubleshooting: "Troubleshooting",
  limits: "Limits & roadmap",
  reference: "API reference",
  sdk: "Generated SDK",
  errors: "Error codes",
};

const PT = {
  start: "Começando",
  introduction: "Introdução",
  quickStart: "Início rápido",
  howItWorks: "Como funciona",
  aiAgents: "Feito para agentes de IA",
  modeling: "Modelagem",
  schema: "Schema",
  policies: "Policies",
  permissions: "Permissões e tenants",
  triggers: "Triggers",
  rpcs: "RPCs",
  seed: "Seed",
  operating: "Na prática",
  cli: "CLI",
  security: "Modelo de segurança",
  existingProject: "Projetos existentes",
  cookbook: "Receitas",
  troubleshooting: "Solução de problemas",
  limits: "Limites e roadmap",
  reference: "Referência da API",
  sdk: "SDK gerado",
  errors: "Códigos de erro",
};

export default defineConfig({
  title: "AccessNexus",
  base: "/accessnexus/",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  // Private notes kept locally next to the docs are never part of the site.
  srcExclude: ["STRATEGY.md", "FIREBASE_PLAN.md", "supabase-postgres-best-practices/**"],

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/accessnexus/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#6366f1" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "AccessNexus" }],
  ],

  themeConfig: {
    logo: "/logo.svg",
    search: {
      provider: "local",
      options: {
        locales: {
          pt: {
            translations: {
              button: { buttonText: "Buscar", buttonAriaLabel: "Buscar" },
              modal: {
                displayDetails: "Exibir detalhes",
                resetButtonTitle: "Limpar busca",
                backButtonTitle: "Voltar",
                noResultsText: "Nenhum resultado para",
                footer: { selectText: "selecionar", navigateText: "navegar", closeText: "fechar" },
              },
            },
          },
        },
      },
    },
    socialLinks: [
      { icon: "github", link: REPO },
      { icon: "npm", link: NPM },
    ],
  },

  locales: {
    root: {
      label: "English",
      lang: "en-US",
      description:
        "Schema-first access control for Supabase: define tables and rules in TypeScript, get correct RLS, RBAC, migrations and a typed SDK. Built for AI coding agents.",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
          { text: "API", link: "/api/schema", activeMatch: "/api/" },
          { text: "Cookbook", link: "/guide/cookbook" },
          { text: "llms.txt", link: `${REPO}/blob/main/llms.txt` },
        ],
        sidebar: { "/": sidebar("", EN) },
        editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
        footer: {
          message: "Released under the MIT License.",
          copyright: "© 2026-present The AccessNexus Authors",
        },
      },
    },

    pt: {
      label: "Português (BR)",
      lang: "pt-BR",
      link: "/pt/",
      description:
        "Controle de acesso schema-first para Supabase: defina tabelas e regras em TypeScript e receba RLS, RBAC, migrations e um SDK tipado corretos. Feito para agentes de IA.",
      themeConfig: {
        nav: [
          { text: "Guia", link: "/pt/guide/introduction", activeMatch: "/pt/guide/" },
          { text: "API", link: "/pt/api/schema", activeMatch: "/pt/api/" },
          { text: "Receitas", link: "/pt/guide/cookbook" },
          { text: "llms.txt", link: `${REPO}/blob/main/llms.txt` },
        ],
        sidebar: { "/pt/": sidebar("/pt", PT) },
        editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: "Sugerir alteração nesta página" },
        docFooter: { prev: "Anterior", next: "Próxima" },
        outline: { label: "Nesta página" },
        lastUpdated: { text: "Atualizado em" },
        darkModeSwitchLabel: "Aparência",
        lightModeSwitchTitle: "Mudar para tema claro",
        darkModeSwitchTitle: "Mudar para tema escuro",
        sidebarMenuLabel: "Menu",
        returnToTopLabel: "Voltar ao topo",
        langMenuLabel: "Idioma",
        notFound: {
          title: "Página não encontrada",
          quote: "Nenhuma policy permite ver esta página.",
          linkText: "Voltar para o início",
        },
        footer: {
          message: "Publicado sob a licença MIT.",
          copyright: "© 2026-presente The AccessNexus Authors",
        },
      },
    },
  },
});
