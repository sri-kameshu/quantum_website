const crypto = require('node:crypto');
const { Pool } = require('pg');

const jwtSecret = process.env.JWT_SECRET;
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })
  : null;

const members = [
  ['23BQ1A4202', 'A.Sa Charan'],
  ['23BQ1A4231', 'CH.Aparna'],
  ['23BQ1A4251', 'G.Kamesh'],
  ['24BQ5A4203', 'K.chandra sekhar']
];

let databaseReady;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = storedHash.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

async function initializeDatabase() {
  if (!pool) throw new Error('DATABASE_URL is not configured.');
  if (!databaseReady) {
    databaseReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGSERIAL PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS quiz_attempts (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id),
          score INTEGER NOT NULL CHECK (score >= 0),
          total_questions INTEGER NOT NULL CHECK (total_questions > 0),
          duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
          completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS quiz_attempts_user_id_idx ON quiz_attempts(user_id);
      `);
      for (const [username, displayName] of members) {
        await pool.query(
          `INSERT INTO users (email, username, display_name, password_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(username) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             password_hash = EXCLUDED.password_hash`,
          [`${username}@project.local`, username, displayName, hashPassword(process.env[`MEMBER_PASSWORD_${username}`] || username)]
        );
      }
    })().catch((error) => {
      databaseReady = undefined;
      throw error;
    });
  }
  await databaseReady;
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }));
}

function createToken(user) {
  const encode = (value) => Buffer.from(value).toString('base64url');
  const content = `${encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${encode(JSON.stringify({
    sub: String(user.id), exp: Math.floor(Date.now() / 1000) + 28800
  }))}`;
  return `${content}.${crypto.createHmac('sha256', jwtSecret).update(content).digest('base64url')}`;
}

async function authenticatedUser(event) {
  const token = parseCookies(event.headers?.cookie || event.headers?.Cookie).project_pulse_token;
  if (!token) return null;
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = crypto.createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.sub || data.exp <= Math.floor(Date.now() / 1000)) return null;
    const result = await pool.query('SELECT id, email, username, display_name FROM users WHERE id = $1', [Number(data.sub)]);
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

function response(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  if (!jwtSecret || !databaseUrl) {
    return response(500, { error: 'Server configuration is incomplete.' });
  }

  try {
    await initializeDatabase();
    const routePath = event.path.replace(/^\/\.netlify\/functions\/api/, '/api');
    const method = event.httpMethod;

    if (routePath === '/api/login' && method === 'POST') {
      const { username, password } = JSON.parse(event.body || '{}');
      const identifier = typeof username === 'string' ? username.trim() : '';
      const result = typeof password === 'string'
        ? await pool.query('SELECT id, email, username, display_name, password_hash FROM users WHERE username = $1', [identifier])
        : { rows: [] };
      const user = result.rows[0];
      if (!user || !verifyPassword(password, user.password_hash)) {
        return response(401, { error: 'That username or password is not recognised.' });
      }
      return response(200, { user: { email: user.email, username: user.username, displayName: user.display_name } }, {
        'Set-Cookie': `project_pulse_token=${createToken(user)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`
      });
    }

    if (routePath === '/api/me' && method === 'GET') {
      const user = await authenticatedUser(event);
      if (!user) return response(401, { error: 'Not signed in.' });
      return response(200, { user: { email: user.email, username: user.username, displayName: user.display_name } });
    }

    if (routePath === '/api/logout' && method === 'POST') {
      return response(200, { ok: true }, {
        'Set-Cookie': 'project_pulse_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
      });
    }

    if (routePath === '/api/results' && method === 'POST') {
      const user = await authenticatedUser(event);
      if (!user) return response(401, { error: 'Your session has expired.' });
      const { score, totalQuestions, durationSeconds } = JSON.parse(event.body || '{}');
      if (!Number.isInteger(score) || !Number.isInteger(totalQuestions) || !Number.isInteger(durationSeconds)
        || score < 0 || score > totalQuestions || totalQuestions < 1 || durationSeconds < 0) {
        return response(400, { error: 'Invalid quiz result.' });
      }
      const result = await pool.query(
        `INSERT INTO quiz_attempts (user_id, score, total_questions, duration_seconds)
         VALUES ($1, $2, $3, $4) RETURNING id, completed_at`,
        [user.id, score, totalQuestions, durationSeconds]
      );
      return response(201, { result: result.rows[0] });
    }

    return response(404, { error: 'Not found.' });
  } catch (error) {
    const isInputError = error instanceof SyntaxError;
    console.error('API request failed:', error.message);
    return response(isInputError ? 400 : 500, { error: isInputError ? 'Invalid JSON.' : 'The request could not be completed.' });
  }
};
