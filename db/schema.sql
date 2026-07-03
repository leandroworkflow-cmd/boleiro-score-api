-- ===========================================
-- Schema v2: dados canônicos + mapeamento de fontes
-- -------------------------------------------------
-- A ideia central: "leagues", "teams" e "matches" guardam UM registro
-- por entidade real (não um por fonte). As tabelas "*_sources" ligam
-- o external_id de cada fonte (football-data, thesportsdb, etc) ao
-- registro canônico correspondente. Assim, várias fontes contribuem
-- para o MESMO time/liga/partida em vez de duplicar.
-- Rode isso no SQL Editor do Supabase (ou via psql)
-- ===========================================

-- -------- LIGAS --------

create table if not exists leagues (
  id            serial primary key,
  canonical_key text unique not null,  -- chave estável definida por você, ex: 'brasileirao-serie-a'
  name          text not null,
  country       text,
  logo          text,
  created_at    timestamptz default now()
);

create table if not exists league_sources (
  id           serial primary key,
  league_id    integer not null references leagues(id) on delete cascade,
  source       text not null,          -- 'football-data' | 'thesportsdb' | ...
  external_id  text not null,          -- id da liga nessa fonte específica
  source_name  text,                   -- nome bruto que a fonte usa (útil pra debug)
  unique (source, external_id)
);

-- -------- TIMES --------

create table if not exists teams (
  id               serial primary key,
  league_id        integer references leagues(id),
  name             text not null,
  short_name       text,
  logo             text,
  normalized_name  text not null,      -- nome normalizado, usado pra casar times entre fontes
  created_at       timestamptz default now()
);

create index if not exists idx_teams_normalized on teams(league_id, normalized_name);

create table if not exists team_sources (
  id           serial primary key,
  team_id      integer not null references teams(id) on delete cascade,
  source       text not null,
  external_id  text not null,
  source_name  text,
  unique (source, external_id)
);

-- -------- PARTIDAS --------

create table if not exists matches (
  id           serial primary key,
  league_id    integer references leagues(id),
  home_team_id integer references teams(id),
  away_team_id integer references teams(id),
  match_date   timestamptz not null,
  status       text not null,          -- SCHEDULED | LIVE | FINISHED | POSTPONED
  home_score   integer,
  away_score   integer,
  minute       integer,
  updated_at   timestamptz default now()
);

create index if not exists idx_matches_date on matches(match_date);
create index if not exists idx_matches_status on matches(status);
create index if not exists idx_matches_lookup on matches(league_id, home_team_id, away_team_id, match_date);

create table if not exists match_sources (
  id           serial primary key,
  match_id     integer not null references matches(id) on delete cascade,
  source       text not null,
  external_id  text not null,
  source_name  text,
  unique (source, external_id)
);

-- -------- TABELA DE CLASSIFICAÇÃO --------

create table if not exists standings (
  league_id    integer references leagues(id),
  team_id      integer references teams(id),
  position     integer,
  played       integer,
  won          integer,
  draw         integer,
  lost         integer,
  points       integer,
  updated_at   timestamptz default now(),
  primary key (league_id, team_id)
);

create index if not exists idx_standings_league on standings(league_id);

-- -------- CONTROLE DE SINCRONIZAÇÃO --------

create table if not exists sources_sync (
  source_name     text primary key,
  last_synced_at  timestamptz,
  status          text,               -- ok | error
  message         text
);
