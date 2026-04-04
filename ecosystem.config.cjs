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
  ],
};
