#!/usr/bin/env node
/**
 * 免费试用管理脚本（不影响注册时间，随时可恢复）
 *
 * 用法：
 *   node admin-trial.js list                # 查看所有账号试用状态
 *   node admin-trial.js stop <用户名>        # 停止某账号的免费试用（需自备 API 或仅抠图）
 *   node admin-trial.js restore <用户名>     # 恢复按注册时间计算的 72 小时规则
 */
const path = require('path');
const fs = require('fs');
let mysql;
try {
  mysql = require('mysql2/promise');
} catch (e) {
  mysql = require('/home/ubuntu/purse-v2.5.3/node_modules/mysql2/promise');
}
const config = require('./ecosystem.config.js');
const env = (config.apps && config.apps[0] && config.apps[0].env) || {};
const DATA_DIR = env.PICKTIME_DATA_DIR || path.join(__dirname, 'data');

const TRIAL_MS = 72 * 60 * 60 * 1000;

async function main() {
  const [cmd, name] = process.argv.slice(2);
  const conn = await mysql.createConnection({
    host: env.PICKTIME_DB_HOST || '127.0.0.1',
    port: Number(env.PICKTIME_DB_PORT) || 3306,
    user: env.PICKTIME_DB_USER || 'picktime',
    password: env.PICKTIME_DB_PASSWORD || '',
    database: env.PICKTIME_DB_NAME || 'picktime',
  });

  if (cmd === 'list' || !cmd) {
    const [rows] = await conn.query('SELECT name, created_at, trial_ends_at FROM users ORDER BY created_at');
    const now = Date.now();
    rows.forEach((r) => {
      const created = Number(r.created_at);
      const override = Number(r.trial_ends_at) || 0;
      const endsAt = override > 0 ? override : created + TRIAL_MS;
      const active = now < endsAt;
      console.log(
        `${r.name.padEnd(16)} 注册: ${new Date(created).toLocaleString('zh-CN')}  ` +
        `试用结束: ${new Date(endsAt).toLocaleString('zh-CN')}  ` +
        `${active ? '试用中' : '已结束'}${override > 0 ? '（人工设置）' : ''}`
      );
    });
    await conn.end();
    return;
  }

  if (!name) {
    console.error('请提供用户名，例如: node admin-trial.js stop xiaolvyo');
    process.exit(1);
  }

  const [rows] = await conn.query('SELECT id FROM users WHERE name = ?', [name]);
  if (!rows.length) {
    console.error('未找到账号:', name);
    process.exit(1);
  }

  let value = null;
  if (cmd === 'stop') value = Date.now() - 1000;
  else if (cmd === 'restore') value = null;
  else {
    console.error('未知命令:', cmd);
    process.exit(1);
  }

  await conn.query('UPDATE users SET trial_ends_at = ? WHERE name = ?', [value, name]);
  await conn.end();

  // 同步本地 JSON 快照
  ['users.json', 'users-last.json'].forEach((file) => {
    try {
      const f = path.join(DATA_DIR, file);
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      let changed = false;
      arr.forEach((u) => {
        if (u.name === name) {
          if (value) u.trialEndsAtOverride = value;
          else delete u.trialEndsAtOverride;
          changed = true;
        }
      });
      if (changed) fs.writeFileSync(f, JSON.stringify(arr, null, 2));
    } catch (e) {
      /* 忽略 */
    }
  });

  console.log(cmd === 'stop' ? `已停止「${name}」的免费试用` : `已恢复「${name}」按注册时间计算的试用规则`);
  console.log('注意：需重启服务生效 -> pm2 restart picktime-sms');
}

main().catch((e) => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
