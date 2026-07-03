# Exemplo: API própria de análise esportiva (com fontes complementares)

Estrutura: coletores de múltiplas fontes -> resolvedor (deduplicação) -> Supabase (Postgres) -> API -> seu site.

```
sports-api-example/
├── config/
│   └── leagues.js           # mapeamento manual: qual liga é qual em cada fonte
├── lib/
│   └── resolver.js          # decide se uma entidade já existe (linka) ou é nova (cria)
├── db/
│   └── schema.sql           # tabelas canônicas + tabelas de mapeamento por fonte
├── scrapers/
│   ├── footballdata.js      # coletor da football-data.org
│   └── thesportsdb.js       # coletor da thesportsdb.com
├── scheduler.js             # roda os dois coletores periodicamente
├── api.js                   # sua API (Express) que o front consome
├── package.json
└── .env.example
```

## Como funciona a deduplicação

Esse é o ponto central do exemplo. Times, ligas e partidas **não pertencem a
uma fonte** — são registros canônicos únicos. Cada fonte só contribui dados
pra esse registro:

```
leagues (canônico)          teams (canônico)           matches (canônico)
  id: 1                       id: 10 "Flamengo"           id: 100
  canonical_key: bsa                                       home: 10, away: 22

league_sources               team_sources                match_sources
  league_id: 1, football-data   team_id: 10, football-data   match_id: 100, football-data, ext: 555
  league_id: 1, thesportsdb      team_id: 10, thesportsdb      match_id: 100, thesportsdb, ext: 891
```

Ou seja: a football-data reporta "Flamengo" (id 555) e a thesportsdb reporta
"CR Flamengo" (id 891) — o `lib/resolver.js` identifica que são o mesmo time
e os dois external_id apontam pra **uma única linha** em `teams`. O mesmo
vale pra partidas: se as duas fontes relatam o jogo Flamengo x Palmeiras do
mesmo dia, ele vira **uma linha** em `matches`, enriquecida por ambas.

### As 3 camadas de matching

1. **Ligas**: mapeamento manual em `config/leagues.js`. Ligas são poucas, então
   compensa garantir 100% de precisão à mão em vez de arriscar um match automático
   errado. Se uma liga não estiver no config, o coletor **pula ela e avisa**
   no console — isso é proposital, evita criar registros soltos por engano.
2. **Times**: primeiro tenta achar pelo `external_id` já linkado (rápido). Se
   for a primeira vez que essa fonte reporta esse time, tenta casar pelo nome
   normalizado (remove acento, minúsculo, remove sufixos tipo "FC"/"EC") dentro
   da mesma liga, com um fallback de distância de Levenshtein pra pequenas
   diferenças de grafia. Se nada bater, cria um time novo.
3. **Partidas**: mesma lógica, casando por liga + mandante + visitante + data
   dentro de uma janela de 12h (fontes às vezes divergem no horário exato).

### O que fazer quando o matching automático erra

Times com nomes muito diferentes entre fontes (ex: "Athletico-PR" vs "Atlético
Paranaense") podem não casar automaticamente e virar dois registros. Quando
isso acontecer, você tem duas opções:
- Rodar um `update team_sources set team_id = X where team_id = Y` manual pra
  unificar, e apagar o registro duplicado
- Ou (melhor a longo prazo) manter uma tabela extra de aliases conhecidos e
  consultá-la no `resolveTeam` antes do fallback de Levenshtein

Isso não tem como ser 100% automático com segurança — o objetivo do resolver
é acertar a grande maioria dos casos e deixar os raros erros fáceis de corrigir.

## Passo a passo

### 1. Crie o projeto no Supabase
- Vá em https://supabase.com, crie um projeto novo (grátis)
- No **SQL Editor**, rode o conteúdo de `db/schema.sql`
- Em **Project Settings > API**, copie a `URL`, a `anon key` e a `service_role key`

### 2. Pegue um token da Football-Data.org
- Crie conta grátis em https://www.football-data.org/client/register
- Copie o token que eles te enviam por email

### 2.1 TheSportsDB (opcional, mas já vem configurado)
- A chave `3` é pública e gratuita, funciona sem cadastro, mas é limitada
- Para produção com mais estabilidade, considere a chave paga via Patreon

### 3. Configure quais ligas você quer coletar
Edite `config/leagues.js` e confira se as ligas que te interessam já estão
mapeadas com os external_id corretos de cada fonte. Adicione novas se precisar.

### 4. Configure o projeto
```bash
cd sports-api-example
npm install
cp .env.example .env
# edite o .env com suas chaves
```

### 5. Rode os coletores manualmente (teste)
```bash
npm run collect            # football-data.org
npm run collect:sportsdb   # thesportsdb.com
```
Rode os dois e depois confira no **Table Editor** do Supabase:
- `teams` deve ter **um** Flamengo, não dois
- `team_sources` deve ter **duas** linhas apontando pro mesmo `team_id` (uma pra cada fonte)

Se aparecer duplicado, veja a seção "O que fazer quando o matching automático erra" acima.

### 6. Rode o agendador (coleta contínua)
```bash
npm run schedule
```
Roda os dois coletores em paralelo, cada um no seu intervalo (10min football-data,
30min thesportsdb). Em produção, isso deve rodar como um **worker separado**
(ex: um serviço no Railway/Render), não junto do servidor da API.

### 7. Rode sua API
```bash
npm run api
```
```
http://localhost:3001/matches/today
http://localhost:3001/standings/brasileirao-serie-a   -- usa o canonical_key, não o external_id de uma fonte
```

### 8. Consuma no frontend
```js
const res = await fetch('http://localhost:3001/matches/today');
const matches = await res.json();
```

## Observações importantes

- **Free tier da football-data.org**: 10 requisições/minuto, e o plano gratuito só libera algumas competições (Brasileirão/BSA está incluso).
- **Chave de teste da TheSportsDB (`3`)**: funciona, mas é compartilhada publicamente — não confie nela pra produção com tráfego real.
- **`sources_sync`**: consulte essa tabela para saber se um coletor está falhando silenciosamente.
- **Adicionar uma terceira fonte** (ex: API-Football): crie `scrapers/api-football.js` chamando `resolveLeague`/`resolveTeam`/`resolveMatch` do `lib/resolver.js` com `source: 'api-football'`, adicione as ligas dela em `config/leagues.js`, e registre no `scheduler.js`. Não precisa mexer no resolvedor.
- **Placar/status em conflito entre fontes**: a regra atual em `resolveMatch` é simples (prefere FINISHED sobre outros status, prefere placar não-nulo). Se você for guardar estatísticas mais ricas por fonte (ex: xG só na football-data), o ideal é uma tabela `match_stats(match_id, source, ...)` separada em vez de sobrescrever campos únicos em `matches`.
