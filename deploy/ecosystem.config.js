/**
 * PM2 ecosystem config for production cluster mode.
 * kill_timeout: 30000 gives NestJS 30 seconds to finish in-flight
 * Prisma transactions and Bull jobs before the process is force-killed on SIGTERM.
 * wait_ready: true waits for process.send('ready') from bootstrap() before
 * PM2 considers the instance healthy and removes the old one (zero-downtime reload).
 */
module.exports = {
  apps: [
    {
      name: 'kahade-api',
      script: 'dist/main.js',
      // Replace instances:'max' with an explicit count.
      // 'max' spawns one instance per CPU core. On a 2-core VPS with 2 GB RAM,
      // two NestJS instances + Prisma + Bull workers + Redis + PostgreSQL can
      // easily exceed available RAM, triggering the OOM killer and crashing all
      // processes. Set instances:1 by default; increase only after profiling RAM.
      // Set max_memory_restart so PM2 restarts a single leaky instance instead of
      // killing the entire cluster.
      instances: 1,
      exec_mode: 'cluster',
      wait_ready: true,   // Wait for process.send('ready') signal from bootstrap()
      listen_timeout: 15000,
      kill_timeout: 30000, // 30 seconds for in-flight Prisma tx + Bull jobs to finish
      max_memory_restart: '400M',  // 400 MB per instance; adjust based on actual RAM
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/kahade/pm2-error.log',
      out_file: '/var/log/kahade/pm2-out.log',
      merge_logs: true,
    },
  ],
};
