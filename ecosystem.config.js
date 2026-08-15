module.exports = {
  apps: [
    {
      name: 'llm-backend',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
    },
  ],
};
