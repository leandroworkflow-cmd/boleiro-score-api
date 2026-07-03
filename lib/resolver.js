const LEAGUES_MAP = require('../config/leagues');

const TEAM_NAME_NOISE = [
  'futebol clube', 'clube de regatas', 'esporte clube', 'sport club',
  'clube atletico', 'clube atlético', 'associacao', 'associação',
  'fc', 'sc', 'ec', 'cf', 'afc', 'cd', 'ac', 'fk', 'sv',
];

function normalizeName(name) {
  let n = (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const noise of TEAM_NAME_NOISE) {
    n = n.replace(new RegExp(`\\b${noise}\\b`, 'g'), '').trim();
  }

  return n.replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] =
        a[i - 1] === b[j - 1]
          ? matrix[i - 1][j - 1]
          : 1 + Math.min(matrix[i - 1][j - 1], matrix[i - 1][j], matrix[i][j - 1]);
    }
  }
  return matrix[a.length][b.length];
}

async function resolveLeague(supabase, { source, externalId, name, country, logo }) {
  const config = LEAGUES_MAP.find((l) => l.sources[source] === String(externalId));

  if (!config) {
    console.warn(
      `[resolver] liga "${name}" (${source}:${externalId}) não está em config/leagues.js — pulando. Adicione-a lá se quiser coletar essa liga.`
    );
    return null;
  }

  const { data: league, error } = await supabase
    .from('leagues')
    .upsert(
      {
        canonical_key: config.key,
        name: config.name,
        country: config.country,
        logo,
      },
      { onConflict: 'canonical_key' }
    )
    .select()
    .single();

  if (error) throw error;

  const { error: linkError } = await supabase
    .from('league_sources')
    .upsert(
      { league_id: league.id, source, external_id: String(externalId), source_name: name },
      { onConflict: 'source,external_id' }
    );

  if (linkError) throw linkError;

  return league;
}

// O limite de tolerância ESCALA com o tamanho do nome. Nomes curtos (como
// países: "Iraq" vs "Iran") têm poucas letras de diferença mesmo sendo coisas
// totalmente diferentes — um limite fixo juntava essas por engano.
function maxAllowedDistance(a, b) {
  const minLength = Math.min(a.length, b.length);
  if (minLength < 6) return 0;
  return Math.max(1, Math.floor(minLength * 0.2));
}

async function resolveTeam(supabase, { source, externalId, name, logo, leagueId }) {
  const { data: existingSource } = await supabase
    .from('team_sources')
    .select('team_id')
    .eq('source', source)
    .eq('external_id', String(externalId))
    .maybeSingle();

  if (existingSource) {
    const { data: team, error } = await supabase
      .from('teams')
      .select('*')
      .eq('id', existingSource.team_id)
      .single();
    if (error) throw error;
    return team;
  }

  const normalized = normalizeName(name);
  const { data: candidates, error: candidatesError } = await supabase
    .from('teams')
    .select('*')
    .eq('league_id', leagueId);

  if (candidatesError) throw candidatesError;

  let match = candidates.find((t) => t.normalized_name === normalized);

  if (!match) {
    match = candidates.find(
      (t) => levenshtein(t.normalized_name, normalized) <= maxAllowedDistance(t.normalized_name, normalized)
    );
    if (match) {
      console.log(
        `[resolver] match aproximado: "${name}" (${source}) ~= "${match.name}" (existente)`
      );
    }
  }

  let team = match;

  if (!team) {
    const { data: created, error: createError } = await supabase
      .from('teams')
      .insert({ league_id: leagueId, name, short_name: name, logo, normalized_name: normalized })
      .select()
      .single();
    if (createError) throw createError;
    team = created;
  }

  const { error: linkError } = await supabase
    .from('team_sources')
    .upsert(
      { team_id: team.id, source, external_id: String(externalId), source_name: name },
      { onConflict: 'source,external_id' }
    );
  if (linkError) throw linkError;

  return team;
}

const MATCH_TIME_WINDOW_HOURS = 12;

async function resolveMatch(
  supabase,
  { source, externalId, leagueId, homeTeamId, awayTeamId, matchDate, status, homeScore, awayScore }
) {
  const { data: existingSource } = await supabase
    .from('match_sources')
    .select('match_id')
    .eq('source', source)
    .eq('external_id', String(externalId))
    .maybeSingle();

  let matchId = existingSource?.match_id;

  if (!matchId) {
    const date = new Date(matchDate);
    const windowStart = new Date(date.getTime() - MATCH_TIME_WINDOW_HOURS * 3600 * 1000);
    const windowEnd = new Date(date.getTime() + MATCH_TIME_WINDOW_HOURS * 3600 * 1000);

    const { data: candidates, error: candidatesError } = await supabase
      .from('matches')
      .select('id')
      .eq('league_id', leagueId)
      .eq('home_team_id', homeTeamId)
      .eq('away_team_id', awayTeamId)
      .gte('match_date', windowStart.toISOString())
      .lte('match_date', windowEnd.toISOString())
      .limit(1);

    if (candidatesError) throw candidatesError;
    matchId = candidates?.[0]?.id;
  }

  if (matchId) {
    const { data: current, error: currentError } = await supabase
      .from('matches')
      .select('*')
      .eq('id', matchId)
      .single();
    if (currentError) throw currentError;

    const incomingIsMoreComplete =
      homeScore !== null && current.home_score === null;
    const shouldUpdateStatus = status === 'FINISHED' || current.status !== 'FINISHED';

    const { error: updateError } = await supabase
      .from('matches')
      .update({
        status: shouldUpdateStatus ? status : current.status,
        home_score: incomingIsMoreComplete ? homeScore : current.home_score ?? homeScore,
        away_score: incomingIsMoreComplete ? awayScore : current.away_score ?? awayScore,
        updated_at: new Date().toISOString(),
      })
      .eq('id', matchId);
    if (updateError) throw updateError;
  } else {
    const { data: created, error: createError } = await supabase
      .from('matches')
      .insert({
        league_id: leagueId,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        match_date: matchDate,
        status,
        home_score: homeScore,
        away_score: awayScore,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (createError) throw createError;
    matchId = created.id;
  }

  const { error: linkError } = await supabase
    .from('match_sources')
    .upsert(
      { match_id: matchId, source, external_id: String(externalId) },
      { onConflict: 'source,external_id' }
    );
  if (linkError) throw linkError;

  return matchId;
}

module.exports = { resolveLeague, resolveTeam, resolveMatch, normalizeName };
