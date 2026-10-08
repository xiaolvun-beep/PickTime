/**
 * PickTime 短信验证码 + 账号服务（阿里云 Dypnsapi，与 Purse 相同实现）
 * 启动: NODE_PATH=/home/ubuntu/purse-v2.7.6/node_modules node server.js
 * 端口: 127.0.0.1:5002
 *
 * 登录规则（与 Purse 对齐）：
 *  - 情况A normal：注册页注册（用户名 + 密码 + 手机号验证码）。可绑定 QQ 邮箱、设置密保、修改密码。
 *    忘记密码：用户名或手机号 → 查询密保 → 验证答案 → 重置密码；未设置密保则不可用。
 *  - 情况B qq：QQ 邮箱验证码登录（无密码，自动建号）。账号与安全展示真实 QQ 邮箱，可绑定手机号，
 *    之后可用手机验证码登录。密保设置与修改密码不可用。
 *  - 情况C google：Google OAuth 登录。账号安全设置由 Google 管理，全部不可用。
 */
const express = require('express');
const nodemailer = require('nodemailer');
const RPCClient = require('@alicloud/pop-core').default || require('@alicloud/pop-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '8mb' }));

app.use('/api/', function (req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
});

// ===== 本地数据存储（users.json）=====
const DATA_DIR = process.env.PICKTIME_DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USERS_MIRROR_FILE = path.join(DATA_DIR, 'users-last.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

function hasUsersData(file) {
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content || content === '[]') return false;
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch (e) {
    return false;
  }
}

// 主文件丢失/为空/损坏时，从镜像自动恢复，避免误清空导致账号丢失
function restoreFromMirrorIfNeeded() {
  if (hasUsersData(USERS_FILE)) return;
  if (!hasUsersData(USERS_MIRROR_FILE)) return;
  try {
    fs.copyFileSync(USERS_MIRROR_FILE, USERS_FILE);
    console.log('[恢复] users.json 为空或损坏，已从 users-last.json 自动恢复');
  } catch (e) {
    console.error('[恢复] 失败:', e.message);
  }
}

function backupUsers() {
  try {
    if (!hasUsersData(USERS_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(USERS_FILE, path.join(BACKUP_DIR, 'users-' + stamp + '.json'));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('users-')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) {
    console.error('[备份] 失败:', e.message);
  }
}

restoreFromMirrorIfNeeded();

let users = [];
try {
  const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  if (Array.isArray(parsed)) users = parsed;
} catch (e) { users = []; }

backupUsers();

function writeJsonSnapshot() {
  try {
    const json = JSON.stringify(users, null, 2);
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, USERS_FILE);
    fs.writeFileSync(USERS_MIRROR_FILE, json);
  } catch (e) {
    console.error('[存储] 保存用户失败:', e.message);
  }
}

// ===== MySQL 存储（主存储；本地 JSON 作为快照备份）=====
const mysql = require('mysql2/promise');
const DB_HOST = process.env.PICKTIME_DB_HOST || process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.PICKTIME_DB_PORT || process.env.DB_PORT) || 3306;
const DB_USER = process.env.PICKTIME_DB_USER || 'picktime';
const DB_PASSWORD = process.env.PICKTIME_DB_PASSWORD || '';
const DB_NAME = process.env.PICKTIME_DB_NAME || 'picktime';

let pool = null;
let dbReady = false;
let dbSyncChain = Promise.resolve();

function userToRow(u) {
  return [
    u.id,
    u.name || '',
    u.password || '',
    u.registerType || 'normal',
    u.phone || null,
    u.email || null,
    u.googleId || null,
    u.securityQuestion || null,
    u.securityAnswer || null,
    u.createdAt || Date.now(),
    u.language || null,
    u.profile ? JSON.stringify(u.profile) : null,
    u.apiKeyEnc || null,
    u.apiEnabled === false ? 0 : 1,
    Number(u.trialEndsAtOverride) || null,
    u.meituAkEnc || null,
    u.meituSkEnc || null,
  ];
}

function rowToUser(r) {
  var profile = {};
  if (r.profile_json) {
    try { profile = JSON.parse(r.profile_json) || {}; } catch (e) { profile = {}; }
  }
  return {
    id: r.id,
    name: r.name,
    password: r.password || '',
    registerType: r.register_type || 'normal',
    phone: r.phone || '',
    email: r.email || '',
    googleId: r.google_id || '',
    securityQuestion: r.security_question || '',
    securityAnswer: r.security_answer || '',
    createdAt: Number(r.created_at) || Date.now(),
    language: r.language || '',
    profile: profile,
    apiKeyEnc: r.api_key_enc || '',
    apiEnabled: r.api_enabled == null ? true : !!Number(r.api_enabled),
    trialEndsAtOverride: Number(r.trial_ends_at) || 0,
    meituAkEnc: r.meitu_ak_enc || '',
    meituSkEnc: r.meitu_sk_enc || '',
  };
}

function syncUsersToDb() {
  if (!dbReady || !pool) return;
  const rows = users.map(userToRow);
  dbSyncChain = dbSyncChain.then(async function () {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM users');
      if (rows.length) {
        await conn.query(
          'INSERT INTO users (id, name, password, register_type, phone, email, google_id, security_question, security_answer, created_at, language, profile_json, api_key_enc, api_enabled, trial_ends_at, meitu_ak_enc, meitu_sk_enc) VALUES ?',
          [rows]
        );
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (e2) {}
      console.error('[数据库] 同步失败:', e.message);
    } finally {
      conn.release();
    }
  }).catch(function (e) {
    console.error('[数据库] 同步异常:', e.message);
  });
}

function saveUsers() {
  writeJsonSnapshot();
  syncUsersToDb();
}

async function initDb() {
  try {
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
    });
    await pool.query('SELECT 1');
    await pool.query(
      'CREATE TABLE IF NOT EXISTS users (' +
      'id VARCHAR(40) PRIMARY KEY,' +
      'name VARCHAR(64) NOT NULL,' +
      'password VARCHAR(255) NOT NULL DEFAULT \'\',' +
      'register_type ENUM(\'normal\',\'qq\',\'google\') NOT NULL DEFAULT \'normal\',' +
      'phone VARCHAR(20) DEFAULT NULL,' +
      'email VARCHAR(190) DEFAULT NULL,' +
      'google_id VARCHAR(190) DEFAULT NULL,' +
      'security_question VARCHAR(100) DEFAULT NULL,' +
      'security_answer VARCHAR(100) DEFAULT NULL,' +
      'created_at BIGINT NOT NULL,' +
      'language VARCHAR(10) DEFAULT NULL,' +
      'profile_json MEDIUMTEXT,' +
      'UNIQUE KEY uk_name (name),' +
      'UNIQUE KEY uk_phone (phone),' +
      'UNIQUE KEY uk_email (email),' +
      'KEY idx_google (google_id)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    try {
      await pool.query('ALTER TABLE users ADD COLUMN language VARCHAR(10) DEFAULT NULL');
      console.log('[数据库] users 表已新增 language 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 language 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE users ADD COLUMN profile_json MEDIUMTEXT');
      console.log('[数据库] users 表已新增 profile_json 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 profile_json 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE users ADD COLUMN api_key_enc TEXT');
      console.log('[数据库] users 表已新增 api_key_enc 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 api_key_enc 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE users ADD COLUMN api_enabled TINYINT(1) NOT NULL DEFAULT 1');
      console.log('[数据库] users 表已新增 api_enabled 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 api_enabled 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE users ADD COLUMN trial_ends_at BIGINT DEFAULT NULL');
      console.log('[数据库] users 表已新增 trial_ends_at 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 trial_ends_at 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE users ADD COLUMN meitu_ak_enc TEXT');
      console.log('[数据库] users 表已新增 meitu_ak_enc 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 meitu_ak_enc 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE users ADD COLUMN meitu_sk_enc TEXT');
      console.log('[数据库] users 表已新增 meitu_sk_enc 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 meitu_sk_enc 列失败:', e && e.message);
      }
    }
    await pool.query(
      'CREATE TABLE IF NOT EXISTS records (' +
      'id VARCHAR(64) NOT NULL,' +
      'user_id VARCHAR(40) NOT NULL,' +
      'ts BIGINT NOT NULL,' +
      'date_key VARCHAR(20) NOT NULL DEFAULT \'\',' +
      'meal VARCHAR(20) NOT NULL DEFAULT \'\',' +
      'name VARCHAR(120) NOT NULL DEFAULT \'\',' +
      'kcal INT NOT NULL DEFAULT 0,' +
      'protein DECIMAL(10,1) NOT NULL DEFAULT 0,' +
      'fat DECIMAL(10,1) NOT NULL DEFAULT 0,' +
      'carbs DECIMAL(10,1) NOT NULL DEFAULT 0,' +
      'sugar DECIMAL(10,1) NOT NULL DEFAULT 0,' +
      'fiber DECIMAL(10,1) NOT NULL DEFAULT 0,' +
      'sodium DECIMAL(10,1) NOT NULL DEFAULT 0,' +
      'note VARCHAR(255) NOT NULL DEFAULT \'\',' +
      'cutout_only TINYINT(1) NOT NULL DEFAULT 0,' +
      'image MEDIUMTEXT,' +
      'created_at BIGINT NOT NULL,' +
      'PRIMARY KEY (user_id, id),' +
      'KEY idx_records_user_ts (user_id, ts),' +
      'KEY idx_records_user_date (user_id, date_key)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    try {
      await pool.query('ALTER TABLE records ADD COLUMN cutout_only TINYINT(1) NOT NULL DEFAULT 0');
      await pool.query("UPDATE records SET cutout_only = 1 WHERE name = '未命名' AND kcal = 0 AND protein = 0 AND fat = 0 AND carbs = 0 AND sugar = 0 AND fiber = 0 AND sodium = 0");
      console.log('[数据库] records 表已新增 cutout_only 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    await pool.query(
      'CREATE TABLE IF NOT EXISTS cutout_positions (' +
      'user_id VARCHAR(40) NOT NULL,' +
      'record_id VARCHAR(64) NOT NULL,' +
      'pos_x DECIMAL(6,2) NOT NULL DEFAULT 0,' +
      'pos_y DECIMAL(6,2) NOT NULL DEFAULT 0,' +
      'page_no INT NOT NULL DEFAULT 0,' +
      'updated_at BIGINT NOT NULL,' +
      'PRIMARY KEY (user_id, record_id)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    try {
      await pool.query('ALTER TABLE cutout_positions ADD COLUMN page_no INT NOT NULL DEFAULT 0');
      console.log('[数据库] cutout_positions 表已新增 page_no 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 page_no 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE cutout_positions ADD COLUMN removed TINYINT(1) NOT NULL DEFAULT 0');
      console.log('[数据库] cutout_positions 表已新增 removed 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 removed 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE cutout_positions ADD COLUMN scale DECIMAL(5,2) NOT NULL DEFAULT 1');
      console.log('[数据库] cutout_positions 表已新增 scale 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 scale 列失败:', e && e.message);
      }
    }
    try {
      await pool.query('ALTER TABLE cutout_positions ADD COLUMN rotate INT NOT NULL DEFAULT 0');
      console.log('[数据库] cutout_positions 表已新增 rotate 列');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') {
        console.error('[数据库] 添加 rotate 列失败:', e && e.message);
      }
    }
    await pool.query(
      'CREATE TABLE IF NOT EXISTS folder_photos (' +
      'user_id VARCHAR(40) NOT NULL,' +
      'record_id VARCHAR(64) NOT NULL,' +
      'date_key VARCHAR(20) NOT NULL DEFAULT \'\',' +
      'saved_at BIGINT NOT NULL,' +
      'image MEDIUMTEXT,' +
      'note TEXT,' +
      'note_updated_at BIGINT NOT NULL DEFAULT 0,' +
      'created_at BIGINT NOT NULL,' +
      'PRIMARY KEY (user_id, record_id),' +
      'KEY idx_folder_photos_user_date (user_id, date_key)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    try {
      await pool.query('ALTER TABLE folder_photos ADD COLUMN note TEXT');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
      await pool.query('ALTER TABLE folder_photos ADD COLUMN note_updated_at BIGINT NOT NULL DEFAULT 0');
    } catch (e) {
      if (!e || e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    // 原图删除墓碑：删除后禁止旧设备/迟到的上传把它“复活”
    await pool.query(
      'CREATE TABLE IF NOT EXISTS folder_photo_tombstones (' +
      'user_id VARCHAR(40) NOT NULL,' +
      'record_id VARCHAR(64) NOT NULL,' +
      'deleted_at BIGINT NOT NULL,' +
      'PRIMARY KEY (user_id, record_id)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    await pool.query(
      'CREATE TABLE IF NOT EXISTS daily_cutout_usage (' +
      'user_id VARCHAR(40) NOT NULL,' +
      'date_key DATE NOT NULL,' +
      'used_count INT NOT NULL DEFAULT 0,' +
      'PRIMARY KEY (user_id, date_key)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    pool.query('DELETE FROM folder_photo_tombstones WHERE deleted_at < ?', [Date.now() - 90 * 24 * 3600 * 1000])
      .catch(function (e) { console.error('[数据库] 清理原图墓碑失败:', e && e.message); });
    dbReady = true;
    const [rows] = await pool.query('SELECT * FROM users');
    if (rows.length > 0) {
      users = rows.map(rowToUser);
      console.log('[数据库] 已从 MySQL 加载 ' + rows.length + ' 个账号');
    } else if (users.length > 0) {
      console.log('[数据库] MySQL 为空，正在迁移本地 users.json（' + users.length + ' 个账号）...');
      syncUsersToDb();
    } else {
      console.log('[数据库] MySQL 连接正常，暂无账号数据');
    }
  } catch (e) {
    dbReady = false;
    console.error('[数据库] 连接失败，继续使用本地 JSON 存储:', e.message);
  }
}

let AUTH_SECRET = '';
try { AUTH_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {}
if (!AUTH_SECRET) {
  AUTH_SECRET = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, AUTH_SECRET); } catch (e) {}
}

// ===== 用户 API Key 加密存储（AES-256-GCM，密钥由 secret.key 派生，绝不存明文）=====
const API_ENC_KEY = crypto.createHash('sha256').update('picktime-api-key-v1:' + AUTH_SECRET).digest();

function encryptApiKey(plain) {
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', API_ENC_KEY, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'v1$' + iv.toString('base64') + '$' + tag.toString('base64') + '$' + enc.toString('base64');
  } catch (e) {
    return '';
  }
}

function decryptApiKey(stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', API_ENC_KEY, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

function maskApiKey(plain) {
  const s = String(plain || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

// 免费额度按北京时间自然日、用户 ID 计算。数据库原子更新防止并发请求超额。
const DAILY_CUTOUT_LIMIT = 5;
function cutoutDateKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
async function dailyCutoutUsed(userId, dateKey) {
  if (!dbReady || !pool) throw new Error('数据库暂不可用');
  const [rows] = await pool.query(
    'SELECT used_count FROM daily_cutout_usage WHERE user_id = ? AND date_key = ?',
    [userId, dateKey]
  );
  return rows.length ? Number(rows[0].used_count) || 0 : 0;
}
async function reserveFreeCutout(userId, dateKey) {
  if (!dbReady || !pool) throw new Error('数据库暂不可用');
  await pool.query('INSERT IGNORE INTO daily_cutout_usage (user_id, date_key, used_count) VALUES (?, ?, 0)', [userId, dateKey]);
  const [result] = await pool.query(
    'UPDATE daily_cutout_usage SET used_count = used_count + 1 WHERE user_id = ? AND date_key = ? AND used_count < ?',
    [userId, dateKey, DAILY_CUTOUT_LIMIT]
  );
  return result.affectedRows === 1;
}
async function releaseFreeCutout(userId, dateKey) {
  try {
    await pool.query(
      'UPDATE daily_cutout_usage SET used_count = GREATEST(used_count - 1, 0) WHERE user_id = ? AND date_key = ?',
      [userId, dateKey]
    );
  } catch (e) {
    console.error('[免费额度] 退回失败:', e.message);
  }
}
const DAILY_CUTOUT_ERROR = { error: '今日 5 次免费抠图已用完，请到「通用设置 → API调用」填写自己的美图密钥后继续使用', code: 'DAILY_CUTOUT_LIMIT' };

// ===== 密码哈希（scrypt，无需额外依赖）=====
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const hash = crypto.scryptSync(String(password), parts[1], 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(parts[2], 'hex'));
  } catch (e) {
    return false;
  }
}

// ===== 用户查询 =====
function normalizeAnswer(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function findUserById(id) {
  for (const u of users) if (u.id === id) return u;
  return null;
}

function findUserByName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  for (const u of users) if (String(u.name || '').toLowerCase() === key) return u;
  return null;
}

function findUserByPhone(phone) {
  const key = String(phone || '').trim();
  if (!key) return null;
  for (const u of users) if (u.phone && u.phone === key) return u;
  return null;
}

function findUserByEmail(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  for (const u of users) if (u.email && String(u.email).toLowerCase() === key) return u;
  return null;
}

function findUserByGoogleId(googleId) {
  if (!googleId) return null;
  for (const u of users) if (u.googleId && u.googleId === googleId) return u;
  return null;
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone || '',
    email: u.email || '',
    registerType: u.registerType || 'normal',
    hasPassword: !!u.password,
    securityQuestion: u.securityQuestion || '',
    language: u.language || '',
    profile: u.profile || {},
  };
}

function createUser(fields) {
  const user = Object.assign({
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    name: '',
    password: '',
    registerType: 'normal',
    phone: '',
    email: '',
    googleId: '',
    securityQuestion: '',
    securityAnswer: '',
    createdAt: Date.now(),
    profile: {},
    apiKeyEnc: '',
    apiEnabled: true,
  }, fields || {});
  users.push(user);
  saveUsers();
  return user;
}

// ===== 登录令牌（HMAC 签名，无状态）=====
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;

function signToken(userId) {
  const exp = Date.now() + TOKEN_TTL;
  const payload = userId + '.' + exp;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifyAuthToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const payload = parts[0] + '.' + parts[1];
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  if (sig.length !== parts[2].length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[2]))) return null;
  } catch (e) {
    return null;
  }
  if (Date.now() > Number(parts[1])) return null;
  return parts[0];
}

function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : '';
  const userId = verifyAuthToken(token);
  const user = userId ? findUserById(userId) : null;
  if (!user) return res.status(401).json({ error: '请先登录' });
  req.user = user;
  next();
}

// ===== 验证码 =====
const SMS_CLIENT = new RPCClient({
  accessKeyId: process.env.SMS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.SMS_ACCESS_KEY_SECRET || '',
  endpoint: 'https://dypnsapi.aliyuncs.com',
  apiVersion: '2017-05-25',
});

const SIGN_NAME = process.env.SMS_SIGN_NAME || '速通互联验证码';
const TEMPLATE_CODE = process.env.SMS_TEMPLATE_CODE || '100001';
const CODE_TTL = 5 * 60 * 1000;
const RESEND_GAP = 60 * 1000;

const codeMap = new Map(); // phone -> { code, time }
const emailCodeMap = new Map(); // email -> { code, time }
const googleSessionMap = new Map(); // token -> { userId, name, email, time }
const forgotTicketMap = new Map(); // ticket -> { userId, answer, time, verified }

function consumeSmsCode(phone, code) {
  const cached = codeMap.get(phone);
  if (!cached) return '请先获取验证码';
  if (Date.now() - cached.time > CODE_TTL) {
    codeMap.delete(phone);
    return '验证码已过期，请重新获取';
  }
  if (cached.code !== String(code || '').trim()) return '验证码错误';
  codeMap.delete(phone);
  return '';
}

function consumeEmailCode(email, code) {
  const key = String(email || '').trim();
  const cached = emailCodeMap.get(key);
  if (!cached) return '请先获取验证码';
  if (Date.now() - cached.time > CODE_TTL) {
    emailCodeMap.delete(key);
    return '验证码已过期，请重新获取';
  }
  if (cached.code !== String(code || '').trim()) return '验证码错误';
  emailCodeMap.delete(key);
  return '';
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://picktime.store/auth/google/callback';
const APP_RETURN_URL = process.env.APP_RETURN_URL || 'https://picktime.store/';

const SECURITY_QUESTIONS = [
  '你的出生地是哪里？',
  '你最喜欢的食物是什么？',
  '你的小学名称是什么？',
];

const mailTransporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.qq.com',
  port: Number(process.env.EMAIL_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
  },
});

function sendEmailCode(toEmail, code) {
  const msgId = `<picktime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@qq.com>`;
  return mailTransporter.sendMail({
    from: `"拾光" <${process.env.EMAIL_USER || ''}>`,
    to: toEmail,
    subject: '你的拾光验证码',
    messageId: msgId,
    html: `<div style="font-family: 'Microsoft YaHei', sans-serif; text-align: center;">
      <h2 style="color: #2c3e50;">拾光 验证码</h2>
      <p style="font-size: 16px;">你的验证码是：</p>
      <div style="display:inline-block;background:#f5f5f5;padding:15px 30px;border-radius:12px;font-size:28px;font-weight:bold;letter-spacing:6px;color:#e74c3c;margin:20px 0;">
        ${code}
      </div>
      <p style="font-size: 14px; color: #666;">验证码 5 分钟内有效，请勿向任何人泄露。</p>
    </div>`,
  });
}

async function sendSms(phone, code) {
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) return { ok: false, message: '手机号格式不正确' };
  if (!code || !/^\d{6}$/.test(code)) return { ok: false, message: '验证码格式不正确' };
  try {
    const result = await SMS_CLIENT.request('SendSmsVerifyCode', {
      PhoneNumber: phone,
      SignName: SIGN_NAME,
      TemplateCode: TEMPLATE_CODE,
      TemplateParam: JSON.stringify({ code: code, min: '5' }),
    });
    if (result.Code === 'OK') {
      console.log('[SMS] 发送成功:', phone, 'RequestId:', result.RequestId);
      return { ok: true, message: '验证码已发送' };
    }
    console.error('[SMS] 阿里云接口报错:', result.Code, result.Message);
    return { ok: false, message: result.Message || '发送失败' };
  } catch (err) {
    console.error('[SMS] 请求异常:', err.message);
    let msg = '短信服务异常';
    if (err.code === 'biz.FREQUENCY') msg = '操作太频繁，请稍后再试';
    else if (err.code === 'isv.INVALID_PARAMETERS') msg = '短信模板参数错误: ' + ((err.data && err.data.Message) || err.message);
    return { ok: false, message: msg };
  }
}

// ===== 基础验证码接口 =====
app.post('/api/send-sms', async (req, res) => {
  const phone = String((req.body && req.body.phone) || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '请输入正确的手机号' });
  const cached = codeMap.get(phone);
  if (cached && Date.now() - cached.time < RESEND_GAP) {
    return res.status(429).json({ error: '操作太频繁，请稍后再试' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const result = await sendSms(phone, code);
  if (result.ok) {
    codeMap.set(phone, { code: code, time: Date.now() });
    res.json({ ok: true });
  } else {
    res.status(429).json({ error: result.message || '发送失败，请稍后再试' });
  }
});

app.post('/api/verify-sms', (req, res) => {
  const phone = String((req.body && req.body.phone) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();
  if (!phone || !code) return res.status(400).json({ error: '参数不完整' });
  const err = consumeSmsCode(phone, code);
  if (err) return res.status(400).json({ error: err });
  res.json({ ok: true });
});

app.post('/api/send-email-code', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '请输入正确的邮箱地址' });
  }
  const cached = emailCodeMap.get(email);
  if (cached && Date.now() - cached.time < RESEND_GAP) {
    return res.status(429).json({ error: '操作太频繁，请稍后再试' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await sendEmailCode(email, code);
    emailCodeMap.set(email, { code: code, time: Date.now() });
    console.log('[邮件] 发送成功:', email);
    res.json({ ok: true });
  } catch (err) {
    console.error('[邮件] 发送失败:', err.message);
    res.status(500).json({ error: '邮件发送失败，请稍后再试' });
  }
});

app.post('/api/verify-email-code', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();
  if (!email || !code) return res.status(400).json({ error: '参数不完整' });
  const err = consumeEmailCode(email, code);
  if (err) return res.status(400).json({ error: err });
  res.json({ ok: true });
});

// ===== 注册 / 登录 =====
app.post('/api/auth/register', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const confirm = String((req.body && req.body.confirm) || '');
  const phone = String((req.body && req.body.phone) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();

  if (!name || !password || !phone || !code) return res.status(400).json({ error: '请填写所有字段' });
  if (name.length < 2 || name.length > 16) return res.status(400).json({ error: '用户名需为 2-16 个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (confirm && password !== confirm) return res.status(400).json({ error: '两次密码不一致' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '请输入正确的手机号' });
  if (findUserByName(name)) return res.status(400).json({ error: '该用户名已被使用' });
  if (findUserByPhone(phone)) return res.status(400).json({ error: '该手机号已注册' });

  const codeErr = consumeSmsCode(phone, code);
  if (codeErr) return res.status(400).json({ error: codeErr });

  const user = createUser({
    name: name,
    password: hashPassword(password),
    registerType: 'normal',
    phone: phone,
  });
  console.log('[注册] 新用户:', user.name, user.phone);
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const account = String((req.body && req.body.account) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!account || !password) return res.status(400).json({ error: '请输入账号和密码' });

  let user = findUserByName(account);
  if (!user && /^1[3-9]\d{9}$/.test(account)) user = findUserByPhone(account);
  if (!user) return res.status(400).json({ error: '账号不存在，请先注册' });

  if (user.registerType === 'qq') {
    return res.status(400).json({ error: '该账号通过 QQ 邮箱登录，请使用 QQ 邮箱或绑定的手机号登录' });
  }
  if (user.registerType === 'google') {
    return res.status(400).json({ error: '该账号通过 Google 登录，请使用 Google 登录' });
  }
  if (!verifyPassword(password, user.password)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }

  res.json({ ok: true, token: signToken(user.id), user: publicUser(user) });
});

app.post('/api/auth/phone-login', (req, res) => {
  const phone = String((req.body && req.body.phone) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '请输入正确的手机号' });
  if (!code) return res.status(400).json({ error: '请输入验证码' });

  const codeErr = consumeSmsCode(phone, code);
  if (codeErr) return res.status(400).json({ error: codeErr });

  const user = findUserByPhone(phone);
  if (!user) return res.status(400).json({ error: '该手机号尚未注册或绑定账号，请先注册' });

  res.json({ ok: true, token: signToken(user.id), user: publicUser(user) });
});

app.post('/api/auth/qq-login', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '请输入正确的邮箱地址' });
  if (!code) return res.status(400).json({ error: '请输入验证码' });

  const codeErr = consumeEmailCode(email, code);
  if (codeErr) return res.status(400).json({ error: codeErr });

  let user = findUserByEmail(email);
  if (!user) {
    const base = (email.split('@')[0] || 'QQ用户').slice(0, 16) || 'QQ用户';
    let name = base;
    let i = 1;
    while (findUserByName(name)) {
      name = (base + i).slice(0, 16);
      i++;
      if (i > 99) { name = ('QQ' + crypto.randomBytes(2).toString('hex')).slice(0, 16); break; }
    }
    user = createUser({ name: name, registerType: 'qq', email: email });
    console.log('[QQ登录] 新用户自动注册:', user.name, email);
  }

  res.json({ ok: true, token: signToken(user.id), user: publicUser(user) });
});

// ===== 当前账号信息 =====
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

// 轻量读取账号壁纸，供网页/App 与小程序前台同步，避免反复传输头像和封面。
app.get('/api/auth/wallpaper', requireAuth, (req, res) => {
  const wallpaper = req.user.profile && req.user.profile.wallpaper;
  res.json({ ok: true, wallpaper: ['default', 'cream', 'soft', 'warm'].includes(wallpaper) ? wallpaper : 'default' });
});

app.post('/api/auth/language', requireAuth, (req, res) => {
  const lang = String((req.body && req.body.language) || '').trim();
  if (['zh-CN', 'en', 'ja', 'ko'].indexOf(lang) === -1) {
    return res.status(400).json({ error: '不支持的语言' });
  }
  req.user.language = lang;
  saveUsers();
  console.log('[语言设置]', req.user.name, lang);
  res.json({ ok: true, user: publicUser(req.user) });
});

// ===== 个人资料（昵称/签名/性别/身高体重/地区/头像封面）=====
app.post('/api/auth/profile', requireAuth, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const next = Object.assign({}, req.user.profile || {});
  const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if (body.nickname !== undefined) next.nickname = clip(body.nickname, 64);
  if (body.signature !== undefined) next.signature = clip(body.signature, 120);
  if (body.gender !== undefined) next.gender = body.gender === 'female' ? 'female' : 'male';
  if (body.height !== undefined) {
    const h = Number(body.height);
    if (isFinite(h) && h >= 50 && h <= 250) next.height = Math.round(h * 10) / 10;
  }
  if (body.weight !== undefined) {
    const w = Number(body.weight);
    if (isFinite(w) && w >= 10 && w <= 500) next.weight = Math.round(w * 10) / 10;
  }
  if (body.targetWeight !== undefined) {
    const tw = Number(body.targetWeight);
    if (isFinite(tw) && tw > 0 && tw <= 500) next.targetWeight = Math.round(tw * 10) / 10;
    else if (isFinite(tw) && tw === 0) delete next.targetWeight;
  }
  if (body.province !== undefined) next.province = clip(body.province, 40);
  if (body.city !== undefined) next.city = clip(body.city, 40);
  if (body.wallpaper !== undefined) {
    if (typeof body.wallpaper !== 'string' || !['default', 'cream', 'soft', 'warm'].includes(body.wallpaper)) {
      return res.status(400).json({ error: '不支持的壁纸' });
    }
    next.wallpaper = body.wallpaper;
  }
  if (body.birthyear !== undefined) {
    const y = Number(body.birthyear);
    if (isFinite(y) && y >= 1900 && y <= 2100) next.birthyear = Math.round(y);
    else if (isFinite(y) && y === 0) delete next.birthyear;
  }
  const image = (v) => {
    const s = String(v == null ? '' : v);
    if (!s) return '';
    if (!/^data:image\//.test(s) && !/^https?:\/\//.test(s)) return null;
    if (s.length > 1.6 * 1024 * 1024) return null;
    return s;
  };
  if (body.avatar !== undefined) {
    const a = image(body.avatar);
    if (a !== null) next.avatar = a;
  }
  if (body.cover !== undefined) {
    const c = image(body.cover);
    if (c !== null) next.cover = c;
  }
  req.user.profile = next;
  saveUsers();
  console.log('[资料更新]', req.user.name, Object.keys(body).join(','));
  res.json({ ok: true, user: publicUser(req.user) });
});

// ===== 账号与安全 =====
app.post('/api/auth/bind-phone', requireAuth, (req, res) => {
  if (req.user.registerType === 'google') {
    return res.status(400).json({ error: 'Google 登录用户账号安全设置由 Google 账户管理，暂不支持修改' });
  }
  const phone = String((req.body && req.body.phone) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '请输入正确的手机号' });
  if (!code) return res.status(400).json({ error: '请输入验证码' });

  const codeErr = consumeSmsCode(phone, code);
  if (codeErr) return res.status(400).json({ error: codeErr });

  const other = findUserByPhone(phone);
  if (other && other.id !== req.user.id) return res.status(400).json({ error: '此手机号已被其他账号绑定' });

  req.user.phone = phone;
  saveUsers();
  console.log('[绑定手机]', req.user.name, phone);
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post('/api/auth/bind-email', requireAuth, (req, res) => {
  if (req.user.registerType === 'google') {
    return res.status(400).json({ error: 'Google 登录用户账号安全设置由 Google 账户管理，暂不支持修改' });
  }
  const email = String((req.body && req.body.email) || '').trim();
  const code = String((req.body && req.body.code) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '请输入正确的邮箱地址' });
  if (!code) return res.status(400).json({ error: '请输入验证码' });

  const codeErr = consumeEmailCode(email, code);
  if (codeErr) return res.status(400).json({ error: codeErr });

  const other = findUserByEmail(email);
  if (other && other.id !== req.user.id) return res.status(400).json({ error: '此邮箱已被其他账号绑定' });

  req.user.email = email;
  saveUsers();
  console.log('[绑定邮箱]', req.user.name, email);
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post('/api/auth/security', requireAuth, (req, res) => {
  if (req.user.registerType === 'qq') {
    return res.status(400).json({ error: 'QQ 邮箱登录的账号不支持设置密保，请使用绑定的手机号找回' });
  }
  if (req.user.registerType === 'google') {
    return res.status(400).json({ error: 'Google 登录用户账号安全设置由 Google 账户管理，暂不支持修改' });
  }
  const question = String((req.body && req.body.question) || '').trim();
  const answer = normalizeAnswer((req.body && req.body.answer) || '');
  if (!question || !answer) return res.status(400).json({ error: '请选择密保问题并填写答案' });
  if (SECURITY_QUESTIONS.indexOf(question) === -1) return res.status(400).json({ error: '密保问题无效' });
  if (answer.length > 50) return res.status(400).json({ error: '密保答案过长' });

  req.user.securityQuestion = question;
  req.user.securityAnswer = answer;
  saveUsers();
  console.log('[设置密保]', req.user.name, question);
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  if (req.user.registerType === 'qq') {
    return res.status(400).json({ error: 'QQ 邮箱登录的账号没有密码，不支持修改密码' });
  }
  if (req.user.registerType === 'google') {
    return res.status(400).json({ error: 'Google 登录用户账号安全设置由 Google 账户管理，暂不支持修改' });
  }
  const oldPassword = String((req.body && req.body.oldPassword) || '');
  const newPassword = String((req.body && req.body.newPassword) || '');
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写旧密码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  if (!verifyPassword(oldPassword, req.user.password)) return res.status(400).json({ error: '旧密码不正确' });

  req.user.password = hashPassword(newPassword);
  saveUsers();
  console.log('[修改密码]', req.user.name);
  res.json({ ok: true });
});

// ===== 忘记密码（密保找回）=====
app.post('/api/auth/forgot/query', (req, res) => {
  const account = String((req.body && req.body.account) || '').trim();
  if (!account) return res.status(400).json({ error: '请输入用户名或手机号' });

  let user = findUserByName(account);
  if (!user && /^1[3-9]\d{9}$/.test(account)) user = findUserByPhone(account);
  if (!user) return res.status(400).json({ error: '账号不存在' });
  if (user.registerType !== 'normal') {
    return res.status(400).json({ error: '该账号未设置密保，无法找回密码' });
  }
  if (!user.securityQuestion) {
    return res.status(400).json({ error: '该账号未设置密保，无法找回密码' });
  }

  const ticket = crypto.randomBytes(24).toString('hex');
  forgotTicketMap.set(ticket, {
    userId: user.id,
    answer: user.securityAnswer,
    time: Date.now(),
    verified: false,
  });
  res.json({ ok: true, question: user.securityQuestion, ticket: ticket });
});

app.post('/api/auth/forgot/verify', (req, res) => {
  const ticket = String((req.body && req.body.ticket) || '');
  const answer = normalizeAnswer((req.body && req.body.answer) || '');
  if (!ticket || !answer) return res.status(400).json({ error: '请输入密保答案' });

  const cached = forgotTicketMap.get(ticket);
  if (!cached) return res.status(400).json({ error: '验证已过期，请重新查询' });
  if (Date.now() - cached.time > 10 * 60 * 1000) {
    forgotTicketMap.delete(ticket);
    return res.status(400).json({ error: '验证已过期，请重新查询' });
  }
  if (cached.answer !== answer) return res.status(400).json({ error: '密保答案错误' });

  cached.verified = true;
  forgotTicketMap.set(ticket, cached);
  res.json({ ok: true, ticket: ticket });
});

app.post('/api/auth/forgot/reset', (req, res) => {
  const ticket = String((req.body && req.body.ticket) || '');
  const newPassword = String((req.body && req.body.newPassword) || '');
  if (!ticket || !newPassword) return res.status(400).json({ error: '参数不完整' });
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });

  const cached = forgotTicketMap.get(ticket);
  if (!cached || !cached.verified) return res.status(400).json({ error: '请先完成密保验证' });
  if (Date.now() - cached.time > 10 * 60 * 1000) {
    forgotTicketMap.delete(ticket);
    return res.status(400).json({ error: '验证已过期，请重新查询' });
  }

  const user = findUserById(cached.userId);
  if (!user) return res.status(400).json({ error: '账号不存在' });

  user.password = hashPassword(newPassword);
  saveUsers();
  forgotTicketMap.delete(ticket);
  console.log('[忘记密码] 重置成功:', user.name);
  res.json({ ok: true });
});

// ===== 饮食记录（按用户存储到 MySQL）=====
const RECORD_IMAGE_MAX = 1600000;

function recordNumber(value, max) {
  const n = Number(value);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.round(n * 10) / 10);
}

function rowToRecord(r, summary) {
  const record = {
    id: r.id,
    ts: Number(r.ts) || 0,
    date: r.date_key || '',
    meal: r.meal || '',
    name: r.name || '',
    kcal: Number(r.kcal) || 0,
    nutrients: {
      protein: Number(r.protein) || 0,
      fat: Number(r.fat) || 0,
      carbs: Number(r.carbs) || 0,
      sugar: Number(r.sugar) || 0,
      fiber: Number(r.fiber) || 0,
      sodium: Number(r.sodium) || 0,
    },
    note: r.note || '',
    cutoutOnly: !!Number(r.cutout_only),
  };
  if (summary === true) record.hasImage = !!Number(r.has_image);
  else record.image = r.image || '';
  return record;
}

app.get('/api/records', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  try {
    if (req.query.images === '1') {
      let ids;
      try { ids = JSON.parse(req.query.ids); } catch (e) {}
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 ||
          ids.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 64 || /[\x00-\x1f\x7f]/.test(id))) {
        return res.status(400).json({ error: '无效的记录 ID' });
      }
      const uniqueIds = [...new Set(ids)];
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const [rows] = await pool.query(
        'SELECT id, image FROM records WHERE user_id = ? AND id IN (' + placeholders + ')',
        [req.user.id, ...uniqueIds]
      );
      return res.json({ ok: true, records: rows.map(r => ({ id: r.id, image: r.image || '' })), selectiveImages: true });
    }

    if (req.query.summary === '1') {
      const [rows] = await pool.query(
        'SELECT id, ts, date_key, meal, name, kcal, protein, fat, carbs, sugar, fiber, sodium, note, cutout_only, ' +
        'LENGTH(image) > 0 AS has_image FROM records WHERE user_id = ? ORDER BY ts ASC',
        [req.user.id]
      );
      return res.json({ ok: true, records: rows.map(r => rowToRecord(r, true)), selectiveImages: true });
    }

    const [rows] = await pool.query(
      'SELECT id, ts, date_key, meal, name, kcal, protein, fat, carbs, sugar, fiber, sodium, note, cutout_only, image ' +
      'FROM records WHERE user_id = ? ORDER BY ts ASC',
      [req.user.id]
    );
    res.json({ ok: true, records: rows.map(rowToRecord) });
  } catch (e) {
    console.error('[记录] 读取失败:', e.message);
    res.status(500).json({ error: '读取记录失败，请稍后再试' });
  }
});

app.post('/api/records', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  const body = req.body || {};
  const id = String(body.id || '').trim().slice(0, 64);
  if (!id) return res.status(400).json({ error: '记录缺少 id' });
  const image = String(body.image || '');
  if (image.length > RECORD_IMAGE_MAX) return res.status(413).json({ error: '图片数据过大' });
  const nutrients = body.nutrients || {};
  const record = {
    id: id,
    ts: Number(body.ts) || Date.now(),
    date: String(body.date || '').slice(0, 20),
    meal: String(body.meal || '').slice(0, 20),
    name: String(body.name || '').slice(0, 120),
    kcal: Math.max(0, Math.round(Number(body.kcal) || 0)),
    protein: recordNumber(nutrients.protein, 100000),
    fat: recordNumber(nutrients.fat, 100000),
    carbs: recordNumber(nutrients.carbs, 100000),
    sugar: recordNumber(nutrients.sugar, 100000),
    fiber: recordNumber(nutrients.fiber, 100000),
    sodium: recordNumber(nutrients.sodium, 1000000),
    note: String(body.note || '').slice(0, 255),
    cutoutOnly: body.cutoutOnly ? 1 : 0,
    image: image,
  };
  try {
    await pool.query(
      'INSERT INTO records (id, user_id, ts, date_key, meal, name, kcal, protein, fat, carbs, sugar, fiber, sodium, note, cutout_only, image, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE ts = VALUES(ts), date_key = VALUES(date_key), meal = VALUES(meal), name = VALUES(name), ' +
      'kcal = VALUES(kcal), protein = VALUES(protein), fat = VALUES(fat), carbs = VALUES(carbs), sugar = VALUES(sugar), ' +
      'fiber = VALUES(fiber), sodium = VALUES(sodium), note = VALUES(note), cutout_only = VALUES(cutout_only), image = VALUES(image)',
      [
        record.id, req.user.id, record.ts, record.date, record.meal, record.name, record.kcal,
        record.protein, record.fat, record.carbs, record.sugar, record.fiber, record.sodium,
        record.note, record.cutoutOnly, record.image, Date.now(),
      ]
    );
    res.json({ ok: true, record: record });
  } catch (e) {
    console.error('[记录] 保存失败:', e.message);
    res.status(500).json({ error: '保存记录失败，请稍后再试' });
  }
});

app.delete('/api/records/:id', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  const id = String((req.params && req.params.id) || '').slice(0, 64);
  if (!id) return res.status(400).json({ error: '缺少记录 id' });
  try {
    await pool.query('DELETE FROM records WHERE user_id = ? AND id = ?', [req.user.id, id]);
    // 记录删了就一并删除文件夹原图，并留墓碑防止旧设备把它“复活”
    await pool.query(
      'INSERT INTO folder_photo_tombstones (user_id, record_id, deleted_at) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE deleted_at = VALUES(deleted_at)',
      [req.user.id, id, Date.now()]
    );
    await pool.query('DELETE FROM folder_photos WHERE user_id = ? AND record_id = ?', [req.user.id, id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[记录] 删除失败:', e.message);
    res.status(500).json({ error: '删除记录失败，请稍后再试' });
  }
});

app.delete('/api/records', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  try {
    await pool.query(
      'INSERT INTO folder_photo_tombstones (user_id, record_id, deleted_at) ' +
      'SELECT user_id, record_id, ? FROM folder_photos WHERE user_id = ? ' +
      'ON DUPLICATE KEY UPDATE deleted_at = VALUES(deleted_at)',
      [Date.now(), req.user.id]
    );
    await pool.query('DELETE FROM folder_photos WHERE user_id = ?', [req.user.id]);
    await pool.query('DELETE FROM records WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[记录] 清空失败:', e.message);
    res.status(500).json({ error: '清空记录失败，请稍后再试' });
  }
});

// ===== 抠图摆放位置（统计二级页，按用户存 MySQL）=====
app.get('/api/positions', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  try {
    const [rows] = await pool.query(
      'SELECT record_id, pos_x, pos_y, page_no, removed, scale, rotate FROM cutout_positions WHERE user_id = ?',
      [req.user.id]
    );
    const positions = {};
    for (const r of rows) {
      positions[r.record_id] = {
        leftPct: Number(r.pos_x) || 0,
        topPct: Number(r.pos_y) || 0,
        page: Number(r.page_no) || 0,
        removed: !!Number(r.removed),
        scale: Number(r.scale) || 1,
        rotate: Number(r.rotate) || 0,
      };
    }
    res.json({ ok: true, positions: positions });
  } catch (e) {
    console.error('[摆放位置] 读取失败:', e.message);
    res.status(503).json({ error: '读取失败，请稍后再试' });
  }
});

app.post('/api/positions', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  const recordId = String((req.body && req.body.recordId) || '').trim().slice(0, 64);
  let leftPct = Number(req.body && req.body.leftPct);
  let topPct = Number(req.body && req.body.topPct);
  let pageNo = Number(req.body && req.body.page);
  const removed = (req.body && (req.body.removed === true || Number(req.body.removed) === 1)) ? 1 : 0;
  let scale = Number(req.body && req.body.scale);
  let rotate = Number(req.body && req.body.rotate);
  if (!recordId) return res.status(400).json({ error: '缺少记录 id' });
  if (!isFinite(leftPct) || !isFinite(topPct)) return res.status(400).json({ error: '位置参数错误' });
  if (!isFinite(pageNo)) pageNo = 0;
  if (!isFinite(scale)) scale = 1;
  if (!isFinite(rotate)) rotate = 0;
  leftPct = Math.max(0, Math.min(100, leftPct));
  topPct = Math.max(0, Math.min(100, topPct));
  pageNo = Math.max(0, Math.min(999, Math.floor(pageNo)));
  scale = Math.max(0.2, Math.min(10, scale));
  rotate = ((Math.round(rotate) % 360) + 360) % 360;
  try {
    await pool.query(
      'INSERT INTO cutout_positions (user_id, record_id, pos_x, pos_y, page_no, removed, scale, rotate, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE pos_x = VALUES(pos_x), pos_y = VALUES(pos_y), page_no = VALUES(page_no), removed = VALUES(removed), scale = VALUES(scale), rotate = VALUES(rotate), updated_at = VALUES(updated_at)',
      [req.user.id, recordId, leftPct, topPct, pageNo, removed, scale, rotate, Date.now()]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[摆放位置] 保存失败:', e.message);
    res.status(503).json({ error: '保存失败，请稍后再试' });
  }
});

// ===== 统计页文件夹原图（按用户存 MySQL，换设备可恢复）=====
const FOLDER_IMAGE_MAX = 3200000;

app.get('/api/folder-photos', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  const date = String((req.query && req.query.date) || '').trim().slice(0, 20);
  try {
    const params = [req.user.id];
    let sql = 'SELECT record_id, date_key, saved_at, note, note_updated_at FROM folder_photos WHERE user_id = ?';
    if (date) { sql += ' AND date_key = ?'; params.push(date); }
    sql += ' ORDER BY saved_at DESC';
    const [rows] = await pool.query(sql, params);
    res.json({
      ok: true,
      photos: rows.map((r) => ({
        recordId: r.record_id,
        dateKey: r.date_key || '',
        savedAt: Number(r.saved_at) || 0,
        note: r.note || '',
        noteUpdatedAt: Number(r.note_updated_at) || 0,
      })),
    });
  } catch (e) {
    console.error('[文件夹原图] 读取列表失败:', e.message);
    res.status(503).json({ error: '读取失败，请稍后再试' });
  }
});

app.get('/api/folder-photos/:recordId', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  const recordId = String((req.params && req.params.recordId) || '').trim().slice(0, 64);
  if (!recordId) return res.status(400).json({ error: '缺少记录 id' });
  try {
    const [rows] = await pool.query(
      'SELECT record_id, date_key, saved_at, image, note, note_updated_at FROM folder_photos WHERE user_id = ? AND record_id = ?',
      [req.user.id, recordId]
    );
    if (!rows.length) return res.status(404).json({ error: '原图不存在' });
    const r = rows[0];
    res.json({
      ok: true,
      photo: {
        recordId: r.record_id,
        dateKey: r.date_key || '',
        savedAt: Number(r.saved_at) || 0,
        image: r.image || '',
        note: r.note || '',
        noteUpdatedAt: Number(r.note_updated_at) || 0,
      },
    });
  } catch (e) {
    console.error('[文件夹原图] 读取失败:', e.message);
    res.status(503).json({ error: '读取失败，请稍后再试' });
  }
});

app.post('/api/folder-photos', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  const body = req.body || {};
  const recordId = String(body.recordId || '').trim().slice(0, 64);
  if (!recordId) return res.status(400).json({ error: '缺少记录 id' });
  const image = String(body.image || '');
  if (!image) return res.status(400).json({ error: '缺少原图数据' });
  if (image.length > FOLDER_IMAGE_MAX) return res.status(413).json({ error: '原图数据过大' });
  const dateKey = String(body.dateKey || '').slice(0, 20);
  const savedAt = Number(body.savedAt) || Date.now();
  try {
    // 有删除墓碑时拒绝写入，防止旧设备把已删除的原图重新上传“复活”
    const [result] = await pool.query(
      'INSERT INTO folder_photos (user_id, record_id, date_key, saved_at, image, created_at) ' +
      'SELECT ?, ?, ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (' +
      'SELECT 1 FROM folder_photo_tombstones WHERE user_id = ? AND record_id = ?) ' +
      'ON DUPLICATE KEY UPDATE date_key = VALUES(date_key), saved_at = VALUES(saved_at), image = VALUES(image)',
      [req.user.id, recordId, dateKey, savedAt, image, Date.now(), req.user.id, recordId]
    );
    if (!result || !result.affectedRows) return res.status(409).json({ error: '原图已删除，请勿重新上传' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[文件夹原图] 保存失败:', e.message);
    res.status(503).json({ error: '保存失败，请稍后再试' });
  }
});

app.put('/api/folder-photos/:recordId/note', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  const recordId = String((req.params && req.params.recordId) || '').trim().slice(0, 64);
  if (!recordId) return res.status(400).json({ error: '缺少记录 id' });
  const note = String((req.body && req.body.note) || '');
  if (note.length > 5000) return res.status(413).json({ error: '文字过长' });
  const updatedAt = Number(req.body && req.body.updatedAt);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) return res.status(400).json({ error: '缺少有效更新时间' });
  try {
    const [result] = await pool.query(
      'UPDATE folder_photos SET note = ?, note_updated_at = ? ' +
      'WHERE user_id = ? AND record_id = ? AND note_updated_at <= ?',
      [note, updatedAt, req.user.id, recordId, updatedAt]
    );
    if (result.affectedRows) return res.json({ ok: true, noteUpdatedAt: updatedAt });
    const [rows] = await pool.query(
      'SELECT note_updated_at FROM folder_photos WHERE user_id = ? AND record_id = ?',
      [req.user.id, recordId]
    );
    if (!rows.length) return res.status(404).json({ error: '原图不存在' });
    res.json({ ok: true, stale: true, noteUpdatedAt: Number(rows[0].note_updated_at) || 0 });
  } catch (e) {
    console.error('[文件夹背面文字] 保存失败:', e.message);
    res.status(503).json({ error: '保存失败，请稍后再试' });
  }
});

app.delete('/api/folder-photos/:recordId', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  const recordId = String((req.params && req.params.recordId) || '').trim().slice(0, 64);
  if (!recordId) return res.status(400).json({ error: '缺少记录 id' });
  try {
    await pool.query(
      'INSERT INTO folder_photo_tombstones (user_id, record_id, deleted_at) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE deleted_at = VALUES(deleted_at)',
      [req.user.id, recordId, Date.now()]
    );
    await pool.query('DELETE FROM folder_photos WHERE user_id = ? AND record_id = ?', [req.user.id, recordId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[文件夹原图] 删除失败:', e.message);
    res.status(503).json({ error: '删除失败，请稍后再试' });
  }
});

app.delete('/api/folder-photos', requireAuth, async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: '数据库暂不可用，请稍后再试' });
  try {
    await pool.query(
      'INSERT INTO folder_photo_tombstones (user_id, record_id, deleted_at) ' +
      'SELECT user_id, record_id, ? FROM folder_photos WHERE user_id = ? ' +
      'ON DUPLICATE KEY UPDATE deleted_at = VALUES(deleted_at)',
      [Date.now(), req.user.id]
    );
    await pool.query('DELETE FROM folder_photos WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[文件夹原图] 清空失败:', e.message);
    res.status(503).json({ error: '清空失败，请稍后再试' });
  }
});

// ===== API 调用设置（用户自己的 Qwen API Key + 美图抠图密钥，加密存储）=====
async function apiSettingPayload(u) {
  const dateKey = cutoutDateKey();
  const used = await dailyCutoutUsed(u.id, dateKey);
  const remaining = Math.max(0, DAILY_CUTOUT_LIMIT - used);
  return {
    ok: true,
    trialActive: remaining > 0,
    trialEndsAt: Date.parse(dateKey + 'T16:00:00Z'),
    vip: false,
    freeCutoutLimit: DAILY_CUTOUT_LIMIT,
    freeCutoutsRemaining: remaining,
    dailyCutoutLimit: DAILY_CUTOUT_LIMIT,
    dailyCutoutUsed: used,
    dailyCutoutRemaining: remaining,
    hasApiKey: !!u.apiKeyEnc,
    apiKeyMasked: maskApiKey(decryptApiKey(u.apiKeyEnc)),
    hasMeituKey: !!(u.meituAkEnc && u.meituSkEnc),
    meituAkMasked: maskApiKey(decryptApiKey(u.meituAkEnc)),
    apiEnabled: u.apiEnabled !== false,
  };
}

app.get('/api/user/api-setting', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json(await apiSettingPayload(req.user)); }
  catch (e) { res.status(503).json({ error: '额度查询失败，请稍后再试' }); }
});

app.post('/api/user/api-setting', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const u = req.user;
  const body = req.body || {};
  const wantsKey = Object.prototype.hasOwnProperty.call(body, 'apiKey');
  const wantsToggle = Object.prototype.hasOwnProperty.call(body, 'apiEnabled');

  if (wantsKey) {
    const raw = String(body.apiKey == null ? '' : body.apiKey).trim();
    if (raw && (raw.length < 8 || raw.length > 256)) {
      return res.status(400).json({ error: 'API Key 长度不正确', code: 'BAD_API_KEY' });
    }
    if (!raw) {
      u.apiKeyEnc = '';
    } else {
      const enc = encryptApiKey(raw);
      if (!enc) return res.status(500).json({ error: '保存失败，请重试', code: 'ENC_FAILED' });
      u.apiKeyEnc = enc;
    }
  }
  if (wantsToggle) {
    u.apiEnabled = !!body.apiEnabled;
  }

  // 美图抠图密钥（AK/SK 必须成对）：两个都传空 = 清除
  const wantsMeituAk = Object.prototype.hasOwnProperty.call(body, 'meituAk');
  const wantsMeituSk = Object.prototype.hasOwnProperty.call(body, 'meituSk');
  if (wantsMeituAk || wantsMeituSk) {
    const ak = String(body.meituAk == null ? '' : body.meituAk).trim();
    const sk = String(body.meituSk == null ? '' : body.meituSk).trim();
    if ((ak && !sk) || (!ak && sk)) {
      return res.status(400).json({ error: '美图 AccessKey 和 SecretKey 需要成对填写', code: 'BAD_MEITU_KEY' });
    }
    if (ak && (ak.length < 8 || ak.length > 256)) {
      return res.status(400).json({ error: '美图 AccessKey 长度不正确', code: 'BAD_MEITU_KEY' });
    }
    if (sk && (sk.length < 8 || sk.length > 256)) {
      return res.status(400).json({ error: '美图 SecretKey 长度不正确', code: 'BAD_MEITU_KEY' });
    }
    if (!ak) {
      u.meituAkEnc = '';
      u.meituSkEnc = '';
    } else {
      const akEnc = encryptApiKey(ak);
      const skEnc = encryptApiKey(sk);
      if (!akEnc || !skEnc) return res.status(500).json({ error: '保存失败，请重试', code: 'ENC_FAILED' });
      u.meituAkEnc = akEnc;
      u.meituSkEnc = skEnc;
    }
  }
  saveUsers();
  console.log('[API设置] %s 更新: hasKey=%s hasMeitu=%s enabled=%s', u.name,
    !!u.apiKeyEnc, !!(u.meituAkEnc && u.meituSkEnc), u.apiEnabled !== false);
  try { res.json(await apiSettingPayload(u)); }
  catch (e) { res.status(503).json({ error: '设置已保存，额度查询失败，请刷新重试' }); }
});

// ===== 拍照识别代理：服务端免费额度每天 5 次；自带美图和 Qwen 密钥无限使用 =====
app.post('/api/recognize', requireAuth, async (req, res) => {
  const u = req.user;
  let userKey = '';
  const meituAk = decryptApiKey(u.meituAkEnc);
  const meituSk = decryptApiKey(u.meituSkEnc);
  const ownMeitu = !!(meituAk && meituSk);
  if (u.apiEnabled === false) {
    return res.status(403).json({ error: '已关闭 API 调用，仅使用抠图功能', code: 'API_DISABLED' });
  }
  if (ownMeitu) {
    userKey = decryptApiKey(u.apiKeyEnc);
    if (!userKey) {
      return res.status(403).json({ error: '未填写 Qwen API，仅可使用抠图功能', code: 'QWEN_REQUIRED' });
    }
  }

  const dateKey = cutoutDateKey();
  let reserved = false;
  if (!ownMeitu) {
    try { reserved = await reserveFreeCutout(u.id, dateKey); }
    catch (e) { return res.status(503).json({ error: '额度服务暂不可用，请稍后再试' }); }
    if (!reserved) return res.status(429).json(DAILY_CUTOUT_ERROR);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (userKey) headers['X-Dashscope-Api-Key'] = userKey;
    if (meituAk) headers['X-Meitu-Ak'] = meituAk;
    if (meituSk) headers['X-Meitu-Sk'] = meituSk;
    const upstream = await fetch('http://127.0.0.1:5003/api/recognize', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(req.body || {}),
      signal: controller.signal,
    });
    const text = await upstream.text();
    let hasCutout = false;
    if (upstream.ok) {
      try {
        const payload = JSON.parse(text);
        const content = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
        hasCutout = !!(content && JSON.parse(content).cutout);
      } catch (e) {}
    }
    if (reserved && !hasCutout) { await releaseFreeCutout(u.id, dateKey); reserved = false; }
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    if (reserved) await releaseFreeCutout(u.id, dateKey);
    const aborted = e && e.name === 'AbortError';
    console.error('[识别代理] 失败:', e && e.message);
    res.status(aborted ? 504 : 502).json({ error: aborted ? '识别超时，请重试' : '识别服务暂不可用，请稍后再试' });
  } finally {
    clearTimeout(timer);
  }
});

// ===== 仅抠图代理：与完整识别共用每日免费额度；自带美图密钥无限使用 =====
app.post('/api/cutout', requireAuth, async (req, res) => {
  const u = req.user;
  const meituAk = decryptApiKey(u.meituAkEnc);
  const meituSk = decryptApiKey(u.meituSkEnc);
  const ownMeitu = !!(meituAk && meituSk);
  const dateKey = cutoutDateKey();
  let reserved = false;
  if (!ownMeitu) {
    try { reserved = await reserveFreeCutout(u.id, dateKey); }
    catch (e) { return res.status(503).json({ error: '额度服务暂不可用，请稍后再试' }); }
    if (!reserved) return res.status(429).json(DAILY_CUTOUT_ERROR);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (meituAk) headers['X-Meitu-Ak'] = meituAk;
    if (meituSk) headers['X-Meitu-Sk'] = meituSk;
    const upstream = await fetch('http://127.0.0.1:5003/api/cutout', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(req.body || {}),
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (!upstream.ok && reserved) { await releaseFreeCutout(u.id, dateKey); reserved = false; }
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    if (reserved) await releaseFreeCutout(u.id, dateKey);
    const aborted = e && e.name === 'AbortError';
    console.error('[抠图代理] 失败:', e && e.message);
    res.status(aborted ? 504 : 502).json({ error: aborted ? '抠图超时，请重试' : '抠图服务暂不可用，请稍后再试' });
  } finally {
    clearTimeout(timer);
  }
});

// 本机模型兜底也按同一额度计数，避免直接请求绕过限制。
app.post('/api/cutout-local', requireAuth, async (req, res) => {
  const u = req.user;
  const ownMeitu = !!(decryptApiKey(u.meituAkEnc) && decryptApiKey(u.meituSkEnc));
  const dateKey = cutoutDateKey();
  let reserved = false;
  if (!ownMeitu) {
    try { reserved = await reserveFreeCutout(u.id, dateKey); }
    catch (e) { return res.status(503).json({ error: '额度服务暂不可用，请稍后再试' }); }
    if (!reserved) return res.status(429).json(DAILY_CUTOUT_ERROR);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const upstream = await fetch('http://127.0.0.1:5001/remove-bg?quality=standard', {
      method: 'POST',
      headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
      body: req,
      duplex: 'half',
      signal: controller.signal,
    });
    const image = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok && reserved) { await releaseFreeCutout(u.id, dateKey); reserved = false; }
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/octet-stream');
    res.send(image);
  } catch (e) {
    if (reserved) await releaseFreeCutout(u.id, dateKey);
    res.status(e && e.name === 'AbortError' ? 504 : 502).json({ error: '本机抠图失败，请重试' });
  } finally {
    clearTimeout(timer);
  }
});

// ===== 添加页「询问 AI」：登录校验后流式转发（始终使用服务端 Doubao Key） =====
app.post('/api/ai-chat', requireAuth, async (req, res) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const upstream = await fetch('http://127.0.0.1:5003/api/ai-chat', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(req.body || {}),
      signal: controller.signal,
    });
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    console.error('[AI对话] 失败:', e && e.message);
    if (!res.headersSent) {
      res.status(aborted ? 504 : 502).json({ error: aborted ? 'AI 响应超时，请重试' : 'AI 服务暂不可用，请稍后再试' });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
});

// ===== 首页抠图小贴士：转发到识别服务（看图片生成一句 AI 提示，无需登录） =====
const foodTipHits = new Map();
const FOOD_TIP_WINDOW = 60 * 1000;
const FOOD_TIP_MAX = 30;

app.post('/api/food-tip', async (req, res) => {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const ip = xff.length ? xff[xff.length - 1] : String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
  const now = Date.now();
  const hits = (foodTipHits.get(ip) || []).filter(function (t) { return now - t < FOOD_TIP_WINDOW; });
  if (hits.length >= FOOD_TIP_MAX) {
    return res.status(429).json({ error: '操作太频繁，请稍后再试' });
  }
  hits.push(now);
  foodTipHits.set(ip, hits);
  if (foodTipHits.size > 500) {
    foodTipHits.forEach(function (v, k) {
      if (!v.some(function (t) { return now - t < FOOD_TIP_WINDOW; })) foodTipHits.delete(k);
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const upstream = await fetch('http://127.0.0.1:5003/api/food-tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: controller.signal,
    });
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    console.error('[小贴士] 失败:', e && e.message);
    res.status(aborted ? 504 : 502).json({ error: aborted ? '小贴士生成超时' : '小贴士服务暂不可用' });
  } finally {
    clearTimeout(timer);
  }
});

// ===== Google 登录 =====
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  // 安卓 App 内发起：携带 state，登录完成后深链回跳 App
  if (String(req.query.app || '') === '1') params.set('state', 'picktime-android');
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/auth/google/callback', async (req, res) => {
  const isApp = String(req.query.state || '') === 'picktime-android';
  const appFail = 'picktime://google-auth?error=1';
  const code = req.query && req.query.code;
  if (!code) return res.redirect(isApp ? appFail : APP_RETURN_URL + '?google_error=1');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData || !tokenData.access_token) {
      console.error('[Google登录] Token换取失败:', tokenData && (tokenData.error_description || tokenData.error));
      return res.redirect(isApp ? appFail : APP_RETURN_URL + '?google_error=1');
    }
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
    });
    const user = await userRes.json();
    if (!user || !user.email) return res.redirect(isApp ? appFail : APP_RETURN_URL + '?google_error=1');

    const googleId = user.sub || '';
    let account = findUserByGoogleId(googleId);
    if (!account) {
      let name = String(user.name || user.email.split('@')[0] || 'Google用户').slice(0, 16);
      let i = 1;
      while (findUserByName(name)) {
        name = (String(user.name || 'Google用户').slice(0, 14) + i).slice(0, 16);
        i++;
        if (i > 99) { name = ('G' + crypto.randomBytes(2).toString('hex')).slice(0, 16); break; }
      }
      account = createUser({
        name: name,
        registerType: 'google',
        email: user.email,
        googleId: googleId,
      });
      console.log('[Google登录] 新用户自动注册:', account.name, user.email);
    }

    const token = crypto.randomBytes(24).toString('hex');
    googleSessionMap.set(token, {
      userId: account.id,
      name: account.name,
      email: account.email,
      time: Date.now(),
    });
    console.log('[Google登录] 成功:', user.email);
    res.redirect(isApp ? 'picktime://google-auth?token=' + token : APP_RETURN_URL + '?google=1&token=' + token);
  } catch (err) {
    console.error('[Google登录] 出错:', err.message);
    res.redirect(isApp ? appFail : APP_RETURN_URL + '?google_error=1');
  }
});

app.get('/api/google/session', (req, res) => {
  const token = String((req.query && req.query.token) || '');
  const data = googleSessionMap.get(token);
  if (!data) return res.status(400).json({ error: '登录信息已失效，请重试' });
  if (Date.now() - data.time > 5 * 60 * 1000) {
    googleSessionMap.delete(token);
    return res.status(400).json({ error: '登录信息已过期，请重试' });
  }
  googleSessionMap.delete(token);
  const user = findUserById(data.userId);
  if (!user) return res.status(400).json({ error: '账号不存在，请重试' });
  res.json({ ok: true, name: data.name, email: data.email, authToken: signToken(user.id), user: publicUser(user) });
});

app.get('/health', (req, res) => res.json({ ok: true }));

setInterval(function () {
  const now = Date.now();
  codeMap.forEach(function (v, k) {
    if (now - v.time > CODE_TTL) codeMap.delete(k);
  });
  emailCodeMap.forEach(function (v, k) {
    if (now - v.time > CODE_TTL) emailCodeMap.delete(k);
  });
  googleSessionMap.forEach(function (v, k) {
    if (now - v.time > CODE_TTL) googleSessionMap.delete(k);
  });
  forgotTicketMap.forEach(function (v, k) {
    if (now - v.time > 30 * 60 * 1000) forgotTicketMap.delete(k);
  });
}, 10 * 60 * 1000);

const PORT = Number(process.env.PICKTIME_PORT) || 5002;
initDb().then(function () {
  app.listen(PORT, '127.0.0.1', function () {
    console.log('[PickTime Auth] listening on http://127.0.0.1:' + PORT);
  });
});
