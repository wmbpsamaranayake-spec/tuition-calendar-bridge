require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy — needed for secure cookies to work
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-render-env-vars',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    dbName: process.env.DB_NAME || 'tuition_center',
    collectionName: 'sessions_auth'
  }),
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Blocks a request unless logged in. Pass a role ('admin') to also
// require that specific role. Browser page loads get redirected to the
// login page; API calls just get a 401/403 JSON response.
function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      if (req.accepts('html')) return res.redirect('/login');
      return res.status(401).json({ error: 'not_authenticated' });
    }
    if (role && req.session.role !== role) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

// Login page itself must NOT be behind auth (or nobody could ever log in).
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve the dashboard itself at /app — your team visits this URL. This is
// the main thing being protected: no session, no dashboard.
app.use('/app', requireAuth(), express.static(path.join(__dirname, 'public')));

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

let db;
let isConnected = false;

// SMS is optional — only active if TEXTITBIZ_API_KEY is set. This stays
// off automatically on any environment (e.g. staging) where you haven't
// configured it, so test data never triggers a real text.
function toLocalPhoneFormat(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, ''); // strip +, spaces, dashes
  if (digits.startsWith('0')) digits = '94' + digits.slice(1);   // 0771234567 -> 94771234567
  else if (!digits.startsWith('94')) digits = '94' + digits;      // 771234567  -> 94771234567
  return digits;
}

// How many minutes late/over before we bother warning about it — small
// gaps (a couple minutes) aren't worth flagging to the teacher.
const WARNING_THRESHOLD_MINUTES = 5;

function minutesBetween(expectedHHMM, actualHHMM) {
  if (!expectedHHMM || !actualHHMM) return null;
  const e = expectedHHMM.split(':').map(Number);
  const a = actualHHMM.split(':').map(Number);
  if (e.some(Number.isNaN) || a.some(Number.isNaN)) return null;
  return (a[0] * 60 + a[1]) - (e[0] * 60 + e[1]);
}

async function sendTextitSms(to, text) {
  const res = await fetch('https://api.textit.biz/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'X-API-VERSION': 'v1',
      'Authorization': `Basic ${process.env.TEXTITBIZ_API_KEY}`
    },
    body: JSON.stringify({ to, text })
  });
  const responseText = await res.text();
  return { status: res.status, body: responseText };
}

async function maybeSendSessionSms(session) {
  if (!process.env.TEXTITBIZ_API_KEY) return;
  try {
    const cls = await db.collection('classes').findOne({ id: session.classId });
    if (!cls) return;
    const teacher = await db.collection('teachers').findOne({ id: cls.teacherId });
    const orgSettings = await db.collection('settings').findOne({ _id: 'org' });

    const lateMinutes = minutesBetween(session.expectedStart, session.actualStart);
    const overMinutes = minutesBetween(session.expectedFinish, session.actualFinish);

    let warning = '';
    if (lateMinutes !== null && lateMinutes > WARNING_THRESHOLD_MINUTES) {
      warning += ` ⚠️ Started ${lateMinutes} min late.`;
    }
    if (overMinutes !== null && overMinutes > WARNING_THRESHOLD_MINUTES) {
      warning += ` ⚠️ Ran ${overMinutes} min over the scheduled end time.`;
    }

    const teacherLabel = teacher ? teacher.name : 'Teacher';
    const text = `Hi ${teacherLabel}, your session for "${cls.name}" on ${session.date} was logged: started ${session.actualStart}, ended ${session.actualFinish}. Physical: ${session.physical}, Online: ${session.online}, Absent: ${session.absent}.${warning}`;

    // Send to the teacher (if they have a number on file) and, in
    // addition, to the Operations Manager (if one is configured) — both
    // get the exact same message.
    const recipients = [];
    if (teacher && teacher.phone) {
      recipients.push({ label: teacher.name, to: toLocalPhoneFormat(teacher.phone) });
    }
    if (orgSettings && orgSettings.managerPhone) {
      recipients.push({ label: 'Operations Manager', to: toLocalPhoneFormat(orgSettings.managerPhone) });
    }

    for (const recipient of recipients) {
      const result = await sendTextitSms(recipient.to, text);
      console.log(`SMS to ${recipient.label} (${recipient.to}) — status ${result.status}:`, result.body);
    }
  } catch (e) {
    console.error('Failed to send session SMS:', e.message);
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- Home / status page ----------
// ---------- Health check (for uptime monitors / CI) ----------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, connectedToGoogle: isConnected, dbName: process.env.DB_NAME || 'tuition_center' });
});

app.get('/', (req, res) => {
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align:center;">
      <h2>Tuition Calendar Bridge</h2>
      <p>Status: <b>${isConnected ? 'Connected to Google Calendar ✅' : 'Not connected'}</b></p>
      <p><a href="/auth/google">${isConnected ? 'Reconnect' : 'Connect'} Google Calendar</a></p>
      <p style="margin-top:24px;"><a href="/app">Open the team dashboard →</a></p>
    </body></html>
  `);
});

// ---------- Google OAuth ----------
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.readonly']
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    await db.collection('tokens').updateOne(
      { _id: 'google' },
      { $set: { tokens } },
      { upsert: true }
    );
    isConnected = true;
    res.send('<h2>Connected! You can close this tab and go back to the dashboard.</h2>');
  } catch (e) {
    console.error(e);
    res.status(500).send('Something went wrong connecting to Google. Please try /auth/google again.');
  }
});

// ---------- Calendar schedule lookup ----------
// ---------- Login / logout / current-user ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing_fields' });

    const user = await db.collection('users').findOne({ username: username.trim().toLowerCase() });
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'invalid_credentials' });

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.name = user.name || user.username;
    res.json({ ok: true, username: user.username, name: req.session.name, role: user.role });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login_failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth(), (req, res) => {
  res.json({ username: req.session.username, name: req.session.name, role: req.session.role });
});

// ---------- User management (admin only) ----------
app.get('/api/users', requireAuth('admin'), async (req, res) => {
  try {
    const users = await db.collection('users').find({}).toArray();
    res.json(users.map(({ _id, passwordHash, ...rest }) => rest));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'load_failed' });
  }
});

app.post('/api/users', requireAuth('admin'), async (req, res) => {
  try {
    const { username, password, name, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing_fields' });

    const cleanUsername = username.trim().toLowerCase();
    const existing = await db.collection('users').findOne({ username: cleanUsername });
    if (existing) return res.status(409).json({ error: 'username_taken' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: newId(),
      username: cleanUsername,
      passwordHash,
      name: name || cleanUsername,
      role: role === 'admin' ? 'admin' : 'staff'
    };
    await db.collection('users').insertOne({ ...user });
    const { passwordHash: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'save_failed' });
  }
});

app.delete('/api/users/:id', requireAuth('admin'), async (req, res) => {
  try {
    // Don't let an admin lock themselves (or the last admin) out entirely.
    const target = await db.collection('users').findOne({ id: req.params.id });
    if (target && target.role === 'admin') {
      const adminCount = await db.collection('users').countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'cannot_delete_last_admin' });
      }
    }
    await db.collection('users').deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'delete_failed' });
  }
});

app.put('/api/users/:id', requireAuth('admin'), async (req, res) => {
  try {
    const { name, role, password } = req.body || {};
    const updateFields = {};
    if (name !== undefined) updateFields.name = name;

    if (role !== undefined) {
      const newRole = role === 'admin' ? 'admin' : 'staff';
      // Don't let the last admin be demoted to staff.
      if (newRole === 'staff') {
        const target = await db.collection('users').findOne({ id: req.params.id });
        if (target && target.role === 'admin') {
          const adminCount = await db.collection('users').countDocuments({ role: 'admin' });
          if (adminCount <= 1) return res.status(400).json({ error: 'cannot_demote_last_admin' });
        }
      }
      updateFields.role = newRole;
    }

    if (password) {
      updateFields.passwordHash = await bcrypt.hash(password, 10);
    }

    await db.collection('users').updateOne({ id: req.params.id }, { $set: updateFields });
    const updated = await db.collection('users').findOne({ id: req.params.id });
    const { _id, passwordHash, ...safe } = updated || {};
    res.json(safe);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'update_failed' });
  }
});

app.get('/api/schedule', requireAuth(), async (req, res) => {
  try {
    if (!isConnected) return res.status(401).json({ error: 'not_connected' });
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'missing_date' });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const timeMin = new Date(date + 'T00:00:00').toISOString();
    const timeMax = new Date(date + 'T23:59:59').toISOString();
    const calendarId = process.env.CALENDAR_ID || 'primary';

    const result = await calendar.events.list({
      calendarId, timeMin, timeMax, singleEvents: true, orderBy: 'startTime'
    });

    const events = (result.data.items || []).map(ev => ({
      title: ev.summary || '(untitled event)',
      start: ev.start.dateTime || ev.start.date,
      end: ev.end.dateTime || ev.end.date
    }));

    res.json({ events });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

// ---------- Data endpoints: teachers, classes, sessions, admissions ----------
// GET    /api/:collection            -> list all items
// POST   /api/:collection            -> add one item
// POST   /api/:collection/import     -> bulk-add an array of items (for migrating old data)
// DELETE /api/:collection/:id        -> remove one item by id
const COLLECTIONS = ['teachers', 'classes', 'sessions', 'admissions'];

COLLECTIONS.forEach(name => {
  app.get(`/api/${name}`, requireAuth(), async (req, res) => {
    try {
      const items = await db.collection(name).find({}).toArray();
      res.json(items.map(({ _id, ...rest }) => rest));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  app.post(`/api/${name}/import`, requireAuth(), async (req, res) => {
    try {
      const items = Array.isArray(req.body) ? req.body : [];
      if (items.length) {
        await db.collection(name).insertMany(items.map(i => ({ ...i, id: i.id || newId() })));
      }
      res.json({ ok: true, count: items.length });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'import_failed' });
    }
  });

  app.post(`/api/${name}`, requireAuth(), async (req, res) => {
    try {
      const item = { ...req.body, id: req.body.id || newId() };
      await db.collection(name).insertOne({ ...item });
      res.json(item);
      if (name === 'sessions') {
        // Fire-and-forget: don't make the person wait on the SMS provider.
        maybeSendSessionSms(item);
      }
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  // Deleting is admin-only for teachers, classes, and sessions — staff
  // can still add and edit these, but can't remove them outright.
  // Editing sessions specifically is also admin-only, to keep logged
  // punctuality/attendance history from being rewritten after the fact.
  // Admissions stay fully open to any logged-in user.
  const deleteAuth = ['teachers', 'classes', 'sessions'].includes(name) ? requireAuth('admin') : requireAuth();
  const putAuth = name === 'sessions' ? requireAuth('admin') : requireAuth();

  app.delete(`/api/${name}/:id`, deleteAuth, async (req, res) => {
    try {
      await db.collection(name).deleteOne({ id: req.params.id });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'delete_failed' });
    }
  });

  app.put(`/api/${name}/:id`, putAuth, async (req, res) => {
    try {
      const { id, _id, ...updateFields } = req.body || {};
      await db.collection(name).updateOne({ id: req.params.id }, { $set: updateFields });
      const updated = await db.collection(name).findOne({ id: req.params.id });
      const { _id: __, ...clean } = updated || {};
      res.json(clean);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'update_failed' });
    }
  });
});

// ---------- AI insights ----------
// ---------- Organization settings (e.g. Operations Manager phone number) ----------
// Stored as a single shared document — one setting set for the whole
// organization, not per-device like the backend URL.
app.get('/api/settings', requireAuth(), async (req, res) => {
  try {
    const doc = await db.collection('settings').findOne({ _id: 'org' });
    const { _id, ...rest } = doc || {};
    res.json(rest);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'load_failed' });
  }
});

app.post('/api/settings', requireAuth('admin'), async (req, res) => {
  try {
    const { _id, ...rest } = req.body || {};
    await db.collection('settings').updateOne({ _id: 'org' }, { $set: rest }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'save_failed' });
  }
});

app.post('/api/insights', requireAuth(), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'no_api_key' });
  }
  try {
    const summary = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are an operations analyst for a private tuition center. Based on this JSON summary of recent sessions, teacher punctuality, attendance, and admissions, produce 3-6 short, specific, actionable insights or recommendations a center owner could act on this week. Respond ONLY with a JSON array of objects like [{"tag":"PUNCTUALITY","text":"..."}] with no markdown, no code fences, no preamble. Valid tags: PUNCTUALITY, ATTENDANCE, ADMISSIONS, GENERAL.\n\nDATA:\n${JSON.stringify(summary)}`
        }]
      })
    });
    const data = await response.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const clean = textBlocks.replace(/```json|```/g, '').trim();
    const items = JSON.parse(clean);
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'insights_failed' });
  }
});

// ---------- Startup: connect to MongoDB Atlas, then start listening ----------
async function start() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Add it in Render environment variables.');
    process.exit(1);
  }
  const client = new MongoClient(process.env.MONGODB_URI, { family: 4 });
  await client.connect();
  const dbName = process.env.DB_NAME || 'tuition_center';
  db = client.db(dbName);
  console.log(`Connected to MongoDB Atlas (database: ${dbName})`);

  const tokenDoc = await db.collection('tokens').findOne({ _id: 'google' });
  if (tokenDoc) {
    oauth2Client.setCredentials(tokenDoc.tokens);
    isConnected = true;
  }

  // First-run only: create the initial admin account from env vars, so
  // there's always a way in. Once any user exists, this is skipped —
  // manage further accounts from the Users tab in the dashboard instead.
  const userCount = await db.collection('users').countDocuments();
  if (userCount === 0) {
    if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
      await db.collection('users').insertOne({
        id: newId(),
        username: process.env.ADMIN_USERNAME.trim().toLowerCase(),
        passwordHash,
        name: 'Admin',
        role: 'admin'
      });
      console.log(`Created initial admin account: ${process.env.ADMIN_USERNAME}`);
    } else {
      console.warn('No users exist yet, and ADMIN_USERNAME/ADMIN_PASSWORD are not set — nobody will be able to log in until you set these env vars and redeploy.');
    }
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Calendar bridge listening on port ' + PORT));
}

start().catch(e => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
