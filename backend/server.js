// ================================================================
// LOCO TM CONDITION MONITORING SYSTEM — Backend v2.0 FINAL
// Himnish Limited
// All bugs fixed — Railway production ready
// ================================================================
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const path      = require('path');
const fs        = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'himnish_loco_tm_2024_secret';
const PORT       = process.env.PORT || 3000;
const DATA_KEY   = process.env.DATA_API_KEY || 'himnish_data_key_2024';

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

server.listen(PORT, '0.0.0.0', () =>
  console.log(`\n🚂 LOCO TM CMS v2.0 | Port:${PORT} | DEMO:${process.env.DEMO_MODE||'false'} | DB:${DB_FILE}\n`));

module.exports = { app, db };
