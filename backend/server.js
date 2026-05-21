// ================================================================
// LOCO TM CONDITION MONITORING SYSTEM — Backend v2.0 FINAL
// Himnish Limited
// All bugs fixed — Railway production ready
// ================================================================
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const fs         = require('fs');
let nodemailer, cron;
try { nodemailer = require('nodemailer'); } catch(e) {}
try { cron = require('node-cron'); } catch(e) {}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const JWT_SECRET   = process.env.JWT_SECRET || 'himnish_loco_tm_2024_secret';
const PORT         = process.env.PORT || 3000;
const DATA_KEY     = process.env.DATA_API_KEY || 'himnish_data_key_2024';
const EMAIL_USER   = process.env.EMAIL_USER || '';
const EMAIL_PASS   = process.env.EMAIL_APP_PASSWORD || '';
const EMAIL_TO     = process.env.EMAIL_TO || 'piyush@himnishindia.com';
const EMAIL_SCHED  = process.env.EMAIL_SCHEDULE || '0 8 * * *'; // Daily 8AM

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── DB ──────────────────────────────────────────────────────────
const DB_FILE = process.env.DB_PATH || '/tmp/loco_tm_db.json';

// Fixed loco ID - never changes even after restart
const FIXED_LOCO = {
  id: 'loco_himnish_30211',
  name: 'WAP-7 Rajdhani Link',
  locoNumber: '30211',
  ipAddress: '192.168.1.1',
  depot: 'LKO Depot',
  series: 'WAP-7',
  tmCount: 6,
  status: 'offline',
  createdAt: '2025-01-01T00:00:00.000Z'
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // Always ensure fixed loco exists
      if (!data.locos.find(l => l.id === FIXED_LOCO.id)) {
        data.locos.push({...FIXED_LOCO});
        data.sensorReadings[FIXED_LOCO.id] = data.sensorReadings[FIXED_LOCO.id] || {};
        for(let i=1;i<=6;i++) {
          if(!data.sensorReadings[FIXED_LOCO.id]['TM'+i])
            data.sensorReadings[FIXED_LOCO.id]['TM'+i] = {latest:null,history:[]};
        }
      }
      return data;
    }
  } catch(e) {}
  const tmReadings = {};
  tmReadings[FIXED_LOCO.id] = {};
  for(let i=1;i<=6;i++) tmReadings[FIXED_LOCO.id]['TM'+i] = {latest:null,history:[]};
  return {
    users: [{
      id: 'usr_admin_001', username: 'admin',
      password: bcrypt.hashSync('Himnish@2024', 10),
      role: 'admin', name: 'Administrator',
      email: 'admin@himnish.com', assignedLocos: [],
      createdAt: new Date().toISOString()
    }],
    locos: [JSON.parse(JSON.stringify(FIXED_LOCO))],
    sensorReadings: tmReadings,
    alarmLogs: [],
    config: {
      logIntervalMinutes: 1,
      tempThresholds: { warning: 70, critical: 85 },
      vibThresholds: { warning: { rms: 5.0, peak: 10.0 }, critical: { rms: 8.0, peak: 15.0 } },
      bearingLifeBase: 50000
    }
  };
}

let db = loadDB();
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
  }, 500);
}

// ── Auth helpers ─────────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query._auth;
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Auth ─────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.users.find(u => u.username === username);
  if (!user || !await bcrypt.compare(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET, { expiresIn: '24h' }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, name: user.name, assignedLocos: user.assignedLocos || [] } });
});

// ── Users ────────────────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, (req, res) =>
  res.json(db.users.map(u => ({ ...u, password: undefined }))));

app.post('/api/users', auth, adminOnly, async (req, res) => {
  const { username, password, name, email, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: 'Username exists' });
  const u = {
    id: 'usr_' + Date.now(), username, name: name || username,
    email: email || '', password: await bcrypt.hash(password, 10),
    role: role || 'operator', assignedLocos: [], createdAt: new Date().toISOString()
  };
  db.users.push(u); saveDB();
  res.json({ ...u, password: undefined });
});

app.put('/api/users/:id', auth, adminOnly, async (req, res) => {
  const i = db.users.findIndex(u => u.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const { username, password, name, email, role, assignedLocos } = req.body;
  if (username) db.users[i].username = username;
  if (name) db.users[i].name = name;
  if (email !== undefined) db.users[i].email = email;
  if (role) db.users[i].role = role;
  if (assignedLocos !== undefined) db.users[i].assignedLocos = assignedLocos;
  if (password) db.users[i].password = await bcrypt.hash(password, 10);
  saveDB();
  res.json({ ...db.users[i], password: undefined });
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (req.params.id === 'usr_admin_001') return res.status(400).json({ error: 'Cannot delete primary admin' });
  db.users = db.users.filter(u => u.id !== req.params.id);
  saveDB(); res.json({ success: true });
});

// ── Locos ─────────────────────────────────────────────────────────
app.get('/api/locos', auth, (req, res) => {
  if (req.user.role === 'admin') return res.json(db.locos);
  const user = db.users.find(u => u.id === req.user.id);
  res.json(db.locos.filter(l => user?.assignedLocos?.includes(l.id)));
});

app.post('/api/locos', auth, adminOnly, (req, res) => {
  const { name, locoNumber, ipAddress, depot, series, tmCount } = req.body;
  if (!locoNumber || !ipAddress) return res.status(400).json({ error: 'Loco number and IP required' });
  if (db.locos.find(l => l.ipAddress === ipAddress)) return res.status(400).json({ error: 'IP already exists' });
  const loco = {
    id: 'loco_' + Date.now(), name: name || locoNumber,
    locoNumber, ipAddress, depot: depot || '', series: series || 'WAP-7',
    tmCount: parseInt(tmCount) || 6, status: 'offline',
    createdAt: new Date().toISOString()
  };
  db.locos.push(loco);
  db.sensorReadings[loco.id] = {};
  for (let i = 1; i <= loco.tmCount; i++)
    db.sensorReadings[loco.id][`TM${i}`] = { latest: null, history: [] };
  saveDB(); res.json(loco);
});

app.put('/api/locos/:id', auth, adminOnly, (req, res) => {
  const i = db.locos.findIndex(l => l.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  Object.assign(db.locos[i], req.body, { id: req.params.id });
  saveDB(); res.json(db.locos[i]);
});

app.delete('/api/locos/:id', auth, adminOnly, (req, res) => {
  db.locos = db.locos.filter(l => l.id !== req.params.id);
  delete db.sensorReadings[req.params.id];
  saveDB(); res.json({ success: true });
});

// ── Data Ingest (RUT200 → Server) ─────────────────────────────────
app.post('/api/data/ingest', (req, res) => {
  if (req.headers['x-api-key'] !== DATA_KEY)
    return res.status(401).json({ error: 'Invalid API key' });
  const { locoId, locoIp, tmData, timestamp } = req.body;
  if (!tmData) return res.status(400).json({ error: 'tmData required' });
  let loco = db.locos.find(l => l.id === locoId || l.ipAddress === locoIp);
  if (!loco) {
    loco = { id: "loco_"+((locoIp||"").replace(/\./g,"_")), name: "WAP-7 Loco", locoNumber: "30211", ipAddress: locoIp||"0.0.0.0", depot: "LKO Depot", series: "WAP-7", tmCount: 6, status: "offline", createdAt: new Date().toISOString() };
    db.locos.push(loco);
    db.sensorReadings[loco.id] = {};
    for(let i=1;i<=6;i++) db.sensorReadings[loco.id]["TM"+i]={latest:null,history:[]};
    saveDB();
    console.log("Auto-created loco:", locoIp);
  }
  const ts = timestamp || new Date().toISOString();
  if (!db.sensorReadings[loco.id]) db.sensorReadings[loco.id] = {};
  Object.keys(tmData).forEach(tm => {
    if (!db.sensorReadings[loco.id][tm])
      db.sensorReadings[loco.id][tm] = { latest: null, history: [] };
    const d = tmData[tm];
    // If sensor disconnected (isValid:false from BNI), store as disconnected
    if (d.ioLinkStatus === 'DISCONNECTED') {
      db.sensorReadings[loco.id][tm].latest = { 
        ioLinkStatus: 'DISCONNECTED', timestamp: ts,
        temp: null, vib: null
      };
      return; // skip history + alarm for disconnected
    }
    const r = { ...d, timestamp: ts };
    db.sensorReadings[loco.id][tm].latest = r;
    // Only store valid readings in history
    if (d.ioLinkStatus !== 'DISCONNECTED') {
      db.sensorReadings[loco.id][tm].history.push(r);
      if (db.sensorReadings[loco.id][tm].history.length > 10080)
        db.sensorReadings[loco.id][tm].history.shift();
      checkAlarm(loco, tm, r);
    }
  });
  const li = db.locos.findIndex(l => l.id === loco.id);
  if (li >= 0) { db.locos[li].status = 'online'; db.locos[li].lastSeen = ts; }
  saveDB();
  broadcast(loco.id, tmData, ts);
  res.json({ success: true, processed: Object.keys(tmData).length });
});

function checkAlarm(loco, tm, r) {
  const c = db.config;
  const alarms = [];
  if (r.temp != null) {
    if (r.temp >= c.tempThresholds.critical) alarms.push({ type: 'TEMP_CRITICAL', value: r.temp, threshold: c.tempThresholds.critical });
    else if (r.temp >= c.tempThresholds.warning) alarms.push({ type: 'TEMP_WARNING', value: r.temp, threshold: c.tempThresholds.warning });
  }
  if (r.vib?.rms != null) {
    if (r.vib.rms >= c.vibThresholds.critical.rms) alarms.push({ type: 'VIB_CRITICAL', value: r.vib.rms, threshold: c.vibThresholds.critical.rms });
    else if (r.vib.rms >= c.vibThresholds.warning.rms) alarms.push({ type: 'VIB_WARNING', value: r.vib.rms, threshold: c.vibThresholds.warning.rms });
  }
  alarms.forEach(a => {
    db.alarmLogs.unshift({
      id: `alm_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      locoId: loco.id, locoName: loco.name || loco.locoNumber,
      tm, ...a, timestamp: new Date().toISOString(), acknowledged: false
    });
  });
  if (db.alarmLogs.length > 5000) db.alarmLogs = db.alarmLogs.slice(0, 5000);
}

// ── Data Read ─────────────────────────────────────────────────────
app.get('/api/data/:locoId/latest', auth, (req, res) => {
  const d = db.sensorReadings[req.params.locoId] || {};
  const out = {};
  Object.keys(d).forEach(tm => { out[tm] = d[tm].latest; });
  res.json(out);
});

app.get('/api/data/:locoId/:tm/history', auth, (req, res) => {
  const hours = parseFloat(req.query.hours) || 24;
  const data = db.sensorReadings[req.params.locoId]?.[req.params.tm]?.history || [];
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  res.json(data.filter(d => d.timestamp >= cutoff));
});

// ── Bearing Life Prediction ───────────────────────────────────────
app.get('/api/bearing/:locoId/:tm/prediction', auth, (req, res) => {
  const hist = db.sensorReadings[req.params.locoId]?.[req.params.tm]?.history || [];
  if (hist.length < 5) return res.json({ prediction: null, message: 'Need at least 5 readings', healthIndex: null, condition: 'UNKNOWN', estimatedRemainingLife: null });
  const recent = hist.slice(-1440);
  const vibs = recent.filter(d => d.vib?.rms != null).map(d => d.vib.rms);
  const temps = recent.filter(d => d.temp != null).map(d => d.temp);
  if (!vibs.length) return res.json({ prediction: null, message: 'No vibration data' });
  const avgVib = vibs.reduce((a, b) => a + b, 0) / vibs.length;
  const avgTemp = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 25;
  const maxVib = Math.max(...vibs);
  const base = db.config.bearingLifeBase;
  const vf = Math.pow(2.5 / Math.max(avgVib, 0.1), 3);
  const tf = avgTemp >= 70 ? 0.5 : avgTemp >= 50 ? 0.75 : 1.0;
  const life = Math.round(base * vf * tf);
  const h1 = vibs.slice(0, Math.floor(vibs.length / 2));
  const h2 = vibs.slice(Math.floor(vibs.length / 2));
  const trend = ((h2.reduce((a,b)=>a+b,0)/h2.length - h1.reduce((a,b)=>a+b,0)/h1.length) / (h1.reduce((a,b)=>a+b,0)/h1.length) * 100).toFixed(1);
  const health = Math.max(0, Math.round(100 - (avgVib / db.config.vibThresholds.critical.rms) * 100));
  let cond = 'GOOD';
  if (avgVib >= db.config.vibThresholds.critical.rms) cond = 'CRITICAL';
  else if (avgVib >= db.config.vibThresholds.warning.rms) cond = 'WARNING';
  else if (avgVib >= db.config.vibThresholds.warning.rms * 0.7) cond = 'MARGINAL';
  const rec = { CRITICAL: 'IMMEDIATE INSPECTION REQUIRED', WARNING: 'Inspect within 7 days', MARGINAL: 'Monitor closely', GOOD: 'Normal operation' };
  res.json({
    locoId: req.params.locoId, tm: req.params.tm,
    timestamp: new Date().toISOString(),
    avgVibRms: avgVib.toFixed(3), maxVibPeak: maxVib.toFixed(3),
    avgTemperature: avgTemp.toFixed(1), estimatedRemainingLife: life,
    healthIndex: health, condition: cond,
    vibrationTrend: parseFloat(trend), recommendation: rec[cond]
  });
});

// ── Alarms ────────────────────────────────────────────────────────
app.get('/api/alarms', auth, (req, res) => {
  let alarms = db.alarmLogs;
  if (req.query.locoId) alarms = alarms.filter(a => a.locoId === req.query.locoId);
  if (req.user.role !== 'admin') {
    const user = db.users.find(u => u.id === req.user.id);
    alarms = alarms.filter(a => user?.assignedLocos?.includes(a.locoId));
  }
  res.json(alarms.slice(0, parseInt(req.query.limit) || 100));
});

app.put('/api/alarms/:id/ack', auth, (req, res) => {
  const alarm = db.alarmLogs.find(a => a.id === req.params.id);
  if (!alarm) return res.status(404).json({ error: 'Not found' });
  alarm.acknowledged = true;
  alarm.acknowledgedBy = req.user.username;
  alarm.acknowledgedAt = new Date().toISOString();
  saveDB(); res.json(alarm);
});

// ── Config ────────────────────────────────────────────────────────
app.get('/api/config', auth, (req, res) => res.json(db.config));
app.put('/api/config', auth, adminOnly, (req, res) => {
  Object.assign(db.config, req.body);
  saveDB(); res.json(db.config);
});

// ── Reports ───────────────────────────────────────────────────────
app.get('/api/report/:locoId', auth, (req, res) => {
  const loco = db.locos.find(l => l.id === req.params.locoId);
  if (!loco) return res.status(404).json({ error: 'Loco not found' });
  const { from, to, format = 'json' } = req.query;
  const fromTs = from || new Date(Date.now() - 86400000).toISOString();
  const toTs = to || new Date().toISOString();
  const readings = db.sensorReadings[req.params.locoId] || {};
  const data = {};
  Object.keys(readings).forEach(tm => {
    data[tm] = readings[tm].history.filter(d => d.timestamp >= fromTs && d.timestamp <= toTs);
  });
  if (format === 'csv') {
    let csv = 'Timestamp,TM,VibX,VibY,VibZ,VibRMS,VibPeak,CrestFactor,Temperature\n';
    Object.keys(data).forEach(tm => {
      data[tm].forEach(d => {
        csv += `${d.timestamp},${tm},${d.vib?.x||''},${d.vib?.y||''},${d.vib?.z||''},${d.vib?.rms||''},${d.vib?.peak||''},${d.vib?.crestFactor||''},${d.temp||''}\n`;
      });
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="loco_${loco.locoNumber}_${new Date().toISOString().slice(0,10)}.csv"`);
    return res.send(csv);
  }
  res.json({ loco, generatedAt: new Date().toISOString(), from: fromTs, to: toTs, data });
});

// ── Health ────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════
// PDF REPORT GENERATION
// ════════════════════════════════════════════════════════════════
app.get('/api/report/:locoId/pdf', auth, (req, res) => {
  const loco = db.locos.find(l => l.id === req.params.locoId);
  if (!loco) return res.status(404).json({ error: 'Loco not found' });
  const readings = db.sensorReadings[loco.id] || {};
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const alarms = (db.alarmLogs || []).filter(a => a.locoId === loco.id).slice(0, 20);

  // Generate HTML report
  let tmRows = '';
  for (let i = 1; i <= (loco.tmCount || 6); i++) {
    const tm = 'TM' + i;
    const d = readings[tm]?.latest;
    const status = !d || d.ioLinkStatus === 'DISCONNECTED' ? 'NO SENSOR' :
      d.vib?.rms >= (db.config?.vibThresholds?.critical?.rms || 8) ? 'CRITICAL' :
      d.vib?.rms >= (db.config?.vibThresholds?.warning?.rms || 5) ? 'WARNING' : 'NORMAL';
    const statusColor = status === 'CRITICAL' ? '#FC8181' : status === 'WARNING' ? '#F6AD55' : status === 'NORMAL' ? '#68D391' : '#CBD5E0';
    tmRows += `<tr>
      <td style="padding:8px 12px;border:1px solid #E2E8F0;font-weight:600">${tm}</td>
      <td style="padding:8px 12px;border:1px solid #E2E8F0"><span style="background:${statusColor};padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700">${status}</span></td>
      <td style="padding:8px 12px;border:1px solid #E2E8F0;font-family:monospace">${d?.temp != null ? d.temp.toFixed(1) + ' °C' : '--'}</td>
      <td style="padding:8px 12px;border:1px solid #E2E8F0;font-family:monospace">${d?.vib?.rms != null ? d.vib.rms.toFixed(4) : '--'}</td>
      <td style="padding:8px 12px;border:1px solid #E2E8F0;font-family:monospace">${d?.vib?.peak != null ? d.vib.peak.toFixed(4) : '--'}</td>
      <td style="padding:8px 12px;border:1px solid #E2E8F0;font-family:monospace">${d?.vib?.crestFactor != null ? d.vib.crestFactor.toFixed(2) : '--'}</td>
      <td style="padding:8px 12px;border:1px solid #E2E8F0;font-family:monospace">${d?.timestamp ? new Date(d.timestamp).toLocaleTimeString('en-IN') : '--'}</td>
    </tr>`;
  }

  let alarmRows = alarms.length ? alarms.map(a => `<tr>
    <td style="padding:6px 12px;border:1px solid #E2E8F0;font-size:12px">${new Date(a.timestamp).toLocaleString('en-IN')}</td>
    <td style="padding:6px 12px;border:1px solid #E2E8F0;font-size:12px">${a.tm || '--'}</td>
    <td style="padding:6px 12px;border:1px solid #E2E8F0;font-size:12px">${a.type}</td>
    <td style="padding:6px 12px;border:1px solid #E2E8F0;font-size:12px;font-family:monospace">${a.value?.toFixed ? a.value.toFixed(3) : a.value}</td>
    <td style="padding:6px 12px;border:1px solid #E2E8F0;font-size:12px">${a.acknowledged ? '✓ ACK' : 'PENDING'}</td>
  </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;padding:12px;color:#718096">No alarms recorded</td></tr>';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Calibri, Arial, sans-serif; margin: 0; padding: 0; color: #2D3748; }
  .header { background: #1A365D; color: white; padding: 24px 32px; }
  .header h1 { margin: 0; font-size: 22px; letter-spacing: 1px; }
  .header p { margin: 4px 0 0; font-size: 12px; color: #AECEF0; }
  .contact-bar { background: #2A4A7F; color: #AECEF0; padding: 8px 32px; font-size: 11px; }
  .content { padding: 24px 32px; }
  .section-title { font-size: 13px; font-weight: 700; color: #0BC5EA; letter-spacing: 2px; text-transform: uppercase; margin: 24px 0 10px; border-bottom: 2px solid #0BC5EA; padding-bottom: 4px; }
  .meta-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 20px; }
  .meta-box { background: #F7FAFC; border: 1px solid #E2E8F0; padding: 12px; border-radius: 6px; }
  .meta-label { font-size: 10px; font-weight: 700; color: #718096; text-transform: uppercase; letter-spacing: 1px; }
  .meta-val { font-size: 18px; font-weight: 700; color: #1A365D; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #1A365D; color: white; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; }
  tr:nth-child(even) td { background: #F7FAFC; }
  .footer { background: #1A365D; color: #AECEF0; padding: 14px 32px; font-size: 10px; margin-top: 32px; }
</style>
</head>
<body>
<div class="header">
  <h1>LOCO TM CONDITION MONITORING SYSTEM — STATUS REPORT</h1>
  <p>Himnish Limited | AI-Based Predictive Maintenance | Generated: ${ts}</p>
</div>
<div class="contact-bar">F-408, Aditya Corporate Hub, Ghaziabad, UP-201001 | +91-9873909306 | piyush@himnishindia.com | www.himnishprojects.com</div>
<div class="content">
  <div class="section-title">Locomotive Details</div>
  <div class="meta-grid">
    <div class="meta-box"><div class="meta-label">Loco Number</div><div class="meta-val">${loco.locoNumber || '--'}</div></div>
    <div class="meta-box"><div class="meta-label">Series</div><div class="meta-val">${loco.series || '--'}</div></div>
    <div class="meta-box"><div class="meta-label">Depot</div><div class="meta-val">${loco.depot || '--'}</div></div>
    <div class="meta-box"><div class="meta-label">Status</div><div class="meta-val" style="color:${loco.status==='online'?'#276749':'#9B2C2C'}">${(loco.status||'offline').toUpperCase()}</div></div>
  </div>
  <div class="section-title">Traction Motor Status</div>
  <table>
    <thead><tr><th>TM</th><th>Status</th><th>Temperature</th><th>VIB RMS</th><th>Peak</th><th>Crest Factor</th><th>Last Update</th></tr></thead>
    <tbody>${tmRows}</tbody>
  </table>
  <div class="section-title">Recent Alarms (Last 20)</div>
  <table>
    <thead><tr><th>Timestamp</th><th>TM</th><th>Alarm Type</th><th>Value</th><th>Status</th></tr></thead>
    <tbody>${alarmRows}</tbody>
  </table>
</div>
<div class="footer">Confidential | Himnish Limited | www.himnishprojects.com | Report auto-generated by LOCO TM CMS</div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `inline; filename="LOCO_${loco.locoNumber}_Report_${Date.now()}.html"`);
  res.send(html);
});

// ════════════════════════════════════════════════════════════════
// DEPOT / FLEET MANAGEMENT
// ════════════════════════════════════════════════════════════════

// Get all depots
app.get('/api/depots', auth, (req, res) => {
  const depotMap = {};
  db.locos.forEach(l => {
    const depot = l.depot || 'Unassigned';
    if (!depotMap[depot]) depotMap[depot] = { name: depot, locos: [], online: 0, totalTMs: 0 };
    depotMap[depot].locos.push(l);
    depotMap[depot].totalTMs += (l.tmCount || 6);
    if (l.status === 'online') depotMap[depot].online++;
  });
  res.json(Object.values(depotMap));
});

// Update loco depot
app.put('/api/locos/:id/depot', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const loco = db.locos.find(l => l.id === req.params.id);
  if (!loco) return res.status(404).json({ error: 'Not found' });
  loco.depot = req.body.depot;
  saveDB();
  res.json(loco);
});

// ════════════════════════════════════════════════════════════════
// EMAIL REPORT SYSTEM
// ════════════════════════════════════════════════════════════════

// Send test email
app.post('/api/email/test', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!EMAIL_USER || !EMAIL_PASS) return res.status(400).json({ error: 'Email not configured. Set EMAIL_USER and EMAIL_APP_PASSWORD in Railway variables.' });
  try {
    await sendReport('manual', req.body.to || EMAIL_TO);
    res.json({ success: true, message: 'Test email sent!' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get email config
app.get('/api/email/config', auth, (req, res) => {
  res.json({
    configured: !!(EMAIL_USER && EMAIL_PASS),
    emailUser: EMAIL_USER || '',
    emailTo: EMAIL_TO,
    schedule: EMAIL_SCHED,
    scheduleLabel: EMAIL_SCHED === '0 8 * * *' ? 'Daily at 8:00 AM' :
                   EMAIL_SCHED === '0 8 * * 1' ? 'Weekly (Monday 8 AM)' : EMAIL_SCHED
  });
});

// Save email recipients
app.put('/api/email/config', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.emailConfig = db.emailConfig || {};
  db.emailConfig.recipients = req.body.recipients || EMAIL_TO;
  db.emailConfig.schedule = req.body.schedule || '0 8 * * *';
  saveDB();
  res.json({ success: true });
});


app.get('/health', (req, res) =>
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), locos: db.locos.length }));

// ── WebSocket ─────────────────────────────────────────────────────
const clients = new Map();
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  let user;
  try { user = jwt.verify(params.get('token') || '', JWT_SECRET); }
  catch { ws.close(); return; }
  clients.set(ws, { user, alive: true });
  ws.send(JSON.stringify({ type: 'connected', user: user.username }));
  ws.on('pong', () => { const c = clients.get(ws); if (c) c.alive = true; });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// Keepalive ping every 25s
setInterval(() => {
  clients.forEach((c, ws) => {
    if (!c.alive) { ws.terminate(); clients.delete(ws); return; }
    c.alive = false; ws.ping();
  });
}, 25000);

function broadcast(locoId, tmData, timestamp) {
  const msg = JSON.stringify({ type: 'sensorUpdate', locoId, tmData, timestamp });
  clients.forEach((c, ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (c.user.role === 'admin') ws.send(msg);
    else {
      const u = db.users.find(u => u.id === c.user.id);
      if (u?.assignedLocos?.includes(locoId)) ws.send(msg);
    }
  });
}

// Offline detection every 30s
setInterval(() => {
  let changed = false;
  db.locos.forEach(l => {
    if (!l.lastSeen) return;
    const age = Date.now() - new Date(l.lastSeen).getTime();
    const ns = age > 300000 ? 'offline' : 'online';
    if (l.status !== ns) { l.status = ns; changed = true; }
  });
  if (changed) saveDB();
}, 30000);

// ── DEMO SIMULATOR ────────────────────────────────────────────────
if (process.env.DEMO_MODE === 'true') {
  // Auto-create demo loco if none exist
  if (db.locos.length === 0) {
    const dl = {
      id: 'loco_himnish_30211', name: 'WAP-7 Rajdhani Link',
      locoNumber: '30211', ipAddress: '192.168.1.1',
      depot: 'LKO Depot', series: 'WAP-7', tmCount: 6,
      status: 'offline', createdAt: new Date().toISOString()
    };
    db.locos.push(dl);
    db.sensorReadings[dl.id] = {};
    for (let i = 1; i <= 6; i++)
      db.sensorReadings[dl.id][`TM${i}`] = { latest: null, history: [] };
    saveDB();
    console.log('🚂 Demo loco WAP-7 #30211 auto-created');
  }
  console.log('🎭 DEMO MODE — simulating data every 5s');

  // Persistent base values per TM for realistic drift
  const base = {};
  db.locos.forEach(l => {
    base[l.id] = {};
    for (let i = 1; i <= (l.tmCount || 6); i++)
      base[l.id][`TM${i}`] = {
        rms: 1.0 + Math.random() * 2.5,
        temp: 40 + Math.random() * 25,
        drift: (Math.random() - 0.5) * 0.01
      };
  });

  setInterval(() => {
    db.locos.forEach(loco => {
      if (!base[loco.id]) {
        base[loco.id] = {};
        for (let i = 1; i <= (loco.tmCount || 6); i++)
          base[loco.id][`TM${i}`] = { rms: 1.5 + Math.random()*2, temp: 45 + Math.random()*20, drift: (Math.random()-0.5)*0.01 };
      }
      const tmData = {};
      const ts = new Date().toISOString();
      for (let i = 1; i <= (loco.tmCount || 6); i++) {
        const k = `TM${i}`;
        const b = base[loco.id][k];
        b.rms = Math.max(0.5, Math.min(12, b.rms + b.drift + (Math.random()-0.5)*0.04));
        b.temp = Math.max(30, Math.min(92, b.temp + (Math.random()-0.48)*0.3));
        const n = () => (Math.random()-0.5)*0.15;
        const vx = +(b.rms+n()).toFixed(4), vy = +(b.rms+n()).toFixed(4), vz = +(b.rms*0.8+n()).toFixed(4);
        const rms = +Math.sqrt((vx**2+vy**2+vz**2)/3).toFixed(4);
        const peak = +(rms*(1.8+Math.random()*0.4)).toFixed(4);
        tmData[k] = {
          vib: { x:vx, y:vy, z:vz, rms, peak, crestFactor:+(peak/rms).toFixed(2), freq:+(50+Math.random()*100).toFixed(1) },
          temp: +b.temp.toFixed(1), ioLinkStatus:'OK'
        };
        if (!db.sensorReadings[loco.id]) db.sensorReadings[loco.id] = {};
        if (!db.sensorReadings[loco.id][k]) db.sensorReadings[loco.id][k] = { latest:null, history:[] };
        const rec = { ...tmData[k], timestamp: ts };
        db.sensorReadings[loco.id][k].latest = rec;
        db.sensorReadings[loco.id][k].history.push(rec);
        if (db.sensorReadings[loco.id][k].history.length > 10080)
          db.sensorReadings[loco.id][k].history.shift();
        checkAlarm(loco, k, rec);
      }
      const li = db.locos.findIndex(l => l.id === loco.id);
      if (li >= 0) { db.locos[li].status = 'online'; db.locos[li].lastSeen = ts; }
      broadcast(loco.id, tmData, ts);
    });
    saveDB();
  }, 5000);
}


// ════════════════════════════════════════════════════════════════
// EMAIL REPORT FUNCTION
// ════════════════════════════════════════════════════════════════
async function sendReport(type = 'scheduled', toEmail = EMAIL_TO) {
  if (!nodemailer) throw new Error('nodemailer not installed');
  if (!EMAIL_USER || !EMAIL_PASS) throw new Error('Email not configured');
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  let locoSummary = '';
  db.locos.forEach(loco => {
    const readings = db.sensorReadings[loco.id] || {};
    let tmRows = '';
    for (let i = 1; i <= (loco.tmCount || 6); i++) {
      const tm = 'TM' + i;
      const d = readings[tm]?.latest;
      const status = !d || d.ioLinkStatus === 'DISCONNECTED' ? 'NO SENSOR' :
        d.vib?.rms >= (db.config?.vibThresholds?.critical?.rms || 8) ? 'CRITICAL' :
        d.vib?.rms >= (db.config?.vibThresholds?.warning?.rms || 5) ? 'WARNING' : 'NORMAL';
      const sc = status === 'CRITICAL' ? '#FC8181' : status === 'WARNING' ? '#F6AD55' : status === 'NORMAL' ? '#68D391' : '#CBD5E0';
      tmRows += `<tr><td style="padding:6px 10px;border:1px solid #E2E8F0">${tm}</td>
        <td style="padding:6px 10px;border:1px solid #E2E8F0"><span style="background:${sc};padding:2px 8px;border-radius:8px;font-size:11px;font-weight:700">${status}</span></td>
        <td style="padding:6px 10px;border:1px solid #E2E8F0;font-family:monospace">${d?.temp != null ? d.temp.toFixed(1)+'°C' : '--'}</td>
        <td style="padding:6px 10px;border:1px solid #E2E8F0;font-family:monospace">${d?.vib?.rms != null ? d.vib.rms.toFixed(4) : '--'}</td></tr>`;
    }
    const unack = (db.alarmLogs||[]).filter(a => a.locoId === loco.id && !a.acknowledged).length;
    locoSummary += `<div style="margin-bottom:20px;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden">
      <div style="background:#1A365D;color:white;padding:10px 16px"><span style="font-weight:700">${loco.locoNumber} — ${loco.name||''} (${loco.series||''})</span>
      <span style="float:right;background:${loco.status==='online'?'#276749':'#9B2C2C'};padding:2px 10px;border-radius:10px;font-size:11px">${(loco.status||'offline').toUpperCase()}</span></div>
      <div style="padding:12px">${unack>0?`<div style="background:#FFF5F5;border:1px solid #FC8181;border-radius:6px;padding:8px 12px;margin-bottom:10px;color:#9B2C2C;font-size:12px">⚠️ ${unack} unacknowledged alarm(s)</div>`:''}
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="background:#F7FAFC"><th style="padding:6px 10px;border:1px solid #E2E8F0;text-align:left">TM</th><th style="padding:6px 10px;border:1px solid #E2E8F0;text-align:left">Status</th><th style="padding:6px 10px;border:1px solid #E2E8F0;text-align:left">Temp</th><th style="padding:6px 10px;border:1px solid #E2E8F0;text-align:left">VIB RMS</th></tr>
        ${tmRows}</table></div></div>`;
  });

  const html = `<!DOCTYPE html><html><body style="font-family:Calibri,Arial,sans-serif;margin:0;padding:0;background:#F0F4F8">
<div style="max-width:700px;margin:20px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.1)">
  <div style="background:#1A365D;padding:24px 28px"><div style="font-size:20px;font-weight:700;color:white">LOCO TM CMS — ${type==='manual'?'Manual':'Scheduled'} Report</div>
  <div style="font-size:12px;color:#AECEF0;margin-top:4px">Himnish Limited | ${ts}</div></div>
  <div style="background:#2A4A7F;padding:6px 28px;font-size:11px;color:#AECEF0">F-408, Aditya Corporate Hub, Ghaziabad | +91-9873909306 | www.himnishprojects.com</div>
  <div style="padding:24px 28px">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
      <div style="background:#F7FAFC;border:1px solid #E2E8F0;padding:12px;border-radius:6px;text-align:center"><div style="font-size:10px;color:#718096;font-weight:700;text-transform:uppercase">Total Locos</div><div style="font-size:24px;font-weight:700;color:#1A365D">${db.locos.length}</div></div>
      <div style="background:#F7FAFC;border:1px solid #E2E8F0;padding:12px;border-radius:6px;text-align:center"><div style="font-size:10px;color:#718096;font-weight:700;text-transform:uppercase">Online</div><div style="font-size:24px;font-weight:700;color:#276749">${db.locos.filter(l=>l.status==='online').length}</div></div>
      <div style="background:#F7FAFC;border:1px solid #E2E8F0;padding:12px;border-radius:6px;text-align:center"><div style="font-size:10px;color:#718096;font-weight:700;text-transform:uppercase">Active Alarms</div><div style="font-size:24px;font-weight:700;color:#9B2C2C">${(db.alarmLogs||[]).filter(a=>!a.acknowledged).length}</div></div>
      <div style="background:#F7FAFC;border:1px solid #E2E8F0;padding:12px;border-radius:6px;text-align:center"><div style="font-size:10px;color:#718096;font-weight:700;text-transform:uppercase">TMs Monitored</div><div style="font-size:24px;font-weight:700;color:#2B6CB0">${db.locos.reduce((s,l)=>s+(l.tmCount||6),0)}</div></div>
    </div>
    <div style="font-size:13px;font-weight:700;color:#0BC5EA;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;border-bottom:2px solid #0BC5EA;padding-bottom:6px">LOCOMOTIVE STATUS</div>
    ${locoSummary}
    <div style="text-align:center;margin-top:16px"><a href="https://loco-tm-cms-production.up.railway.app" style="background:#1A365D;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px">Open Dashboard →</a></div>
  </div>
  <div style="background:#1A365D;color:#AECEF0;padding:14px 28px;font-size:10px;text-align:center">Confidential | Himnish Limited | LOCO TM CMS</div>
</div></body></html>`;

  const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  tls: { rejectUnauthorized: false }
});
  const recipients = db.emailConfig?.recipients || toEmail;
  await transporter.sendMail({
    from: `"LOCO TM CMS" <${EMAIL_USER}>`,
    to: recipients,
    subject: `[LOCO TM CMS] ${type==='manual'?'Manual':'Scheduled'} Status Report — ${new Date().toLocaleDateString('en-IN')}`,
    html
  });
  console.log('Email sent to:', recipients);
}

// ── EMAIL SCHEDULER ───────────────────────────────────────────────
if (cron && EMAIL_USER && EMAIL_PASS) {
  cron.schedule(EMAIL_SCHED, async () => {
    try { const db=loadDB(); await sendReport('scheduled', db.emailConfig?.recipients || EMAIL_TO); }
    catch(e) { console.error('Email error:', e.message); }
  }, { timezone: 'Asia/Kolkata' });
  console.log('Email scheduler active:', EMAIL_SCHED);
}


server.listen(PORT, '0.0.0.0', () =>
  console.log(`\n🚂 LOCO TM CMS v2.0 | Port:${PORT} | DEMO:${process.env.DEMO_MODE||'false'} | DB:${DB_FILE}\n`));

module.exports = { app, db };
