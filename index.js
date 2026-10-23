// ============================================
// School WhatsApp Gateway — one linked WhatsApp number per school
// School Management SaaS, 22 Oct 2026
//
// A single instance serves every school. Each school gets:
//   - its own Baileys session (its own linked WhatsApp number)
//   - its own secret (set as WA_SCHOOL_SECRET in that school's
//     Apps Script project properties)
// Sessions persist under DATA_DIR/sessions/<schoolId>/ so a restart
// does not unlink anyone. Schools are registered by the platform
// owner with the master GATEWAY_API_KEY.
//
// Env: PORT (default 3000), GATEWAY_API_KEY (required),
//      DATA_DIR (default /data)
// ============================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GATEWAY_API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || '/data';
const SCHOOLS_FILE = path.join(DATA_DIR, 'schools.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const logger = pino({ level: 'warn' });

if (!API_KEY) {
  console.error('GATEWAY_API_KEY is not set — refusing to start.');
  process.exit(1);
}
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ---------- school registry ----------
function loadSchools() {
  try { return JSON.parse(fs.readFileSync(SCHOOLS_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveSchools(schools) {
  fs.writeFileSync(SCHOOLS_FILE, JSON.stringify(schools, null, 2));
}

// ---------- per-school sessions ----------
const sessions = new Map(); // schoolId -> { sock, qr, status, number }

async function startSession(schoolId) {
  const existing = sessions.get(schoolId);
  if (existing && existing.sock) return existing;
  const entry = { sock: null, qr: '', status: 'starting', number: '' };
  sessions.set(schoolId, entry);

  const authDir = path.join(SESSIONS_DIR, schoolId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['School Gateway', 'Chrome', '1.0.0']
  });
  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      entry.qr = qr;
      entry.status = 'waiting_qr';
    }
    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = '';
      entry.number = (sock.user && sock.user.id || '').split('@')[0].split(':')[0];
      console.log(`[${schoolId}] connected as ${entry.number}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      entry.status = 'disconnected';
      entry.sock = null;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log(`[${schoolId}] logged out — session cleared, school must re-link`);
      } else {
        console.log(`[${schoolId}] connection closed (${code}) — reconnecting in 5s`);
        setTimeout(() => startSession(schoolId).catch(() => {}), 5000);
      }
    }
  });
  return entry;
}

// ---------- auth ----------
function masterAuth(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}
function schoolAuth(req, res, next) {
  const schools = loadSchools();
  const school = schools[req.params.id];
  if (!school) return res.status(404).json({ error: 'Unknown school' });
  if (req.headers['x-school-secret'] !== school.secret) return res.status(401).json({ error: 'Invalid school secret' });
  req.school = school;
  next();
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => res.json({ ok: true, schools: Object.keys(loadSchools()).length }));

// Platform owner registers a school -> returns the secret ONCE.
app.post('/schools', masterAuth, async (req, res) => {
  const schoolId = String((req.body && req.body.schoolId) || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!schoolId) return res.status(400).json({ error: 'schoolId is required (letters, numbers, - or _)' });
  const schools = loadSchools();
  if (schools[schoolId]) return res.status(409).json({ error: 'School already exists', schoolId });
  const secret = crypto.randomBytes(24).toString('hex');
  schools[schoolId] = { secret, createdAt: new Date().toISOString() };
  saveSchools(schools);
  await startSession(schoolId).catch(() => {});
  res.json({ schoolId, secret });
});

app.get('/schools/:id/status', schoolAuth, async (req, res) => {
  const entry = await startSession(req.params.id).catch(() => null);
  if (!entry) return res.status(500).json({ error: 'Could not start session' });
  res.json({ connected: entry.status === 'connected', state: entry.status, number: entry.number || '' });
});

app.get('/schools/:id/qr', schoolAuth, async (req, res) => {
  const entry = await startSession(req.params.id).catch(() => null);
  if (!entry) return res.status(500).json({ error: 'Could not start session' });
  if (entry.status === 'connected') return res.json({ connected: true, number: entry.number || '', qrDataUrl: '' });
  let qrDataUrl = '';
  if (entry.qr) qrDataUrl = await QRCode.toDataURL(entry.qr, { margin: 1, width: 320 });
  res.json({ connected: false, state: entry.status, qrDataUrl });
});

app.post('/schools/:id/send', schoolAuth, async (req, res) => {
  const entry = sessions.get(req.params.id);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    return res.status(409).json({ error: 'School WhatsApp is not connected' });
  }
  const to = String((req.body && req.body.to) || '').replace(/\D/g, '');
  const message = String((req.body && req.body.message) || '');
  if (!to || !message) return res.status(400).json({ error: 'to and message are required' });
  try {
    await entry.sock.sendMessage(to + '@s.whatsapp.net', { text: message });
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: 'Send failed: ' + e.message });
  }
});

app.post('/schools/:id/disconnect', schoolAuth, async (req, res) => {
  const entry = sessions.get(req.params.id);
  try {
    if (entry && entry.sock) await entry.sock.logout();
  } catch (e) { /* already gone */ }
  sessions.delete(req.params.id);
  fs.rmSync(path.join(SESSIONS_DIR, req.params.id), { recursive: true, force: true });
  res.json({ success: true });
});

app.listen(PORT, async () => {
  console.log('School WhatsApp Gateway listening on ' + PORT);
  // Reconnect every school that was linked before a restart.
  const schools = loadSchools();
  for (const schoolId of Object.keys(schools)) {
    startSession(schoolId).catch(() => {});
  }
});
