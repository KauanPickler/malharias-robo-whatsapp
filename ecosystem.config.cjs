// Configuração do pm2 para manter o robô rodando 24h no Raspberry Pi.
// Uso: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'malharias-robo',
      script: 'index.js',
      // Reinicia se travar/cair.
      autorestart: true,
      // Espera 5s antes de reiniciar (evita loop de crash rápido).
      restart_delay: 5000,
      // Se reiniciar mais de 10x em pouco tempo, para (algo está errado).
      max_restarts: 10,
      // Reinicia 1x por dia de madrugada (boa prática p/ sessões longas do WhatsApp).
      cron_restart: '0 4 * * *',
      // Limita memória; se passar disso, reinicia (proteção contra vazamento).
      max_memory_restart: '900M',
      watch: false,
    },
  ],
}
