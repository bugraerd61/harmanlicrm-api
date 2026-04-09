const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'harmanli-secret-key';

async function initDB() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS users (' +
    'id SERIAL PRIMARY KEY,' +
    'email VARCHAR(255) UNIQUE NOT NULL,' +
    'password VARCHAR(255) NOT NULL,' +
    'name VARCHAR(255),' +
    'created_at TIMESTAMP DEFAULT NOW())'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS customers (' +
    'id SERIAL PRIMARY KEY,' +
    'name VARCHAR(255) NOT NULL,' +
    'company VARCHAR(255),' +
    'email VARCHAR(255),' +
    'phone VARCHAR(50),' +
    'city VARCHAR(100),' +
    'sector VARCHAR(100),' +
    'notes TEXT,' +
    'created_at TIMESTAMP DEFAULT NOW())'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS contacts (' +
    'id SERIAL PRIMARY KEY,' +
    'customer_id INTEGER REFERENCES customers(id),' +
    'date TIMESTAMP DEFAULT NOW(),' +
    'type VARCHAR(50),' +
    'notes TEXT,' +
    'next_action TEXT,' +
    'next_date DATE)'
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

app.get('/', function(req, res) {
  res.json({ status: 'HarmanliCRM API calisiyor' });
});

app.post('/api/register', function(req, res) {
  var email = req.body.email;
  var password = req.body.password;
  var name = req.body.name;
  bcrypt.hash(password, 10).then(function(hash) {
    return pool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, hash, name]
    );
  }).then(function(result) {
    var token = jwt.sign({ id: result.rows[0].id }, JWT_SECRET);
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
    return bcrypt.compare(password, result.rows[0].password).then(function(valid) {
      if (!valid) return res.status(400).json({ error: 'Hatali sifre' });
      var token = jwt.sign({ id: result.rows[0].id }, JWT_SECRET);
      res.json({ token: token, user: { id: result.rows[0].id, email: result.rows[0].email, name: result.rows[0].name } });
    });
  }).catch(function(err) {
    res.status(400).json({ error: err.message });
  });
});

app.get('/api/customers', auth, function(req, res) {
  pool.query('SELECT * FROM customers ORDER BY name').then(function(result) {
    res.json(result.rows);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.post('/api/customers', auth, function(req, res) {
  var b = req.body;
  pool.query(
    'INSERT INTO customers (name, company, email, phone, city, sector, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [b.name, b.company, b.email, b.phone, b.city, b.sector, b.notes]
  ).then(function(result) {
    res.json(result.rows[0]);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.put('/api/customers/:id', auth, function(req, res) {
  var b = req.body;
  pool.query(
    'UPDATE customers SET name=$1, company=$2, email=$3, phone=$4, city=$5, sector=$6, notes=$7 WHERE id=$8 RETURNING *',
    [b.name, b.company, b.email, b.phone, b.city, b.sector, b.notes, req.params.id]
  ).then(function(result) {
    res.json(result.rows[0]);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.delete('/api/customers/:id', auth, function(req, res) {
  pool.query('DELETE FROM customers WHERE id=$1', [req.params.id]).then(function() {
    res.json({ success: true });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.get('/api/customers/:id/contacts', auth, function(req, res) {
  pool.query('SELECT * FROM contacts WHERE customer_id=$1 ORDER BY date DESC', [req.params.id]).then(function(result) {
    res.json(result.rows);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

app.post('/api/customers/:id/contacts', auth, function(req, res) {
  var b = req.body;
  pool.query(
    'INSERT INTO contacts (customer_id, type, notes, next_action, next_date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.params.id, b.type, b.notes, b.next_action, b.next_date]
  ).then(function(result) {
    res.json(result.rows[0]);
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  initDB().then(function() {
    console.log('Server ' + PORT + ' portunda calisiyor');
  });
});
