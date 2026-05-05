const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'harmanli-secret-key';
const N8N_API_KEY = process.env.N8N_API_KEY || 'change-this-key';
const ADMIN_EMAIL = 'b.erdogan@harmanlikimya.com';

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT FALSE');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user'");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS region VARCHAR(100)');
  await pool.query(`CREATE TABLE IF NOT EXISTS excel_uploads (
    id SERIAL PRIMARY KEY,
    etiket VARCHAR(255),
    tarih TIMESTAMP DEFAULT NOW(),
    uploaded_by INTEGER REFERENCES users(id),
    fat_data JSONB,
    akt_data JSONB,
    sat_data JSONB,
    tek_data JSONB,
    meta JSONB
  )`);
  await pool.query('ALTER TABLE excel_uploads ADD COLUMN IF NOT EXISTS mst_data JSONB');
  await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query('UPDATE users SET active=TRUE, role=$1 WHERE email=$2', ['admin', ADMIN_EMAIL]);

  await pool.query(`CREATE TABLE IF NOT EXISTS llm_company_knowledge (
    id SERIAL PRIMARY KEY,
    kategori VARCHAR(50) NOT NULL,
    anahtar VARCHAR(200) NOT NULL,
    deger TEXT,
    notlar TEXT,
    aktif BOOLEAN DEFAULT TRUE,
    olusturan VARCHAR(100) DEFAULT 'Buğra',
    olusturma_tarihi TIMESTAMP DEFAULT NOW(),
    son_kullanim TIMESTAMP,
    kullanim_sayisi INTEGER DEFAULT 0,
    UNIQUE(kategori, anahtar)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_lck_kategori ON llm_company_knowledge(kategori) WHERE aktif=TRUE');

  await pool.query(`CREATE TABLE IF NOT EXISTS llm_oneriler (
    id SERIAL PRIMARY KEY,
    aktivite_no INTEGER NOT NULL,
    card_code VARCHAR(20) NOT NULL,
    musteri VARCHAR(255),
    sistem CHAR(1),
    temsilci VARCHAR(255),
    aktivite_tarihi TIMESTAMP,
    llm_yorum JSONB,
    sicaklik_etiketi VARCHAR(20),
    asama VARCHAR(50),
    kalite_skoru CHAR(1),
    sonuc_onerisi VARCHAR(50),
    sap_sonuc VARCHAR(50),
    cakisma BOOLEAN DEFAULT FALSE,
    onerilen_aksiyonlar JSONB,
    durum VARCHAR(20) DEFAULT 'pending',
    onaylayan_email VARCHAR(255),
    onay_tarihi TIMESTAMP,
    duzelten_metin TEXT,
    red_sebebi TEXT,
    olusturma_tarihi TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE llm_oneriler ALTER COLUMN kalite_skoru TYPE VARCHAR(10)");
  await pool.query("ALTER TABLE llm_oneriler ALTER COLUMN sistem TYPE VARCHAR(5)");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_lo_aktivite_no ON llm_oneriler(aktivite_no)");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_lo_durum ON llm_oneriler(durum, olusturma_tarihi DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_lo_card ON llm_oneriler(card_code)');

  await pool.query(`CREATE TABLE IF NOT EXISTS llm_cost_log (
    id SERIAL PRIMARY KEY,
    tarih DATE DEFAULT CURRENT_DATE,
    zaman TIMESTAMP DEFAULT NOW(),
    workflow_adi VARCHAR(100),
    aktivite_no INTEGER,
    card_code VARCHAR(20),
    model VARCHAR(50),
    input_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    hesaplanan_maliyet_usd NUMERIC(10,6),
    basarili BOOLEAN DEFAULT TRUE,
    hata_mesaji TEXT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_lcl_tarih ON llm_cost_log(tarih DESC)');

  await pool.query(`CREATE TABLE IF NOT EXISTS llm_mail_tokens (
    id SERIAL PRIMARY KEY,
    oneri_id INTEGER REFERENCES llm_oneriler(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,
    olusturma_tarihi TIMESTAMP DEFAULT NOW(),
    gecerli_end_t TIMESTAMP NOT NULL,
    kullanildi_mi BOOLEAN DEFAULT FALSE,
    kullanilma_tarihi TIMESTAMP,
    kullanilan_email VARCHAR(255),
    kullanilan_ip VARCHAR(50)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_lmt_token ON llm_mail_tokens(token) WHERE kullanildi_mi=FALSE');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_lmt_oneri ON llm_mail_tokens(oneri_id)');

  await pool.query("DELETE FROM llm_company_knowledge WHERE kategori = 'eski_temsilci'");
  await pool.query("DELETE FROM llm_company_knowledge WHERE kategori = 'numune_suresi' AND anahtar != 'genel'");

  await seedLLMKnowledge();

  console.log('DB ready');
}

async function seedLLMKnowledge() {
  const rakipler = [
    ['Henkel/Loctite', 'Ana rakip',         'Anaerobik yapıştırıcı, vidalı bağlantı (243, 271, 511, 577, 518)'],
    ['Henkel/Teroson', 'Ana rakip',         'MS polimer, PU, otomotiv onarım, sızdırmazlık'],
    ['WEICON',         'Orta-üst rakip',    'Yapısal yapıştırıcı, onarım kitleri, anaerobik'],
    ['Permabond',      'Ana rakip',         'Anaerobik, anaerobik yapısal, UV'],
    ['3M',             'Orta rakip',        'VHB tape, Scotch-Weld, yapısal akrilik'],
    ['Bostik',         'Orta rakip',        'Yapıştırıcı, sızdırmazlık, MS polimer'],
    ['Delo',           'Premium rakip',     'Endüstriyel UV, yapısal akrilik, elektronik'],
    ['Dymax',          'Premium rakip',     'UV adhesive, medikal, elektronik'],
    ['Force',          'Orta segment rakip','Anaerobik yapıştırıcı, ucuz alternatif'],
    ['Cyberbond',      'Orta rakip',        'Cyanoacrylate, anaerobik'],
    ['Novachem',       'Orta rakip',        'Yapıştırıcı, sızdırmazlık']
  ];
  for (const [marka, segment, urunler] of rakipler) {
    await pool.query(
      `INSERT INTO llm_company_knowledge (kategori, anahtar, deger, notlar)
       VALUES ('rakip', $1, $2, $3)
       ON CONFLICT (kategori, anahtar) DO NOTHING`,
      [marka, segment, urunler]
    );
  }

  const kararVericiKaliplari = [
    ['karar_verici', 'YUKSEK', JSON.stringify({
      unvanlar: ['Satın alma şefi','Satın alma müdürü','Satın alma sorumlusu','Satın alma yetkilisi','Genel müdür','Patron','Sahip','Ortak','Firma sahibi','İşletme müdürü'],
      aksiyon: 'Direkt teklif/numune devri'
    })],
    ['etkileyici', 'ORTA', JSON.stringify({
      unvanlar: ['Mühendis','Bakım mühendisi','Üretim sorumlusu','Ar-Ge mühendisi','Teknik müdür','Kalite kontrol'],
      aksiyon: 'Teknik ikna gerek'
    })],
    ['kullanici', 'DUSUK', JSON.stringify({
      unvanlar: ['Usta','Operatör','Tekniker','İşçi'],
      aksiyon: 'Ürün denenmesi için'
    })],
    ['araci', 'BILGI', JSON.stringify({
      unvanlar: ['Sekreter','Asistan','Stajyer'],
      aksiyon: 'Karar vericiye yönlendir'
    })]
  ];
  for (const [kategori, anahtar, deger] of kararVericiKaliplari) {
    await pool.query(
      `INSERT INTO llm_company_knowledge (kategori, anahtar, deger, notlar)
       VALUES ('karar_verici_kalibi', $1, $2, $3)
       ON CONFLICT (kategori, anahtar) DO NOTHING`,
      [kategori, deger, anahtar]
    );
  }

  await pool.query(
    `INSERT INTO llm_company_knowledge (kategori, anahtar, deger, notlar)
     VALUES ('numune_suresi', 'genel', '7-14', '10. gün ilk hatırlatma — tüm ürün tipleri için tek kural')
     ON CONFLICT (kategori, anahtar) DO NOTHING`
  );
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

function n8nAuth(req, res, next) {
  var key = req.headers['x-api-key'];
  if (!key || key !== N8N_API_KEY) return res.status(401).json({ error: 'Geçersiz API key' });
  next();
}

app.get('/api/status', function(req, res) {
  res.json({ status: 'HarmanliCRM API calisiyor' });
});

app.post('/api/register', function(req, res) {
  var email = req.body.email, password = req.body.password, name = req.body.name;
  pool.query('SELECT COUNT(*)::int AS cnt FROM users').then(function(countResult) {
    var userCount = countResult.rows[0].cnt;
    var isAdmin = (email === ADMIN_EMAIL);
    if (userCount > 0 && !isAdmin) {
      return res.status(403).json({ error: 'Yeni kayıt alımı kapalıdır. Hesap için yöneticinize başvurun.' });
    }
    return bcrypt.hash(password, 10).then(function(hash) {
      return pool.query(
        'INSERT INTO users (email, password, name, active, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role, active',
        [email, hash, name, isAdmin, isAdmin ? 'admin' : 'user']
      );
    }).then(function(result) {
      if (!isAdmin) return res.json({ pending: true, message: 'Kaydınız alındı. Admin onayından sonra giriş yapabilirsiniz.' });
      var token = jwt.sign({ id: result.rows[0].id, role: result.rows[0].role }, JWT_SECRET);
      res.json({ token, user: result.rows[0] });
    });
  }).catch(function(err) {
    res.status(400).json({ error: err.message });
  });
});

app.post('/api/login', function(req, res) {
  var email = req.body.email, password = req.body.password;
  pool.query('SELECT * FROM users WHERE email=$1', [email]).then(function(result) {
    if (!result.rows[0]) return res.status(400).json({ error: 'Kullanici bulunamadi' });
    if (!result.rows[0].active) return res.status(403).json({ error: 'Hesabınız henüz onaylanmadı.' });
    return bcrypt.compare(password, result.rows[0].password).then(function(valid) {
      if (!valid) return res.status(400).json({ error: 'Hatali sifre' });
      var token = jwt.sign({ id: result.rows[0].id, email: result.rows[0].email, role: result.rows[0].role }, JWT_SECRET);
      res.json({ token, user: { id: result.rows[0].id, email: result.rows[0].email, name: result.rows[0].name, role: result.rows[0].role } });
    });
  }).catch(function(err) {
    res.status(400).json({ error: err.message });
  });
});

app.get('/api/users', auth, adminOnly, function(req, res) {
  pool.query('SELECT id, email, name, role, active, phone, department, region, created_at FROM users ORDER BY created_at')
    .then(function(r) { res.json(r.rows); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.put('/api/users/:id/approve', auth, adminOnly, function(req, res) {
  pool.query('UPDATE users SET active=TRUE WHERE id=$1 RETURNING id, email, name, active', [req.params.id])
    .then(function(r) { res.json(r.rows[0]); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.delete('/api/users/:id', auth, adminOnly, function(req, res) {
  pool.query('DELETE FROM users WHERE id=$1', [req.params.id])
    .then(function() { res.json({ success: true }); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.post('/api/users', auth, adminOnly, function(req, res) {
  var email = req.body.email, password = req.body.password, name = req.body.name;
  var phone = req.body.phone || null;
  var department = req.body.department || null;
  var region = req.body.region || null;
  var role = req.body.role || 'user';
  var active = req.body.active !== undefined ? req.body.active : true;

  if (!email || !password) return res.status(400).json({ error: 'E-posta ve şifre zorunlu' });
  if (password.length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı' });

  bcrypt.hash(password, 10).then(function(hash) {
    return pool.query(
      'INSERT INTO users (email, password, name, role, active, phone, department, region) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, email, name, role, active, phone, department, region, created_at',
      [email, hash, name, role, active, phone, department, region]
    );
  }).then(function(r) {
    res.json(r.rows[0]);
  }).catch(function(err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu e-posta zaten kayıtlı' });
    res.status(500).json({ error: err.message });
  });
});

app.put('/api/users/:id', auth, adminOnly, function(req, res) {
  var id = req.params.id;
  var name = req.body.name;
  var email = req.body.email;
  var phone = req.body.phone;
  var department = req.body.department;
  var region = req.body.region;

  pool.query(
    'UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), phone=$3, department=$4, region=$5 WHERE id=$6 RETURNING id, email, name, role, active, phone, department, region',
    [name, email, phone, department, region, id]
  ).then(function(r) {
    if (!r.rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(r.rows[0]);
  }).catch(function(err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu e-posta zaten başka bir kullanıcıda kayıtlı' });
    res.status(500).json({ error: err.message });
  });
});

app.put('/api/users/:id/password', auth, adminOnly, function(req, res) {
  var id = req.params.id;
  var newPassword = req.body.password;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı' });

  bcrypt.hash(newPassword, 10).then(function(hash) {
    return pool.query('UPDATE users SET password=$1 WHERE id=$2 RETURNING id, email, name', [hash, id]);
  }).then(function(r) {
    if (!r.rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json({ success: true, user: r.rows[0] });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.put('/api/users/:id/role', auth, adminOnly, function(req, res) {
  var id = req.params.id;
  var role = req.body.role;
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'Geçersiz rol' });

  if (parseInt(id) === req.user.id) return res.status(400).json({ error: 'Kendi rolünüzü değiştiremezsiniz' });

  pool.query('UPDATE users SET role=$1 WHERE id=$2 RETURNING id, email, name, role', [role, id])
    .then(function(r) {
      if (!r.rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      res.json(r.rows[0]);
    })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.get('/api/users/:id', auth, adminOnly, function(req, res) {
  pool.query('SELECT id, email, name, role, active, phone, department, region, created_at FROM users WHERE id=$1', [req.params.id])
    .then(function(r) {
      if (!r.rows[0]) return res.status(404).json({ error: 'Bulunamadı' });
      res.json(r.rows[0]);
    })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.post('/api/uploads', auth, function(req, res) {
  var { etiket, fat=[], akt=[], sat=[], tek=[], mst=[], meta={} } = req.body;
  pool.query(
    'INSERT INTO excel_uploads (etiket, uploaded_by, fat_data, akt_data, sat_data, tek_data, mst_data, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, etiket, tarih, meta',
    [etiket, req.user.id, JSON.stringify(fat), JSON.stringify(akt), JSON.stringify(sat), JSON.stringify(tek), JSON.stringify(mst), JSON.stringify(meta)]
  ).then(function(r) {
    res.json(r.rows[0]);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.get('/api/uploads', auth, function(req, res) {
  pool.query('SELECT id, etiket, tarih, uploaded_by, meta FROM excel_uploads ORDER BY tarih DESC')
    .then(function(r) { res.json(r.rows); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
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
        tek: row.tek_data || [],
        mst: row.mst_data || []
      }
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.delete('/api/uploads/:id', auth, function(req, res) {
  pool.query('DELETE FROM excel_uploads WHERE id=$1', [req.params.id])
    .then(function() { res.json({ success: true }); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.post('/api/kv/:key', auth, function(req, res) {
  var key = req.params.key;
  var value = typeof req.body.value === 'string' ? req.body.value : JSON.stringify(req.body.value);
  pool.query(
    'INSERT INTO kv_store (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
    [key, value]
  ).then(function() {
    res.json({ ok: true, key });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.get('/api/kv/:key', auth, function(req, res) {
  pool.query('SELECT value FROM kv_store WHERE key=$1', [req.params.key]).then(function(result) {
    if (!result.rows[0]) return res.status(404).json({ error: 'Bulunamadi' });
    res.json({ value: result.rows[0].value });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.post('/api/ai', auth, function(req, res) {
  var prompt = req.body.prompt;
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!prompt) return res.status(400).json({ error: 'Eksik parametre' });
  if (!apiKey) return res.status(500).json({ error: 'API key sunucuda tanımlı değil' });
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
      try { res.json(JSON.parse(data)); }
      catch(e) { res.status(500).json({ error: 'Parse hatasi' }); }
    });
  });
  reqAI.on('error', function(e) { res.status(500).json({ error: e.message }); });
  reqAI.write(body);
  reqAI.end();
});

// ── LLM ENDPOINTS — n8n için (X-API-Key auth) ──────────────────────

app.get('/api/llm/knowledge', n8nAuth, function(req, res) {
  var kategori = req.query.kategori;
  var sql, params;
  if (kategori) {
    sql = 'SELECT kategori, anahtar, deger, notlar FROM llm_company_knowledge WHERE aktif=TRUE AND kategori=$1 ORDER BY anahtar';
    params = [kategori];
  } else {
    sql = 'SELECT kategori, anahtar, deger, notlar FROM llm_company_knowledge WHERE aktif=TRUE ORDER BY kategori, anahtar';
    params = [];
  }
  pool.query(sql, params)
    .then(function(r) { res.json(r.rows); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

app.post('/api/llm/oneri', n8nAuth, function(req, res) {
  var b = req.body;
  console.log('[llm/oneri] geldi: aktivite_no=' + b.aktivite_no +
              ' musteri=' + (b.musteri || '').substring(0,40) +
              ' kalite=' + b.kalite_skoru +
              ' sistem=' + b.sistem +
              ' sicaklik=' + b.sicaklik_etiketi +
              ' asama=' + b.asama);
pool.query(
    `INSERT INTO llm_oneriler (
      aktivite_no, card_code, musteri, sistem, temsilci, aktivite_tarihi,
      llm_yorum, sicaklik_etiketi, asama, kalite_skoru, sonuc_onerisi, sap_sonuc, cakisma,
      onerilen_aksiyonlar
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (aktivite_no) DO UPDATE SET
      card_code = EXCLUDED.card_code,
      musteri = EXCLUDED.musteri,
      sistem = EXCLUDED.sistem,
      temsilci = EXCLUDED.temsilci,
      aktivite_tarihi = EXCLUDED.aktivite_tarihi,
      llm_yorum = EXCLUDED.llm_yorum,
      sicaklik_etiketi = EXCLUDED.sicaklik_etiketi,
      asama = EXCLUDED.asama,
      kalite_skoru = EXCLUDED.kalite_skoru,
      sonuc_onerisi = EXCLUDED.sonuc_onerisi,
      sap_sonuc = EXCLUDED.sap_sonuc,
      cakisma = EXCLUDED.cakisma,
      onerilen_aksiyonlar = EXCLUDED.onerilen_aksiyonlar
    WHERE llm_oneriler.durum = 'pending'
    RETURNING id, (xmax = 0) AS yeni_kayit`,
    [
      b.aktivite_no, b.card_code, b.musteri,
      (b.sistem || '').toString().substring(0,1) || null,
      b.temsilci, b.aktivite_tarihi,
      JSON.stringify(b.llm_yorum || {}),
      b.sicaklik_etiketi, b.asama, b.kalite_skoru, b.sonuc_onerisi, b.sap_sonuc, b.cakisma || false,
      JSON.stringify(b.onerilen_aksiyonlar || [])
    ]
  ).then(function(r) {
    if (!r.rows[0]) {
      console.log('[llm/oneri] ATLANDI (zaten karar verilmiş): aktivite_no=' + b.aktivite_no);
      res.json({ success: true, skipped: true, reason: 'already_decided' });
    } else if (r.rows[0].yeni_kayit) {
      console.log('[llm/oneri] YENİ id=' + r.rows[0].id + ' aktivite_no=' + b.aktivite_no);
      res.json({ id: r.rows[0].id, success: true, action: 'inserted' });
    } else {
      console.log('[llm/oneri] GÜNCELLENDİ id=' + r.rows[0].id + ' aktivite_no=' + b.aktivite_no);
      res.json({ id: r.rows[0].id, success: true, action: 'updated' });
    }
  }).catch(function(err) {
    console.error('[llm/oneri] HATA: ' + err.message + ' | aktivite_no=' + b.aktivite_no + ' kalite=' + b.kalite_skoru + ' card=' + b.card_code);
    res.status(500).json({ error: err.message });
  });
});

// ── FAZ 2: LLM FEEDBACK ENDPOINT — geçmiş düzeltmeler/redler/onaylar ──
app.get('/api/llm/feedback', n8nAuth, function(req, res) {
  pool.query(
    `SELECT 
      id, musteri, asama, sicaklik_etiketi, kalite_skoru, sonuc_onerisi, sap_sonuc,
      onerilen_aksiyonlar, duzelten_metin, red_sebebi, durum, olusturma_tarihi
     FROM llm_oneriler
     WHERE (
       (durum = 'rejected' AND red_sebebi IS NOT NULL AND LENGTH(red_sebebi) > 5) OR 
       (durum = 'approved' AND duzelten_metin IS NOT NULL AND LENGTH(duzelten_metin) > 5)
     )
     AND olusturma_tarihi >= NOW() - INTERVAL '30 days'
     ORDER BY olusturma_tarihi DESC
     LIMIT 50`
  ).then(function(red_duz) {
    return pool.query(
      `SELECT id, musteri, asama, sicaklik_etiketi, sonuc_onerisi, onerilen_aksiyonlar
       FROM llm_oneriler
       WHERE durum = 'approved' 
         AND duzelten_metin IS NULL
         AND olusturma_tarihi >= NOW() - INTERVAL '30 days'
       ORDER BY olusturma_tarihi DESC
       LIMIT 20`
    ).then(function(onaylar) {
      console.log('[llm/feedback] ' + red_duz.rows.length + ' düzeltme/red + ' + onaylar.rows.length + ' onay verildi');
      res.json({
        success: true,
        duzeltmeler_redler: red_duz.rows,
        olumlu_ornekler: onaylar.rows,
        toplam: red_duz.rows.length + onaylar.rows.length
      });
    });
  }).catch(function(err) {
    console.error('[llm/feedback] HATA: ' + err.message);
    res.status(500).json({ error: err.message });
  });
});

app.post('/api/llm/cost', n8nAuth, function(req, res) {
  var b = req.body;
  pool.query(
    `INSERT INTO llm_cost_log (
      workflow_adi, aktivite_no, card_code, model,
      input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens,
      hesaplanan_maliyet_usd, basarili, hata_mesaji
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id`,
    [
      b.workflow_adi || 'llm-aktivite-batch',
      b.aktivite_no || null,
      b.card_code || null,
      b.model,
      b.input_tokens || 0,
      b.cached_input_tokens || 0,
      b.cache_creation_tokens || 0,
      b.output_tokens || 0,
      b.hesaplanan_maliyet_usd || 0,
      b.basarili !== false,
      b.hata_mesaji || null
    ]
  ).then(function(r) {
    res.json({ id: r.rows[0].id, success: true });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// ── LLM ADMIN ENDPOINTS — Web sayfası için (JWT auth, admin only) ──

app.get('/api/llm/cost/ozet', auth, adminOnly, function(req, res) {
  var gun = parseInt(req.query.gun) || 30;
  pool.query(
    `SELECT tarih,
            COUNT(*)                       AS cagri_sayisi,
            SUM(input_tokens)              AS toplam_input,
            SUM(cached_input_tokens)       AS toplam_cached,
            SUM(output_tokens)             AS toplam_output,
            SUM(hesaplanan_maliyet_usd)    AS toplam_usd
     FROM llm_cost_log
     WHERE tarih >= CURRENT_DATE - INTERVAL '1 day' * $1
     GROUP BY tarih
     ORDER BY tarih DESC`,
    [gun]
  ).then(function(r) {
    res.json(r.rows);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.get('/api/llm/oneriler', auth, adminOnly, function(req, res) {
  pool.query(
    `SELECT id, aktivite_no, card_code, musteri, sistem, temsilci, aktivite_tarihi,
            llm_yorum, sicaklik_etiketi, asama, kalite_skoru, sonuc_onerisi, sap_sonuc, cakisma,
            onerilen_aksiyonlar, durum, onaylayan_email, onay_tarihi, duzelten_metin, red_sebebi,
            olusturma_tarihi
     FROM llm_oneriler
     ORDER BY olusturma_tarihi DESC
     LIMIT 500`
  ).then(function(r) {
    res.json(r.rows);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.put('/api/llm/oneri/:id/onayla', auth, adminOnly, function(req, res) {
  var id = req.params.id;
  pool.query(
    `UPDATE llm_oneriler
     SET durum='approved', onaylayan_email=$1, onay_tarihi=NOW()
     WHERE id=$2
     RETURNING id, durum`,
    [req.user.email || 'admin', id]
  ).then(function(r) {
    if (!r.rows[0]) return res.status(404).json({ error: 'Öneri bulunamadı' });
    res.json({ success: true, id: r.rows[0].id, durum: r.rows[0].durum });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.put('/api/llm/oneri/:id/reddet', auth, adminOnly, function(req, res) {
  var id = req.params.id;
  var sebep = req.body.red_sebebi || '';
  pool.query(
    `UPDATE llm_oneriler
     SET durum='rejected', onaylayan_email=$1, onay_tarihi=NOW(), red_sebebi=$2
     WHERE id=$3
     RETURNING id, durum`,
    [req.user.email || 'admin', sebep, id]
  ).then(function(r) {
    if (!r.rows[0]) return res.status(404).json({ error: 'Öneri bulunamadı' });
    res.json({ success: true, id: r.rows[0].id, durum: r.rows[0].durum });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.put('/api/llm/oneri/:id/duzelt', auth, adminOnly, function(req, res) {
  var id = req.params.id;
  var metin = req.body.duzelten_metin || '';
  if (!metin) return res.status(400).json({ error: 'Düzeltme metni gerekli' });
  pool.query(
    `UPDATE llm_oneriler
     SET durum='approved', onaylayan_email=$1, onay_tarihi=NOW(), duzelten_metin=$2
     WHERE id=$3
     RETURNING id, durum`,
    [req.user.email || 'admin', metin, id]
  ).then(function(r) {
    if (!r.rows[0]) return res.status(404).json({ error: 'Öneri bulunamadı' });
    res.json({ success: true, id: r.rows[0].id, durum: r.rows[0].durum });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// LLM Bilgi Dosyasına yeni kayıt ekle (Öğret butonu için, admin JWT auth)
app.post('/api/llm/knowledge', auth, adminOnly, function(req, res) {
  var b = req.body;
  if (!b.kategori || !b.anahtar) return res.status(400).json({ error: 'Kategori ve anahtar zorunlu' });
  var izinliKategoriler = ['rakip', 'karar_verici_kalibi', 'numune_suresi'];
  if (izinliKategoriler.indexOf(b.kategori) === -1) {
    return res.status(400).json({ error: 'Geçersiz kategori' });
  }
  pool.query(
    `INSERT INTO llm_company_knowledge (kategori, anahtar, deger, notlar, olusturan)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kategori, anahtar) DO UPDATE
       SET deger = EXCLUDED.deger,
           notlar = EXCLUDED.notlar,
           aktif = TRUE
     RETURNING id, kategori, anahtar`,
    [b.kategori, b.anahtar, b.deger || null, b.notlar || null, req.user.email || 'admin']
  ).then(function(r) {
    res.json({ success: true, id: r.rows[0].id, kategori: r.rows[0].kategori, anahtar: r.rows[0].anahtar });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// ── MAIL TOKEN ENDPOINTS — Mail butonları için ──────────────────────

// n8n çağrılır — toplu öneri için tokenlar üret
app.post('/api/llm/mail-tokens', n8nAuth, function(req, res) {
  var crypto = require('crypto');
  var oneri_ids = req.body.oneri_ids;
  var saat_gecerli = req.body.saat_gecerli || 24;
  if (!Array.isArray(oneri_ids) || oneri_ids.length === 0) {
    return res.status(400).json({ error: 'oneri_ids array gerekli' });
  }
  var tokenList = oneri_ids.map(function(id) {
    return { oneri_id: id, token: crypto.randomBytes(24).toString('hex') };
  });
  var values = tokenList.map(function(t, i) {
    return '($' + (i*3+1) + ', $' + (i*3+2) + ', $' + (i*3+3) + ')';
  }).join(',');
  var params = [];
  tokenList.forEach(function(t) {
    params.push(t.oneri_id, t.token, "NOW() + INTERVAL '" + saat_gecerli + " hours'");
  });
  // Ayrı sorgu olarak — interval string olduğu için
  var sql = 'INSERT INTO llm_mail_tokens (oneri_id, token, gecerli_end_t) VALUES ';
  sql += tokenList.map(function(t, i) {
    return '($' + (i*2+1) + ', $' + (i*2+2) + ", NOW() + INTERVAL '" + saat_gecerli + " hours')";
  }).join(',');
  sql += ' RETURNING oneri_id, token';
  var p2 = [];
  tokenList.forEach(function(t) { p2.push(t.oneri_id, t.token); });
  pool.query(sql, p2)
    .then(function(r) { res.json({ success: true, tokens: r.rows }); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

// Mail buton — Onayla (token doğrula, anında onay, HTML cevap)
app.get('/llm-onay/approve', function(req, res) {
  var id = parseInt(req.query.id);
  var token = req.query.token;
  if (!id || !token) return res.status(400).send(htmlSayfa('❌ Geçersiz Bağlantı', 'Bağlantıda eksik bilgi var.', false));

  pool.query(
    `SELECT t.id AS token_id, t.kullanildi_mi, t.gecerli_end_t < NOW() AS expired,
            o.id AS oneri_id, o.musteri, o.durum
     FROM llm_mail_tokens t
     JOIN llm_oneriler o ON t.oneri_id = o.id
     WHERE t.token = $1 AND t.oneri_id = $2`,
    [token, id]
  ).then(function(r) {
    if (!r.rows[0]) return res.status(404).send(htmlSayfa('❌ Bağlantı Geçersiz', 'Bu bağlantı bulunamadı veya hatalı.', false));
    var rec = r.rows[0];
    if (rec.kullanildi_mi) return res.send(htmlSayfa('ℹ️ Zaten İşlenmiş', rec.musteri + ' önerisi zaten işlenmiş.', true));
    if (rec.expired) return res.status(410).send(htmlSayfa('⏰ Süresi Doldu', 'Bu bağlantının süresi dolmuş (24 saat). Site üzerinden onaylayabilirsiniz.', false));
    if (rec.durum !== 'pending') return res.send(htmlSayfa('ℹ️ Zaten İşlenmiş', rec.musteri + ' önerisi durum: ' + rec.durum, true));

    // Onayla + token harca
    pool.query(
      `UPDATE llm_oneriler SET durum='approved', onaylayan_email='mail-buton', onay_tarihi=NOW() WHERE id=$1`,
      [id]
    ).then(function() {
      return pool.query(
        `UPDATE llm_mail_tokens SET kullanildi_mi=TRUE, kullanilma_tarihi=NOW(), kullanilan_ip=$1 WHERE id=$2`,
        [req.ip, rec.token_id]
      );
    }).then(function() {
      res.send(htmlSayfa('✅ Onaylandı', rec.musteri + ' önerisi başarıyla onaylandı.', true));
    }).catch(function(err) {
      res.status(500).send(htmlSayfa('❌ Hata', err.message, false));
    });
  }).catch(function(err) {
    res.status(500).send(htmlSayfa('❌ Hata', err.message, false));
  });
});

// Mail buton — Reddet/Düzelt/Öğret → harmanlicrm.com'a yönlendir (token kullanılmadı, modal'da işlenecek)
app.get('/llm-onay/dispatch', function(req, res) {
  var id = parseInt(req.query.id);
  var action = req.query.action; // reject | duzelt | ogret
  var token = req.query.token;
  if (!id || !token || !action) return res.status(400).send(htmlSayfa('❌ Geçersiz', 'Eksik parametre', false));

  // Token doğrulama (kullanma yok, sadece geçerli mi diye bakıyoruz)
  pool.query(
    `SELECT t.id, t.kullanildi_mi, t.gecerli_end_t < NOW() AS expired
     FROM llm_mail_tokens t WHERE t.token=$1 AND t.oneri_id=$2`,
    [token, id]
  ).then(function(r) {
    if (!r.rows[0]) return res.status(404).send(htmlSayfa('❌ Geçersiz', 'Bağlantı bulunamadı', false));
    if (r.rows[0].expired) return res.status(410).send(htmlSayfa('⏰ Süresi Doldu', 'Süresi dolmuş, sitede manuel yapın', false));
    // Token doğru, harmanlicrm.com'a redirect
    res.redirect('/?focus=' + id + '&action=' + encodeURIComponent(action));
  }).catch(function(err) {
    res.status(500).send(htmlSayfa('❌ Hata', err.message, false));
  });
});

// HTML şablonu
function htmlSayfa(baslik, mesaj, basarili) {
  var renk = basarili ? '#10B981' : '#EF4444';
  return `<!DOCTYPE html><html lang="tr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${baslik} | HarmanlıCRM</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F8FAFC;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#fff;border-radius:14px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.08);max-width:440px;width:90%;text-align:center;border-top:5px solid ${renk}}
h1{margin:0 0 14px;font-size:26px;color:#1E3A8A}
p{margin:0 0 24px;color:#475569;font-size:15px;line-height:1.5}
a{display:inline-block;background:#1E3A8A;color:#fff;padding:11px 26px;border-radius:7px;text-decoration:none;font-weight:600;font-size:14px}
a:hover{background:#1E40AF}
.foot{margin-top:18px;font-size:12px;color:#94A3B8}
</style></head><body>
<div class="box">
<h1>${baslik}</h1>
<p>${mesaj}</p>
<a href="/?tab=llmonaylar">LLM Onaylar Sayfasına Git →</a>
<div class="foot">HarmanlıCRM — LLM Aktivite Sistemi</div>
</div></body></html>`;
}

// ── SPA CATCH-ALL — EN SONDA OLMALI ──────────────────────────────────
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
