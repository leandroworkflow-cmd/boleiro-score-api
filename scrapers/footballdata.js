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

const COMPETITION_CODES = (process.env.COMPETITION_CODES || process.env.COMPETITION_CODE || 'BSA')
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function collectCompetition(competitionCode) {
  console.log(`[football-data] iniciando coleta da competição ${competitionCode}...`);

  const competitionData = await fetchFromFootballData(`/competitions/${competitionCode}`);
  const league = await resolveLeague(supabase, {
    source: SOURCE,
    externalId: competitionCode,
    name: competitionData.name,
    country: competitionData.area?.name,
    logo: competitionData.emblem,
  });

  if (!league) {
    console.log(`[football-data] liga ${competitionCode} não mapeada em config/leagues.js — pulando.`);
    return { competitionCode, matches: 0, skipped: true };
  }

  console.log(`[football-data] liga resolvida: ${league.name}`);

  const matchesData = await fetchFromFootballData(`/competitions/${competitionCode}/matches`);
  console.log(`[football-data] ${matchesData.matches.length} partidas encontradas para ${league.name}`);

  for (const [index, match] of matchesData.matches.entries()) {
    console.log(`[football-data] processando partida ${index + 1}/${matchesData.matches.length}...`);

    const homeMissing = !match.homeTeam || !match.homeTeam.id || !match.homeTeam.name;
    const awayMissing = !match.awayTeam || !match.awayTeam.id || !match.awayTeam.name;
    if (homeMissing || awayMissing) {
      console.log(`[football-data] partida ${index + 1} com time ainda nao definido -- pulando.`);
      continue;
    }

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

  return { competitionCode, matches: matchesData.matches.length, skipped: false };
}

async function run() {
  console.log(`[football-data] competicoes configuradas: ${COMPETITION_CODES.join(', ')}`);

  try {
    for (const [index, code] of COMPETITION_CODES.entries()) {
      await collectCompetition(code);
      if (index < COMPETITION_CODES.length - 1) {
        await sleep(6000);
      }
    }

    console.log('[football-data] coleta concluida com sucesso.');
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
