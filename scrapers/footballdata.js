/**
 * Coletor: Football-Data.org -> Supabase
 * -----------------------------------------
 * Busca as partidas de uma competição e resolve (via lib/resolver.js) as
 * ligas, times e partidas contra os registros canônicos já existentes,
 * evitando duplicar dados que já vieram de outra fonte.
 *
 * Documentação da API: https://www.football-data.org/documentation/quickstart
 * Free tier: 10 requisições/minuto, cobre ligas como PL, BSA (Brasileirão), etc.
 *
 * Uso: node scrapers/footballdata.js
 */

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
require('dotenv').config();
const { resolveLeague, resolveTeam, resolveMatch } = require('../lib/resolver');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const BASE_URL = 'https://api.football-data.org/v4';
const SOURCE = 'football-data';

// Código da competição na football-data.org (ex: BSA = Brasileirão Série A, PL = Premier League)
const COMPETITION_CODE = process.env.COMPETITION_CODE || 'BSA';

async function fetchFromFootballData(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN },
  });

  if (!res.ok) {
    throw new Error(`Football-Data respondeu ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

async function logSync(status, message = null) {
  await supabase.from('sources_sync').upsert({
    source_name: SOURCE,
    last_synced_at: new Date().toISOString(),
    status,
    message,
  });
}

async function run() {
  console.log(`[football-data] iniciando coleta da competição ${COMPETITION_CODE}...`);

  try {
    // 1. Busca a competição e resolve contra a liga canônica (config/leagues.js).
    // A football-data.org tem dois identificadores: o "code" (BSA, PL...) usado
    // na URL, e um "id" numérico interno. O config/leagues.js usa o CODE por ser
    // mais legível, então é ele que usamos como external_id aqui.
    const competitionData = await fetchFromFootballData(`/competitions/${COMPETITION_CODE}`);
    const league = await resolveLeague(supabase, {
      source: SOURCE,
      externalId: COMPETITION_CODE,
      name: competitionData.name,
      country: competitionData.area?.name,
      logo: competitionData.emblem,
    });

    if (!league) {
      console.log(`[football-data] liga ${COMPETITION_CODE} não mapeada em config/leagues.js — encerrando.`);
      await logSync('ok', 'liga não mapeada, nada coletado');
      return;
    }

    console.log(`[football-data] liga resolvida: ${league.name}`);

    // 2. Busca as partidas dessa competição
    const matchesData = await fetchFromFootballData(`/competitions/${COMPETITION_CODE}/matches`);
    console.log(`[football-data] ${matchesData.matches.length} partidas encontradas`);

    // 3. Para cada partida, resolve os times e a partida contra os registros canônicos
    for (const match of matchesData.matches) {
      const homeTeam = await resolveTeam(supabase, {
        source: SOURCE,
        externalId: match.homeTeam.id,
        name: match.homeTeam.name,
        logo: match.homeTeam.crest,
        leagueId: league.id,
      });

      const awayTeam = await resolveTeam(supabase, {
        source: SOURCE,
        externalId: match.awayTeam.id,
        name: match.awayTeam.name,
        logo: match.awayTeam.crest,
        leagueId: league.id,
      });

      await resolveMatch(supabase, {
        source: SOURCE,
        externalId: match.id,
        leagueId: league.id,
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
        matchDate: match.utcDate,
        status: match.status,
        homeScore: match.score?.fullTime?.home ?? null,
        awayScore: match.score?.fullTime?.away ?? null,
      });
    }

    console.log('[football-data] coleta concluída com sucesso.');
    await logSync('ok');
  } catch (err) {
    console.error('[football-data] erro na coleta:', err.message);
    await logSync('error', err.message);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
