---
layout: home

hero:
  name: AccessNexus
  text: Row-level security em que você pode confiar
  tagline: Defina tabelas e regras de acesso em TypeScript. Receba RLS, RBAC, migrations e um SDK tipado corretos para o Supabase — num formato que o seu agente de IA não consegue errar.
  actions:
    - theme: brand
      text: Início rápido
      link: /pt/guide/quick-start
    - theme: alt
      text: Por que AccessNexus
      link: /pt/guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/accessnexus/accessnexus

features:
  - title: Regras de acesso como código
    details: Um único arquivo de schema é a fonte da verdade para tabelas, policies, papéis, triggers e RPCs. As regras ficam junto do modelo de dados, e não espalhadas em migrations SQL.
    link: /pt/guide/schema
    linkText: Modelar um schema
  - title: Seguro por padrão
    details: ENABLE + FORCE RLS em toda tabela, tudo negado quando não há regra, USING e WITH CHECK separados, colunas de dono e tenant travadas na escrita, helpers SECURITY DEFINER blindados.
    link: /pt/guide/security
    linkText: Modelo de segurança
  - title: RBAC multi-tenant
    details: definePermissions transforma pertencimento a orgs/times e papéis em policies — com checagem de membership sem recursão e sem caminho para se autopromover.
    link: /pt/guide/permissions
    linkText: Permissões e tenants
  - title: Policies rápidas
    details: As chamadas de auth viram (SELECT auth.uid()), avaliadas uma vez por consulta, e as colunas usadas nas policies ganham índice automaticamente.
    link: /pt/guide/how-it-works
    linkText: Como funciona
  - title: Feito para agentes de IA
    details: Inclui llms.txt, escreve um bloco no AGENTS.md, nunca pergunta nada sem TTY, imprime um único JSON com --json e falha com código e dica de correção.
    link: /pt/guide/ai-agents
    linkText: Fluxo do agente
  - title: Valide antes de aplicar
    details: Checagens estáticas pegam colunas inexistentes, escrita aberta, personificação, furos entre tenants e erros de digitação antes de o SQL chegar ao banco. O push detecta drift.
    link: /pt/guide/cli
    linkText: Tour da CLI
---

## Do schema ao banco seguro em quatro comandos

```bash
npx accessnexus init --yes
```

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    indexes: [{ columns: ['user_id'] }],
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
});
```

```bash
npx accessnexus validate   # checagens estáticas: colunas, regras, armadilhas de segurança
npx accessnexus generate   # migrations, policies RLS, triggers, RPCs e SDK tipado
npx accessnexus push       # aplica no banco do Supabase, com detecção de drift
```

Agora cada usuário lê e escreve só as próprias notas — garantido pelo Postgres, não pelo código da sua aplicação.

## Deixe o seu agente fazer

Peça ao Claude Code, Cursor ou Codex:

> Use o AccessNexus (leia `node_modules/accessnexus/llms.txt`). Adicione uma tabela `projects` em que membros da org podem ler, admins podem criar e editar, e só o dono pode apagar. Rode `validate --json` até ficar limpo e depois `generate`.

O pacote traz uma referência completa para agentes, e o `init` escreve no `AGENTS.md` do seu projeto as regras que o agente deve seguir. Veja [Feito para agentes de IA](/pt/guide/ai-agents).
