/**
 * Mapeamento manual de ligas entre fontes.
 * -----------------------------------------
 * Por que manual e não automático? Ligas são poucas (dezenas, não milhares),
 * então vale garantir 100% de precisão à mão em vez de arriscar um "match"
 * automático errado que juntaria duas ligas diferentes.
 *
 * Pra adicionar uma nova liga: descubra o external_id dela em cada fonte
 * e adicione uma entrada aqui. Se uma fonte não tiver a liga, é só omitir
 * a chave dela dentro de `sources`.
 *
 * Como achar o external_id:
 * - football-data.org: é o "código" da competição (ex: BSA, PL, CL)
 *   Lista completa: https://api.football-data.org/v4/competitions (precisa do token)
 * - thesportsdb.com: é o idLeague numérico
 *   Busca: https://www.thesportsdb.com/api/v1/json/3/search_all_leagues.php?c=Brazil
 */

module.exports = [
  {
    key: 'brasileirao-serie-a',
    name: 'Brasileirão Série A',
    country: 'Brazil',
    sources: {
      'football-data': 'BSA',
      thesportsdb: '4351',
    },
  },
  {
    key: 'premier-league',
    name: 'Premier League',
    country: 'England',
    sources: {
      'football-data': 'PL',
      thesportsdb: '4328',
    },
  },
  // Adicione novas ligas aqui seguindo o mesmo formato.
];
