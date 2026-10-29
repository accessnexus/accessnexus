# Introdução {#introduction}

O AccessNexus (`accessnexus` no npm) é uma **engine schema-first para Supabase**. Você descreve suas tabelas e regras de acesso uma única vez, em TypeScript, e ele gera o SQL de que o seu banco precisa: migrations, policies de Row-Level Security (RLS), checagens de papel, triggers, funções do Postgres (RPCs) e um SDK de client tipado.

Ele não é um ORM e não executa suas queries. Ele compila um schema declarativo em arquivos SQL que você pode ler, commitar e aplicar com push.

## O problema {#the-problem}

No Supabase, o navegador fala direto com o Postgres pela API. O RLS é a única coisa entre a anon key e os seus dados, e é fácil errar:

- **RLS é difícil de escrever do jeito certo.** Policies são SQL verboso cheio de armadilhas sutis: um `auth.uid()` solto avaliado uma vez por linha, checagens de membership que entram em recursão na própria tabela que protegem, helpers `SECURITY DEFINER` sem `search_path` fixado, policies de UPDATE sem `WITH CHECK` que deixam o usuário mover uma linha para fora do próprio alcance.
- **As policies se descolam do código.** Elas vivem num monte de migrations, editadas à mão, sem um lugar único que diga quem pode fazer o quê.
- **Os erros só aparecem em runtime.** Uma policy errada compila normalmente. Você descobre quando um usuário recebe uma lista vazia, ou quando alguém lê linhas que não deveria.

O AccessNexus coloca as regras de acesso ao lado da definição da tabela, compila tudo com as boas práticas do Supabase embutidas e roda checagens estáticas no schema antes que qualquer coisa chegue ao Postgres.

## O que ele gera {#what-it-generates}

A partir de um único `accessnexus.schema.ts`:

| Saída | Detalhes |
| --- | --- |
| Migrations | DDL com timestamp (`<timestamp>__init.sql`, depois `<timestamp>__changes.sql`) mais um `.snapshot.json` usado para calcular o próximo diff |
| Policies de RLS | `ENABLE` + `FORCE ROW LEVEL SECURITY` em toda tabela, `USING` / `WITH CHECK` separados, `(SELECT auth.uid())` encapsulado, literais com escape seguro |
| RBAC | `definePermissions` transforma papéis e tenants em policies, com write pins ligados por padrão |
| Helpers de membership | Funções `SECURITY DEFINER` com `SET search_path = pg_catalog, public`, EXECUTE revogado de `PUBLIC` / `anon` |
| Triggers | `updatedAt`, soft delete, audit log, `lockColumns` (congelamento de colunas) e PL/pgSQL customizado |
| RPCs | Funções do Postgres tipadas; RPCs definer ficam fora do alcance de `anon`, a menos que você libere |
| SDK tipado | `types.ts` + `client.ts` encapsulando o `supabase-js` com acessores por tabela |

Uma tabela sem policies é **deny-all** para a API (fail closed). O `push` aplica o SQL, registra o que foi aplicado e recusa saída desatualizada, migrations editadas e perda de dados não confirmada.

## Para quem é {#who-it-is-for}

- **Projetos Supabase** que querem as regras de acesso revisadas como código, em vez de espalhadas por arquivos SQL.
- **Times que raramente leem SQL.** O schema se lê como uma tabela de permissões; o SQL continua lá para auditoria.
- **Agentes de código com IA** (Claude Code, Cursor, Codex e outros). A maioria dos usuários do AccessNexus o usa por meio de um agente, então o pacote vem com uma referência para agentes (`llms.txt`), o `init` escreve instruções no `AGENTS.md`, e todo comando é não interativo sem TTY, aceita `--json` e retorna error codes estáveis com uma dica de correção. Veja [Feito para agentes de código com IA](/pt/guide/ai-agents).

## Comparado com as alternativas {#compared-with-the-alternatives}

| | SQL à mão | Drizzle `pgPolicy` | AccessNexus |
| --- | --- | --- | --- |
| Onde as regras ficam | Arquivos de migration | Ao lado da tabela do Drizzle, em TypeScript | Ao lado da tabela, em TypeScript |
| Como uma regra é escrita | SQL cru | Expressões SQL cruas passadas para `using` / `withCheck` | Builders semânticos (`policy.isOwner`, `belongsTo`, `definePermissions`) compilados para SQL; `policy.custom` como válvula de escape |
| Encapsular `(SELECT auth.uid())` | Você precisa lembrar | Você escreve (ou usa um helper) | Sempre emitido; o `validate` avisa sobre chamada solta em SQL customizado |
| Checagens de membership sem recursão de RLS | Você escreve a função `SECURITY DEFINER` | Você escreve a função `SECURITY DEFINER` | Geradas, endurecidas e revogadas de `anon` |
| `WITH CHECK` no UPDATE | Fácil de esquecer | Explícito por policy | Sempre emitido com a mesma regra |
| Checagens estáticas de segurança | Nenhuma | Nenhuma para a semântica das policies | `validate`: colunas desconhecidas, escritas abertas, personificação de linha de usuário, parents de outro tenant e mais |
| Congelamento de colunas (RLS é por linha) | Trigger escrito à mão | Trigger escrito à mão | `trigger.lockColumns` |
| Client tipado | `supabase gen types` | Query builder do Drizzle (conexão no servidor) | SDK gerado sobre o `supabase-js` (roda como o usuário logado) |

O Drizzle é um ORM completo e uma ferramenta de migrations; o AccessNexus cobre só o schema, a camada de acesso e um client fino. Escolha pelo que você precisa, não só por esta tabela.

## Quando não usar {#when-not-to-use-it}

- **Você não está no Supabase.** Só existe o adapter do Supabase. O SQL gerado depende de `auth.uid()`, `auth.jwt()` e dos papéis `anon` / `authenticated`. Suporte a Firebase está planejado, não disponível.
- **Seu schema precisa de objetos que o AccessNexus não modela**: views, materialized views, particionamento, extensões ou tipos compostos customizados. Você teria que gerenciar isso por fora.
- **Você quer SQL ajustado à mão em cada migration.** As migrations são geradas a partir de diffs de snapshot; renomeações são detectadas por heurística. Você pode ler e revisar cada arquivo, mas não é você quem os escreve.
- **Suas colunas existentes vêm só dos tipos do Supabase e você também quer DDL.** O [modo Database](/pt/guide/schema#database-mode) gera RLS, triggers, RPCs e o SDK, mas não migrations.

Veja [Limites](/pt/guide/limits) para a lista completa.

## Próximos passos {#next-steps}

- [Início rápido](/pt/guide/quick-start) - instale, defina uma tabela só do dono, gere e faça push
- [Como funciona](/pt/guide/how-it-works) - o pipeline do schema até o SQL e o SDK
- [Feito para agentes de código com IA](/pt/guide/ai-agents) - o fluxo e o contrato para agentes
- [Adotando um projeto existente](/pt/guide/existing-project) - importe tabelas e policies de um banco em produção
