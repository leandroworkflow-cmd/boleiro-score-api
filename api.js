/**
 * Sua API própria. O frontend consome ISSO, nunca as fontes originais.
 * Rode com: node api.js
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// Aqui pode usar a anon key, já que é só leitura
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Protege sua API de abuso (100 requisições por 15min por IP)
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
  })
);

// GET /matches/today -> partidas do dia
app.get('/matches/today', async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const { data, error } = await supabase
    .from('matches')
    .select(
      `
      id, match_date, status, home_score, away_score,
      home_team:home_team_id ( name, logo ),
      away_team:away_team_id ( name, logo ),
      league:league_id ( name, logo )
    `
    )
    .gte('match_date', startOfDay.toISOString())
    .lte('match_date', endOfDay.toISOString())
    .order('match_date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /standings/:leagueKey -> tabela de classificação
// leagueKey é o "canonical_key" da liga (ex: brasileirao-serie-a), veja config/leagues.js
app.get('/standings/:leagueKey', async (req, res) => {
  const { data: league, error: leagueError } = await supabase
    .from('leagues')
    .select('id, name')
    .eq('canonical_key', req.params.leagueKey)
    .single();

  if (leagueError) return res.status(404).json({ error: 'Liga não encontrada' });

  const { data, error } = await supabase
    .from('standings')
    .select('position, played, won, draw, lost, points, team:team_id ( name, logo )')
    .eq('league_id', league.id)
    .order('position', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ league: league.name, standings: data });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API rodando em http://localhost:${PORT}`));
