/**
 * Resolvedor de entidades entre fontes.
 * ---------------------------------------
 * Toda vez que um coletor lê uma liga/time/partida de uma fonte, ele NÃO
 * insere direto — ele passa pelo resolvedor, que decide:
 *   1. Essa fonte+external_id já está mapeada? -> retorna o registro canônico existente
 *   2. Não está mapeada, mas já existe um registro equivalente de outra fonte? -> linka nele
 *   3. Não existe nada parecido? -> cria um registro canônico novo
 *
 * Resultado: N fontes reportando o mesmo Flamengo geram 1 linha em `teams`,
 * com N linhas em `team_sources` apontando pra ela.
 */

const LEAGUES_MAP = require('../config/leagues');

// ---------- normalização de nomes (usada pro matching de times) ----------

const TEAM_NAME_NOISE = [
  'futebol clube', 'clube de regatas', 'esporte clube', 'sport club',
  'clube atletico', 'clube atlético', 'associacao', 'associação',
  'fc', 'sc', 'ec', 'cf', 'afc', 'cd', 'ac', 'fk', 'sv',
];

function normalizeName(name) {
  let n = (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const noise of TEAM_NAME_NOISE) {
    n = n.replace(new RegExp(`\\b${noise}\\b`, 'g'), '').trim();
  }

  return n.replace(/\s+/g, ' ').trim();
}

// Distância de Levenshtein simples, usada como fallback quando o nome
// normalizado não bate 100% (ex: "Man United" vs "Manchester United")
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

// ---------- LIGAS ----------

/**
 * @param supabase cliente do Supabase
 * @param {source, externalId, name, country, logo} dados brutos vindos da fonte
 * @returns registro canônico de `leagues`, ou null se a liga não estiver no config/leagues.js
 */
async function resolveLeague(supabase, { source, externalId, name, country, logo }) {
  const config = LEAGUES_MAP.find((l) => l.sources[source] === String(externalId));

  if (!config) {
    // Liga não mapeada: em vez de criar um registro "solto" (que poderia
    // duplicar depois), pulamos e avisamos. Isso força que toda liga nova
    // seja adicionada intencionalmente no config/leagues.js.
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
        logo, // guarda o logo da última fonte que reportou (qualquer uma serve)
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

// ---------- TIMES ----------

const FUZZY_MATCH_MAX_DISTANCE = 2;

/**
 * @returns registro canônico de `teams` (existente ou recém-criado)
 */
async function resolveTeam(supabase, { source, externalId, name, logo, leagueId }) {
  // 1. Essa fonte+id já está linkada a um time? Caminho rápido.
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

  // 2. Ainda não linkado: procura um time equivalente na mesma liga por nome.
  const normalized = normalizeName(name);
  const { data: candidates, error: candidatesError } = await supabase
    .from('teams')
    .select('*')
    .eq('league_id', leagueId);

  if (candidatesError) throw candidatesError;

  let match = candidates.find((t) => t.normalized_name === normalized);

  if (!match) {
    match = candidates.find(
      (t) => levenshtein(t.normalized_name, normalized) <= FUZZY_MATCH_MAX_DISTANCE
    );
    if (match) {
      console.log(
        `[resolver] match aproximado: "${name}" (${source}) ~= "${match.name}" (existente)`
      );
    }
  }

  let team = match;

  if (!team) {
    // 3. Nenhum time parecido: cria um canônico novo.
    const { data: created, error: createError } = await supabase
      .from('teams')
      .insert({ league_id: leagueId, name, short_name: name, logo, normalized_name: normalized })
      .select()
      .single();
    if (createError) throw createError;
    team = created;
  }

  // Linka essa fonte ao time canônico (achado ou criado) pras próximas coletas
  // já caírem no caminho rápido (passo 1).
  const { error: linkError } = await supabase
    .from('team_sources')
    .upsert(
      { team_id: team.id, source, external_id: String(externalId), source_name: name },
      { onConflict: 'source,external_id' }
    );
  if (linkError) throw linkError;

  return team;
}

// ---------- PARTIDAS ----------

// Janela de tolerância pra considerar duas partidas "a mesma", já que fontes
// diferentes às vezes reportam o horário com pequenas variações.
const MATCH_TIME_WINDOW_HOURS = 12;

/**
 * @returns registro canônico de `matches` (existente ou recém-criado)
 */
async function resolveMatch(
  supabase,
  { source, externalId, leagueId, homeTeamId, awayTeamId, matchDate, status, homeScore, awayScore }
) {
  // 1. Caminho rápido: essa fonte+id já está linkada a uma partida?
  const { data: existingSource } = await supabase
    .from('match_sources')
    .select('match_id')
    .eq('source', source)
    .eq('external_id', String(externalId))
    .maybeSingle();

  let matchId = existingSource?.match_id;

  if (!matchId) {
    // 2. Procura uma partida equivalente: mesma liga, mesmos times, data próxima.
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
    // Já existe: enriquece o registro em vez de duplicar.
    // Regra simples: só sobrescreve placar/status se o novo dado for "mais completo"
    // (ex: uma fonte já marcou FINISHED com placar, a outra ainda diz SCHEDULED).
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
    // Nenhuma partida equivalente: cria uma nova.
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
