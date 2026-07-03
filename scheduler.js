/**
 * Agendador dos coletores.
 * Roda todos os coletores periodicamente, cada um com seu próprio intervalo.
 * Em produção, rode isso como um processo separado da sua API
 * (ex: um "worker" no Railway/Render), não junto do servidor Express.
 */

const cron = require('node-cron');
const footballData = require('./scrapers/footballdata');
const theSportsDB = require('./scrapers/thesportsdb');

// Football-Data.org: a cada 10 minutos (respeita o limite de 10 req/min do free tier)
cron.schedule('*/10 * * * *', () => {
  console.log('[scheduler] disparando coleta football-data...');
  footballData.run();
});

// TheSportsDB: a cada 30 minutos (a chave de teste "3" tem limites mais apertados)
cron.schedule('*/30 * * * *', () => {
  console.log('[scheduler] disparando coleta thesportsdb...');
  theSportsDB.run();
});

console.log('[scheduler] iniciado. Aguardando próximos ciclos...');

// Roda uma vez imediatamente ao subir o processo
footballData.run();
theSportsDB.run();
