// 复制为 ecosystem.config.js 后填入自己的密钥：
//   cp ecosystem.config.example.js ecosystem.config.js
// 然后：pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'picktime-sms',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_PATH: '/home/ubuntu/purse-v2.5.3/node_modules',
        PICKTIME_DB_HOST: '127.0.0.1',
        PICKTIME_DB_PORT: '3306',
        PICKTIME_DB_USER: 'picktime',
        PICKTIME_DB_PASSWORD: '',
        PICKTIME_DB_NAME: 'picktime',
        // 阿里云短信（可选）
        SMS_ACCESS_KEY_ID: '',
        SMS_ACCESS_KEY_SECRET: '',
        SMS_SIGN_NAME: '',
        SMS_TEMPLATE_CODE: '',
        // QQ 邮箱验证码（可选）
        EMAIL_HOST: 'smtp.qq.com',
        EMAIL_PORT: '465',
        EMAIL_USER: '',
        EMAIL_PASS: '',
        // Google 登录（可选）
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        GOOGLE_REDIRECT_URI: 'https://your-domain/auth/google/callback',
        APP_RETURN_URL: 'https://your-domain/',
      },
      max_memory_restart: '256M',
      max_restarts: 10,
      restart_delay: 5000,
      error_file: '/home/ubuntu/.pm2/logs/picktime-sms-error.log',
      out_file: '/home/ubuntu/.pm2/logs/picktime-sms-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
