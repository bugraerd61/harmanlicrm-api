const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({limit:'50mb'}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'harmanli-secret-key';
const ADMIN_EMAIL = 'b.erdogan@harmanlikimya.com';

async function initDB() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS users (' +
    'id SERIAL PRIMARY KEY,' +
    'email VARCHAR(255) UNIQUE NOT NULL,' +
    'password VARCHAR(255) NOT NULL,' +
    'name VARCHAR(255),' +
    'created_at TIMESTAMP DEFAULT NOW())'
  );
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT \'user\'');
  await pool.query(
    'CREATE TABLE IF NOT EXISTS excel_uploads (' +
    'id SERIAL PRIMARY KEY,' +
    'etiket VARCHAR(255),' +
    'tarih TIMESTAMP DEFAULT NOW(),' +
    'uploaded_by INTEGER REFERENCES users(id),' +
    'fat_data JSONB,' +
    'akt_data JSONB,' +
    'sat_data JSONB,' +
    'tek_data JSONB,' +
    'meta JSONB)'
  );
  await pool.query(
    'UPDATE users SET active=TRUE, role=\'admin\' WHERE email=$1',
    [ADMIN_EMAIL]
  );
  console.log('DB ready');
}

function auth(req, res, next) {
  var token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Gecersiz token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Yetkisiz' });
  next();
}

app.get('/', function(req, res) {
  res.json({ status: 'HarmanliCRM API calisiyor' });
});

app.post('/api/register', function(req, res) {
  var email = req.body.email;
  var password = req.body.password;
  var name = req.body.name;
  var isAdmin = (email === ADMIN_EMAIL);
  bcrypt.hash(password, 10).then(function(hash) {
    return pool.query(
      'INSERT INTO users (email, password, name, active, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role, active',
      [email, hash, name, isAdmin, isAdmin ? 'admin' : 'user']
    );
  }).then(function(result) {
    if (!isAdmin) {
      return res.json({ pending: true, message: 'Kaydınız alındı. Admin onayından sonra giriş yapabilirsiniz.' });
    }
    var token = jwt.sign({ id: result.rows[0].id, role: result.rows[0].role }, JWT_SECRET);
    res.json({ token: token, user: result.rows[0] });
  }).catch(function(err) {
    res.status(400).json({ error: err.message });
  });
});

app.post('/api/login', function(req, res) {
  var email = req.body.email;
  var password = req.body.password;
  pool.query('SELECT * FROM users WHERE email=$1', [email]).then(function(result) {
    if (!result.rows[0]) return res.status(400).json({ error: 'Kullanici bulunamadi' });
    if (!result.rows[0].active) return res.status(403).json({ error: 'Hesabınız henüz onaylanmadı. Admin onayı bekleniyor.' });
    return bcrypt.compare(password, result.rows[0].password).then(function(valid) {
      if (!valid) return res.status(400).json({ error: 'Hatali sifre' });
      var token = jwt.sign({ id: result.rows[0].id, role: result.rows[0].role }, JWT_SECRET);
      res.json({ token: token, user: { id: result.rows[0].id, email: result.rows[0].email, name: result.rows[0].name, role: result.rows[0].role } });
    });
  }).catch(function(err) {
    res.status(400).json({ error: err.message });
  });
});

app.get('/api/users', auth, adminOnly, function(req, res) {
  pool.query('SELECT id, email, name, role, active, created_at FROM users ORDER BY created_at').then(function(result) {
    res.json(result.rows);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.put('/api/users/:id/approve', auth, adminOnly, function(req, res) {
  pool.query('UPDATE users SET active=TRUE WHERE id=$1 RETURNING id, email, name, active', [req.params.id]).then(function(result) {
    res.json(result.rows[0]);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.delete('/api/users/:id', auth, adminOnly, function(req, res) {
  pool.query('DELETE FROM users WHERE id=$1', [req.params.id]).then(function() {
    res.json({ success: true });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.post('/api/uploads', auth, function(req, res) {
  var etiket = req.body.etiket;
  var fat = req.body.fat || [];
  var akt = req.body.akt || [];
  var sat = req.body.sat || [];
  var tek = req.body.tek || [];
  var meta = req.body.meta || {};
  pool.query(
    'INSERT INTO excel_uploads (etiket, uploaded_by, fat_data, akt_data, sat_data, tek_data, meta) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, etiket, tarih, meta',
    [etiket, req.user.id, JSON.stringify(fat), JSON.stringify(akt), JSON.stringify(sat), JSON.stringify(tek), JSON.stringify(meta)]
  ).then(function(result) {
    res.json(result.rows[0]);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.get('/api/uploads', auth, function(req, res) {
  pool.query('SELECT id, etiket, tarih, uploaded_by, meta FROM excel_uploads ORDER BY tarih DESC').then(function(result) {
    res.json(result.rows);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.get('/api/uploads/:id', auth, function(req, res) {
  pool.query('SELECT * FROM excel_uploads WHERE id=$1', [req.params.id]).then(function(result) {
    if (!result.rows[0]) return res.status(404).json({ error: 'Bulunamadi' });
    var row = result.rows[0];
    res.json({
      id: row.id,
      etiket: row.etiket,
      tarih: row.tarih,
      meta: row.meta,
      data: {
        fat: row.fat_data || [],
        akt: row.akt_data || [],
        sat: row.sat_data || [],
        tek: row.tek_data || []
      }
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.delete('/api/uploads/:id', auth, function(req, res) {
  pool.query('DELETE FROM excel_uploads WHERE id=$1', [req.params.id]).then(function() {
    res.json({ success: true });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// AI proxy - CORS sorununu aşmak için backend üzerinden çağır
app.post('/api/ai', auth, function(req, res) {
  var prompt = req.body.prompt;
  var apiKey = req.body.apiKey;
  if(!prompt || !apiKey) return res.status(400).json({ error: 'Eksik parametre' });
  var https = require('https');
  var body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });
  var options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  var reqAI = https.request(options, function(resAI) {
    var data = '';
    resAI.on('data', function(chunk) { data += chunk; });
    resAI.on('end', function() {
      try {
        res.json(JSON.parse(data));
      } catch(e) {
        res.status(500).json({ error: 'Parse hatasi' });
      }
    });
  });
  reqAI.on('error', function(e) {
    res.status(500).json({ error: e.message });
  });
  reqAI.write(body);
  reqAI.end();
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  initDB().then(function() {
    console.log('Server ' + PORT + ' portunda calisiyor');
  }).catch(function(err) {
    console.error('DB hatasi:', err.message);
    process.exit(1);
  });
});
