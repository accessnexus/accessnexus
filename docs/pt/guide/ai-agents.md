# Feito para agentes de IA {#built-for-ai-coding-agents}

A maioria dos usuários do AccessNexus nunca digita os comandos: eles pedem ao Claude Code, Cursor, Codex ou outro agente de código para "adicionar uma tabela de comentários que só o autor pode editar", e o agente edita o schema e roda a CLI. O AccessNexus foi desenhado em torno disso: o agente recebe uma referência completa, um contrato de comandos previsível e erros que ele consegue resolver sem chutar.

## O que o agente lê {#what-the-agent-reads}

### `llms.txt`, incluído no pacote {#llms-txt-shipped-in-the-package}

Toda instalação inclui `node_modules/accessnexus/llms.txt`: a referência completa para agentes, versionada junto com o pacote instalado. Ela cobre o modelo mental, o fluxo padrão, a API inteira com exemplos que passam no typecheck contra o código-fonte, receitas (só o dono, leitura pública, multi-tenant com roles, filho de um recurso do tenant, updates restritos a colunas, audit log), as regras de RLS que agentes não podem quebrar, os formatos de saída do `--json` e todos os error codes com a respectiva correção.

Como ela fica em `node_modules`, o agente sempre lê a referência da versão instalada, e não uma página web que pode estar adiantada ou atrasada.

### O bloco no `AGENTS.md` {#the-agents-md-block}

O `init` escreve um bloco curto no `AGENTS.md` do projeto, o arquivo de instruções lido por Codex, Cursor, Gemini CLI, Copilot e outros. Ele diz a qualquer agente, antes de mexer no banco:

- `accessnexus.schema.ts` é a única fonte da verdade: nunca escreva migrations ou policies SQL à mão, nunca edite arquivos gerados;
- depois de cada mudança no schema, rode `validate` → `diff` → `generate`, nessa ordem;
- `push` altera o banco real: antes de qualquer push, rode `diff --against-db --json` (ou `push --dry-run --json`) e revise os `riskyChanges` com o usuário; só dê push quando o usuário pedir, e nunca adicione `--allow-destructive` ou `--seed` sem o OK explícito do usuário;
- toda tabela que o app usa precisa de policies; use `policy.none()` para bloquear uma operação e nunca `enableRLS: false`;
- roles de org/time são `{ scope: 'tenant', roles }`; `policy.hasRole` é uma role global do app;
- prefira builders semânticos a `policy.custom`, e sempre escreva `(SELECT auth.uid())`;
- o que significam os exit codes 0, 1 e 2.

O bloco fica entre marcadores, então pode ser atualizado sem tocar no resto do arquivo:

```md [AGENTS.md]
# AGENTS.md

<!-- accessnexus:start -->
## Database: AccessNexus (accessnexus)

This project's Supabase database — tables, columns, RLS policies, roles, triggers and
RPCs — is defined in TypeScript in `accessnexus.schema.ts` and compiled to SQL by AccessNexus.
Full reference for agents (API, recipes, error codes): `node_modules/accessnexus/llms.txt`.
Read it before changing anything database-related.
...
<!-- accessnexus:end -->
```

| Comportamento | Detalhes |
| --- | --- |
| Idempotente | Rodar `init` de novo substitui o conteúdo entre os marcadores no lugar; tudo fora deles é preservado byte a byte. Uma segunda execução reporta `"agentsMd": "unchanged"` |
| Ainda sem `AGENTS.md` | O `init` cria o arquivo com o bloco |
| `CLAUDE.md` existe | O `init` acrescenta uma linha apontando para o bloco: *"Database work (Supabase tables, RLS policies, triggers, RPCs) goes through AccessNexus — read the AccessNexus section of @AGENTS.md first."* Ele nunca cria o `CLAUDE.md` |
| Desativar | `init --no-agents` pula os dois arquivos |

## O contrato dos comandos {#the-command-contract}

### Nunca trava esperando resposta {#never-blocks-on-a-prompt}

Sem TTY, todo comando roda de forma não interativa. O único comando que faz perguntas é o `init`, e sem TTY ele recusa em vez de ficar travado:

```json
{
  "ok": false,
  "command": "init",
  "version": "0.1.0",
  "error": {
    "code": "INIT_NOT_INTERACTIVE",
    "message": "init asks questions, but there is no terminal to answer them (stdin is not a TTY)",
    "hint": "Re-run with --yes to accept the defaults, e.g. `npx accessnexus init --yes --no-introspect`. Optional: --sdk <dir>, --src <dir>, --prefix <name>, --db-url <url>, --install, --force, --no-agents."
  }
}
```

`init --yes` aceita os padrões, mesmo numa pasta vazia. Toda escolha que ele perguntaria tem uma flag: `--src`, `--sdk`, `--prefix`, `--db-url`, `--no-introspect`, `--install`, `--force`, `--no-agents`.

Conexões com o banco (`push`, `seed`, `init --db-url`) também nunca travam: falham com `DB_CONNECTION_FAILED` depois de 10 segundos (use `ACCESSNEXUS_DB_CONNECT_TIMEOUT=<seconds>` para mudar).

### `--json`: um objeto no stdout {#json-one-object-on-stdout}

Todo comando aceita `--json` e então imprime **exatamente um objeto JSON** no stdout: sem texto de progresso, sem cores. Isso inclui `help --json` e `<command> --help --json`. Todo resultado tem `ok`, `command` e `version`; falhas acrescentam `error` e mantêm qualquer resultado parcial (`issues`, `applied`).

```bash
npx accessnexus validate --json
```

```json
{
  "ok": true,
  "command": "validate",
  "version": "0.1.0",
  "schemaPath": "./accessnexus.schema.ts",
  "mode": "manual",
  "tables": [
    {
      "name": "notes",
      "columns": 5,
      "primaryKey": "id",
      "rls": true,
      "policies": ["select", "insert", "update", "delete"],
      "triggers": [{ "kind": "updated_at", "name": null }]
    }
  ],
  "rpcs": [],
  "issues": [],
  "summary": { "errors": 0, "warnings": 0 }
}
```

O formato completo de cada resultado está na [referência da CLI](/pt/api/cli).

### Exit codes {#exit-codes}

| Código | Significado | O que o agente deve fazer |
| --- | --- | --- |
| `0` | Sucesso | Seguir em frente |
| `1` | Erro corrigível pelo usuário: flag inválida, erro no schema, URL faltando, saída desatualizada, migration destrutiva sem consentimento | Ler `error.code` e `error.hint`, corrigir, tentar de novo |
| `2` | Erro interno (um bug do AccessNexus) | Parar, rodar de novo com `--verbose`, reportar o stack |

Stack traces só aparecem com `--verbose` ou `DEBUG=accessnexus`.

### Erros acionáveis {#actionable-errors}

Todo erro tem um `code` estável, uma mensagem e uma dica. No terminal, a dica aparece como `Fix:`; no JSON, é `error.hint`:

```
✗ Unknown flag "--jsn" for `validate` [UNKNOWN_FLAG]

  Fix: Did you mean --json? Run `npx accessnexus validate --help` for all flags.
```

Comandos e flags desconhecidos são erros com uma dica de "você quis dizer", nunca ignorados em silêncio. Problemas no schema falham com `SCHEMA_VALIDATION_FAILED` e listam cada problema em `issues[]`, com o caminho exato a alterar:

```json
{
  "severity": "error",
  "code": "UNKNOWN_COLUMN",
  "path": "tasks.policies.insert",
  "message": "policy.isOwner column \"usr_id\" is not a column of \"tasks\"",
  "hint": "Use one of: id, org_id, user_id, status — or add \"usr_id\" to tasks.columns."
}
```

Warnings vêm com `"severity": "warning"`. Vários deles apontam brechas de segurança (`PUBLIC_WRITE`, `USER_ROW_INSERT_OPEN`, `TENANT_PARENT_UNCHECKED`, `RLS_DISABLED`), então trate-os como bugs, a menos que o usuário tenha pedido esse comportamento. Veja [Erros](/pt/api/errors) para todos os códigos.

## O loop recomendado para o agente {#the-recommended-agent-loop}

```bash
# 1. Edite accessnexus.schema.ts (nunca o SQL gerado)

# 2. Checagens estáticas: corrija todo issue com severity "error", trate warnings como bugs
npx accessnexus validate --json

# 3. Revise o SQL que vai mudar. Rode ANTES do generate:
#    ele compara o schema com os arquivos em disco
npx accessnexus diff --json

# 4. Escreva o SQL e o SDK (created / updated / unchanged por arquivo)
npx accessnexus generate --json

# 5. O que o push mudaria DE FATO no banco: ensaiado numa transação
#    desfeita, nada persiste. Revise os riskyChanges com o usuário.
npx accessnexus diff --against-db --json     # ou: push --dry-run --json (livePlan)

# 6. Só aplique quando o usuário pedir
npx accessnexus push --json
```

O `diff --json` (passo 3) compara o schema com os arquivos gerados; ele não enxerga o que está no banco. O `diff --against-db` enxerga: lista cada tabela, coluna, policy, trigger, função e grant que seria adicionado, removido ou modificado, com `before`/`after`, e marca `riskyChanges` como uma função passando de `STABLE` para `VOLATILE`, um `SET search_path` perdido, uma policy ampliada de `authenticated` para `public`, uma policy removida ou um default de coluna perdido. O agente deve mostrar isso ao usuário antes do push. Um push que o Postgres rejeitaria volta como `PUSH_WOULD_FAIL`, com o arquivo e o erro SQL, e nada foi persistido.

::: warning Pare e pergunte ao usuário
Se o `diff --against-db` reportar `riskyChanges` ou `blockers`, ou se `generate`, `diff` ou `push --dry-run` reportarem statements `destructive`, o agente deve dizer ao usuário quais dados seriam perdidos e esperar. `--allow-destructive` e `--seed` exigem o OK explícito do usuário. Uma renomeação vai no schema como renomeação, não como remover + adicionar.
:::

No CI, `npx accessnexus diff --check` sai com `1` quando alguém mudou o schema sem regenerar.

::: danger Corrigindo um erro de permissão do jeito errado
Quando o app recebe um erro de RLS ou um resultado vazio, o agente pode cair na tentação de "corrigir" removendo policies, adicionando `enableRLS: false` ou usando `policy.public()` numa escrita. As três coisas abrem a tabela. A correção é uma regra certa: por exemplo, uma regra de `select` que também admita as linhas que o usuário acabou de inserir, já que o `create` do SDK retorna a linha. A lista completa de regras está no `llms.txt`, em "RLS rules agents must not break", e no [Modelo de segurança](/pt/guide/security).
:::

## Um prompt para dar ao seu agente {#a-prompt-to-give-your-agent}

Cole isto no Claude Code, Cursor ou Codex no início de uma tarefa de banco:

```text
This project uses AccessNexus for its Supabase database. Before changing anything
database-related, read node_modules/accessnexus/llms.txt and the AccessNexus block in AGENTS.md.

Task: add a `comments` table. Each comment belongs to a post and has an author.
Anyone who can read the post can read its comments; only the author can edit or delete
their comment, and nobody can change a comment's post or author after creating it.

Rules:
- Change only accessnexus.schema.ts. Never edit generated SQL.
- Run `npx accessnexus validate --json`, then `diff --json`, then `generate --json`.
  Fix every error and explain every warning you keep.
- Run `npx accessnexus diff --against-db --json` and show me the changes and
  riskyChanges. Do not push,
  do not use --allow-destructive or --seed, until I say so.
- Summarize the access rules you wrote in plain English.
```

Pedir um resumo das regras em linguagem simples é a revisão mais barata que você pode fazer sem ler SQL.

## Próximos passos {#next-steps}

- [Início rápido](/pt/guide/quick-start) - o mesmo loop, feito à mão
- [CLI](/pt/guide/cli) - todos os comandos e flags
- [Erros](/pt/api/errors) - todos os error codes e issue codes, com correções
- [Modelo de segurança](/pt/guide/security) - o que o SQL gerado garante
