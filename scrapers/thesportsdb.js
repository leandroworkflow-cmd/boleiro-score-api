/**
 * Coletor: TheSportsDB -> Supabase
 * -----------------------------------------
 * Busca liga, times e partidas da temporada e resolve (via lib/resolver.js)
 * contra os mesmos registros canônicos que o coletor da football-data.org
 * usa — ou seja, o Flamengo daqui vira o MESMO registro do Flamengo de lá.
 *
 * Documentação: https://www.thesportsdb.com/free_sports_api
 * Chave de teste gratuita: "3" (limitada). Para produção, assine a chave
 * Patreon (https://www.patreon.com/thesportsdb) e use em THESPORTSDB_KEY.
 *
 * Uso: node scrapers/thesportsdb.js
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const { resolveLeague, resolveTeam, resolveMatch } = require('../lib/resolver');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const THESPORTSDB_KEY = process.env.THESPORTSDB_KEY || '3'; // "3" é a chave pública de teste
const BASE_URL = `https://www.thesportsdb.com/api/v1/json/${THESPORTSDB_KEY}`;
const SOURCE = 'thesportsdb';

// ID da liga na TheSportsDB (ex: 4351 = Brasileirão Série A, 4328 = Premier League)
// Para achar o ID de outra liga: BASE_URL/search_all_leagues.php?c=Brazil
const LEAGUE_ID = process.env.THESPORTSDB_LEAGUE_ID || '4351';
const SEASON = process.env.THESPORTSDB_SEASON || '2025-2026';

async function fetchFromSportsDB(path) {
  const res = await fetch(`${BASE_URL}${path}`);

  if (!res.ok) {
    throw new Error(`TheSportsDB respondeu ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

// Mapeia o status textual da TheSportsDB para o padrão que já usamos
function mapStatus(event) {
  const raw = (event.strStatus || '').toUpperCase();
  if (raw === 'MATCH FINISHED' || raw === 'FT') return 'FINISHED';
  if (raw === 'NOT STARTED' || raw === '') return 'SCHEDULED';
  if (raw === 'POSTPONED') return 'POSTPONED';
  if (raw) return 'LIVE'; // qualquer outra coisa (1H, 2H, HT...) tratamos como ao vivo
  return 'SCHEDULED';
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
  console.log(`[thesportsdb] iniciando coleta da liga ${LEAGUE_ID}, temporada ${SEASON}...`);

  try {
    // 1. Busca metadados da liga e resolve contra a liga canônica (config/leagues.js)
    const leagueData = await fetchFromSportsDB(`/lookupleague.php?id=${LEAGUE_ID}`);
    const rawLeague = leagueData.leagues?.[0];
    if (!rawLeague) throw new Error('Liga não encontrada na TheSportsDB');

    const league = await resolveLeague(supabase, {
      source: SOURCE,
      externalId: LEAGUE_ID,
      name: rawLeague.strLeague,
      country: rawLeague.strCountry,
      logo: rawLeague.strBadge || rawLeague.strLogo,
    });

    if (!league) {
      console.log(`[thesportsdb] liga ${LEAGUE_ID} não mapeada em config/leagues.js — encerrando.`);
      await logSync('ok', 'liga não mapeada, nada coletado');
      return;
    }

    console.log(`[thesportsdb] liga resolvida: ${league.name}`);

    // 2. Busca todos os times da liga e resolve cada um (linka a time existente ou cria)
    const teamsData = await fetchFromSportsDB(`/lookup_all_teams.php?id=${LEAGUE_ID}`);
    const teamsById = {};
    for (const rawTeam of teamsData.teams || []) {
      const team = await resolveTeam(supabase, {
        source: SOURCE,
        externalId: rawTeam.idTeam,
        name: rawTeam.strTeam,
        logo: rawTeam.strTeamBadge,
        leagueId: league.id,
      });
      teamsById[rawTeam.idTeam] = team;
    }
    console.log(`[thesportsdb] ${Object.keys(teamsById).length} times resolvidos`);

    // 3. Busca as partidas da temporada e resolve cada uma
    const eventsData = await fetchFromSportsDB(`/eventsseason.php?id=${LEAGUE_ID}&s=${SEASON}`);
    const events = eventsData.events || [];
    console.log(`[thesportsdb] ${events.length} partidas encontradas`);

    for (const event of events) {
      const homeTeam = teamsById[event.idHomeTeam];
      const awayTeam = teamsById[event.idAwayTeam];

      // Se algum time do evento não veio na lista de times da liga, pula
      if (!homeTeam || !awayTeam) continue;

      const matchDate = event.strTimestamp
        ? new Date(event.strTimestamp * 1000).toISOString()
        : new Date(`${event.dateEvent}T${event.strTime || '00:00:00'}Z`).toISOString();

      await resolveMatch(supabase, {
        source: SOURCE,
        externalId: event.idEvent,
        leagueId: league.id,
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
        matchDate,
        status: mapStatus(event),
        homeScore: event.intHomeScore !== null && event.intHomeScore !== undefined ? Number(event.intHomeScore) : null,
        awayScore: event.intAwayScore !== null && event.intAwayScore !== undefined ? Number(event.intAwayScore) : null,
      });
    }

    console.log('[thesportsdb] coleta concluída com sucesso.');
    await logSync('ok');
  } catch (err) {
    console.error('[thesportsdb] erro na coleta:', err.message);
    await logSync('error', err.message);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
