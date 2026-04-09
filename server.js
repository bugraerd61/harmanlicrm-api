const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'harmanli-secret-key';

// DB init
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      company VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      city VARCHAR(100),
      sector VARCHAR(100),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      date TIMESTAMP DEFAULT NOW(),
      type VARCHAR(50),
      notes TEXT,
      next_action TEXT,
      next_date DATE
    );
  `);
  console.log('DB ready');
}

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Geçersiz token' });
  }
}

// Routes
app.get('/', (req, res) => res.json({ status: 'HarmanliCRM API çalışıyor' }));

app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
    [email, hash, name]
  );
  const token = jwt.sign({ id: result.rows[0].id }, JWT_SECRET);
  res.json({ token, user: result.rows[0] });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if (!result.rows[0]) return res.status(400).json({ error: 'Kullanıcı bulunamadı' });
  const valid = await bcrypt.compare(password, result.rows[0].password);
  if (!valid) return res.status(400).json({ error: 'Hatalı şifre' });
  const token = jwt.sign({ id: result.rows[0].id }, JWT_SECR
