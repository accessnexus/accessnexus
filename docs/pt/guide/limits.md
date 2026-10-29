# Limites e roadmap

O que a v0.1.0 não faz, para você se planejar, e o que vem a seguir. Nada do que está em [Roadmap](#roadmap) está **disponível** hoje.

## Limites atuais (v0.1.0) {#current-limits-v0-1-0}

| Área | Limite | O que fazer |
| --- | --- | --- |
| Adapters | Só Supabase. | Use `adapter: 'supabase'` (o padrão). |
| Modo Database | Gera RLS, triggers, RPCs e o SDK, mas não migrations DDL. | Mantenha suas próprias migrations para as tabelas. |
| Migrations | Geradas a partir de diffs de snapshot; renomeações são detectadas por heurística. | Leia o `diff` antes do push; procure comentários `-- Destructive:`. |
| `push` | Roda numa única transação, então uma migration não pode usar um valor de enum que um statement anterior do mesmo push adicionou (`ALTER TYPE ... ADD VALUE`; o Postgres proíbe). | Faça o push da mudança do enum primeiro, depois do código que usa o novo valor. |
| Identificadores | Emitidos sem aspas: snake_case minúsculo (com um `_` opcional no início), sem palavras reservadas. | Renomeie (`order` → `orders`). |
| Colunas | RLS não consegue restringir quais colunas são lidas ou atualizadas. | `trigger.lockColumns` para escritas; uma tabela separada para leituras privadas. |
| Foreign keys | `ON DELETE NO ACTION`, a menos que `onDelete` diga outra coisa. | Defina `onDelete`. |
| Enums | Cada coluna `enum(...)` ganha seu próprio tipo (`<table>_<column>_enum`). | Faça cast entre eles (`v.role::text::org_members_role_enum`). |
| Grants | RPCs definer não são executáveis por `anon`, a menos que `allowAnon`. Tabelas e RPCs invoker mantêm os grants padrão do Supabase. | O RLS protege as linhas. |
| Retorno de RPC | Só tipos de coluna escalares ou arrays; sem `SETOF` / `TABLE`. | Retorne `jsonb`. |
| Triggers e RPCs removidos | Remover um trigger ou uma RPC do schema não remove o objeto do banco; o `generate` não apaga arquivos de saída obsoletos. (Operações de policy removidas *são* apagadas no próximo `push`.) | Remova funções/triggers antigos e arquivos obsoletos à mão. |
| Seed | Só o mapa `references` no nível da tabela provisiona linhas em `auth.users`. | Declare as referências a usuários ali. |
| `init --db-url` | Importa só o schema `public`; sem constraints `CHECK`, índices não únicos, views, FKs de várias colunas ou colunas geradas. Tipos sem equivalente no AccessNexus viram `text`; triggers com argumentos, desabilitados, `INSTEAD OF`/só `TRUNCATE` ou que não são plpgsql ficam de fora. Cada um deixa um comentário `// WARNING:`. Os triggers importados ganham nomes novos, então os originais precisam ser removidos depois do primeiro `push`. Toda função importada é recriada com `SET search_path = pg_catalog, public` (reportado em `hardenedFunctions`, `// NOTE:` no schema); funções de trigger são sempre `VOLATILE`. | Revise antes do primeiro `generate` ([Projetos existentes](/pt/guide/existing-project)). |
| Primary keys compostas | `compositePrimaryKey` cria a chave, mas `softDelete` e os helpers por id do SDK precisam de um `primaryKey` de uma coluna. | Use uma chave `id` única onde precisar deles. |
| Verificação | O `validate` checa estrutura, não intenção; ele não simula acesso. | Teste suas policies com usuários reais. |
| `diff` | Compara o schema com os arquivos gerados e o snapshot das migrations (`.snapshot.json`), não com o banco real. Mudanças feitas direto no banco (Studio, SQL à mão), inclusive a volatilidade ou as opções `SET` de uma função, ficam invisíveis para ele. | Rode `push --dry-run` contra o banco (ele reporta policies estranhas); um modo `diff --against-db` está planejado. |

## Roadmap {#roadmap}

| Item | Status |
| --- | --- |
| Adapter Supabase, gerador de RLS/RBAC, CLI, SDK tipado, importação via `init` | Lançado na v0.1.0 |
| Adapter Firebase (Firestore Security Rules, Cloud Functions, SDK tipado) | Planejado, não disponível |
| Teste de policies / simulação de acesso (provar que uma policy bloqueia o que deve, como gate de CI) | Planejado, não disponível |
| Servidor MCP para coding agents | Planejado, não disponível |
| `diff --against-db` (comparar o schema com o banco real, não só com o snapshot) | Planejado, não disponível |

Itens planejados não têm data de lançamento. Acompanhe o [CHANGELOG](https://github.com/accessnexus/accessnexus/blob/main/CHANGELOG.md) para saber o que de fato foi lançado.

## Veja também {#related}

- [Modelo de segurança](/pt/guide/security)
- [Projetos existentes](/pt/guide/existing-project)
- [Solução de problemas](/pt/guide/troubleshooting)
- [Feito para agentes de IA](/pt/guide/ai-agents)
