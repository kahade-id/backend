module.exports = {
  apps: [
    {
      name: 'kahade-api',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'cluster',
      max_memory_restart: '400M',

      // Local compatibility only. Production uses the single external PM2
      // configuration and /var/www/kahade-current flow in DEPLOYMENT_GUIDE.md.
      cwd: __dirname,
      env_file: '.env',

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      error_file: '/var/log/kahade/pm2-error.log',
      out_file: '/var/log/kahade/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 30000,

      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
    },
  ],
};
