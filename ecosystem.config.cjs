module.exports = {
  apps: [
    {
      name: "polybtc",
      script: "server.ts",
      interpreter: "./node_modules/.bin/tsx",
      env_file: ".env",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "div-bot",
      script: "div-bot.ts",
      interpreter: "./node_modules/.bin/tsx",
      env_file: ".env",
      watch: false,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        DIV_ASSETS: "BTC,ETH,SOL",
        BOT_FIXED_TRADE_USDC: "1.5",
      },
    },
  ],
};
