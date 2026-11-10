# Limites e roadmap

O que a v0.4.1-next não faz, para você se planejar, e o que vem a seguir. Nada do que está em [Roadmap](#roadmap) está **disponível** hoje.

## Limites atuais (v0.4.1-next) {#current-limits-v0-1-0}

| Área | Limite | O que fazer |
| --- | --- | --- |
| Adapters | Só Supabase. | Use `adapter: 'supabase'` (o padrão). |
| Modo Database | Gera RLS, triggers, RPCs e o SDK, mas não migrations DDL. | Mantenha suas próprias migrations para as tabelas. |
| Migrations | Geradas a partir de diffs de snapshot; renomeações são detectadas por heurística. Uma coluna `NOT NULL` nova sem default falha numa tabela com linhas (`generate` / `diff` avisam `NOT_NULL_COLUMN_ADDED`; o plano ao vivo e o `push` param com `NOT_NULL_ON_NON_EMPTY_TABLE`). Backfills são SQL que você mesmo escreve. | Leia o `diff` antes do push; procure comentários `-- Destructive:`. Para dados: adicione a coluna como nullable, use `migration data <name>` para o backfill e depois torne-a obrigatória (veja a [receita](/pt/guide/cookbook#required-column-on-a-table-with-data)); `migration discard` substitui uma migration que o banco nunca aplicou. |
| Nomes de índice | Nomeados pelo conteúdo (`idx_<table>_<columns>[_uniq]`), não pela posição. Schemas anteriores à 0.4.1 ganham uma migration que renomeia os nomes antigos por posição (`ALTER INDEX ... RENAME`, nunca apaga e recria) e remove índices de foreign key que um índice declarado já cobre. | Revise essa migration antes do primeiro `push` depois de atualizar. |
| `push` | Roda numa única transação, então uma migration não pode usar um valor de enum que um statement anterior do mesmo push adicionou (`ALTER TYPE ... ADD VALUE`; o Postgres proíbe). | Faça o push da mudança do enum primeiro, depois do código que usa o novo valor. |
| Identificadores | Emitidos sem aspas: snake_case minúsculo (com um `_` opcional no início), sem palavras reservadas. | Renomeie (`order` → `orders`). |
| Colunas | RLS não consegue restringir quais colunas são lidas ou atualizadas. | `trigger.lockColumns` para escritas; uma tabela separada para leituras privadas. |
| Foreign keys | `ON DELETE NO ACTION`, a menos que `onDelete` diga outra coisa. | Defina `onDelete`. |
| Enums | Cada coluna `enum(...)` ganha seu próprio tipo (`<table>_<column>_enum`). | Faça cast entre eles (`v.role::text::org_members_role_enum`), ou compartilhe um tipo com [`defineEnum`](/pt/api/tenancy#defineenum). |
| Grants | RPCs definer não são executáveis por `anon`, a menos que `allowAnon`, e são sempre executáveis por `authenticated` (nenhuma opção nega). Tabelas e RPCs invoker mantêm os grants padrão do Supabase. O `init --db-url` mantém `anon` onde a origem permitia (`anonExecutableFunctions`). | O RLS protege as linhas. Cheque quem chama no corpo das definer. |
| Retorno de RPC | Tipos de coluna escalares ou arrays, `{ table }` (`RETURNS TABLE`) e `{ setof }`. Resultados compostos ou `record`, parâmetros `OUT` e argumentos de tipo composto não podem ser expressos. | Retorne `jsonb`, ou declare o resultado com `{ table }` / `{ setof }`. Veja [tipos de retorno de RPC](/pt/api/rpc#return-types). |
| `tenantInvitations` | Concede por listas de papéis (`inviterRoles`): regras mais finas, como limite de assentos ou domínios de e-mail permitidos, não vêm prontas. | Use uma tabela própria, ou envolva o `accept_invitation` numa RPC sua. |
| `onAuthUserCreated` | O trigger mora em `auth.users`, então remover o builder do schema não o apaga. | Apague o trigger à mão. |
| Triggers e RPCs removidos | Remover um trigger ou uma RPC do schema não remove o objeto do banco; o `generate` não apaga arquivos de saída obsoletos. (Operações de policy removidas *são* apagadas no próximo `push`.) | Remova funções/triggers antigos e arquivos obsoletos à mão. |
| Seed | Só o mapa `references` no nível da tabela provisiona linhas em `auth.users`. | Declare as referências a usuários ali. |
| `init --db-url` | Importa só o schema `public`; sem constraints `CHECK`, índices não únicos, views, FKs de várias colunas ou colunas geradas. Tipos sem equivalente no AccessNexus viram `text`; triggers com argumentos, desabilitados, `INSTEAD OF`/só `TRUNCATE` ou que não são plpgsql ficam de fora. Cada um deixa um comentário `// WARNING:`. Os triggers importados ganham nomes novos, então os originais precisam ser removidos depois do primeiro `push` (o `--replace-foreign-triggers` remove os triggers, nunca as funções deles: veja `keptTriggerFunctions`). Toda função importada é recriada com `SET search_path = pg_catalog, public` (reportado em `hardenedFunctions`, `// NOTE:` no schema); funções de trigger são sempre `VOLATILE`. | Revise antes do primeiro `generate` ([Projetos existentes](/pt/guide/existing-project)). |
| Primary keys compostas | `compositePrimaryKey` cria a chave, mas `softDelete` e os helpers por id do SDK precisam de um `primaryKey` de uma coluna. | Use uma chave `id` única onde precisar deles. |
| Realtime | Os filtros do Postgres Changes aceitam uma coluna (limite do Realtime); eventos DELETE não passam pelo filtro do RLS e `old` traz só a primary key. Tópicos de canal têm no máximo um parâmetro final, e os payloads de Broadcast não são tipados. Policies em `realtime.messages` que o `init --db-url` encontra são listadas, não importadas. | Filtre o resto no client; busque as linhas de novo pela chave; porte as policies de canal importadas para `channel()`. |
| Edge Functions | As funções declaradas ganham wrappers, scaffolds, `verify_jwt` e acessores no SDK; o deploy é `supabase functions deploy`. Os inputs são só JSON via POST, e os outputs são tipados mas não validados em runtime. Uma função removida do schema mantém a pasta. | Faça o deploy com o Supabase CLI; apague à mão as pastas de funções removidas. |
| Verificação | O `validate` checa estrutura, não intenção; ele não simula acesso. O `validate --against-db` só prova que o Postgres aceita o SQL. | Teste suas policies contra um banco real com o [kit de testes de RLS](/pt/guide/testing), ou com usuários reais. |
| `diff --against-db` | Cobre as tabelas gerenciadas e as funções que o SQL gerado define ou que os triggers gerenciados chamam, não outros objetos (tipos enum, extensões, outros schemas). Reflete o que o `push` faz: uma migration já aplicada ou um arquivo de policy/trigger/RPC inalterado é pulado, então um drift feito direto no banco depois de um push não é desfeito pelo `push` e não aparece no plano. O ensaio executa o SQL numa transação, então pega por um instante os mesmos locks que um push pegaria. | Rode antes de todo push; para drift num arquivo que o push pula, mude o schema para que o arquivo seja regerado. |

## Roadmap {#roadmap}

| Item | Status |
| --- | --- |
| Adapter Supabase, gerador de RLS/RBAC, CLI, SDK tipado, importação via `init` | Lançado na v0.1.0 |
| Adapter Firebase (Firestore Security Rules, Cloud Functions, SDK tipado) | Planejado, não disponível |
| Teste de policies contra um Postgres real (`accessnexus/testing`, `test-db`): veja [Testando RLS](/pt/guide/testing) | Lançado |
| Simulação de acesso sem banco (provar que uma policy bloqueia o que deve, como gate de CI) | Planejado, não disponível |
| Servidor MCP para coding agents | Planejado, não disponível |

Itens planejados não têm data de lançamento. Acompanhe o [CHANGELOG](https://github.com/accessnexus/accessnexus/blob/main/CHANGELOG.md) para saber o que de fato foi lançado.

## Veja também {#related}

- [Modelo de segurança](/pt/guide/security)
- [Projetos existentes](/pt/guide/existing-project)
- [Solução de problemas](/pt/guide/troubleshooting)
- [Feito para agentes de IA](/pt/guide/ai-agents)
