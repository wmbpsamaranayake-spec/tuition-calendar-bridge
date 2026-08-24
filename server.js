require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve the dashboard itself at /app — your team visits this URL.
app.use('/app', express.static(path.join(__dirname, 'public')));

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

let db;
let isConnected = false;

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
app.get('/api/schedule', async (req, res) => {
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
  app.get(`/api/${name}`, async (req, res) => {
    try {
      const items = await db.collection(name).find({}).toArray();
      res.json(items.map(({ _id, ...rest }) => rest));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  app.post(`/api/${name}/import`, async (req, res) => {
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

  app.post(`/api/${name}`, async (req, res) => {
    try {
      const item = { ...req.body, id: req.body.id || newId() };
      await db.collection(name).insertOne({ ...item });
      res.json(item);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  app.delete(`/api/${name}/:id`, async (req, res) => {
    try {
      await db.collection(name).deleteOne({ id: req.params.id });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'delete_failed' });
    }
  });
});

// ---------- AI insights ----------
app.post('/api/insights', async (req, res) => {
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
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const dbName = process.env.DB_NAME || 'tuition_center';
  db = client.db(dbName);
  console.log(`Connected to MongoDB Atlas (database: ${dbName})`);

  const tokenDoc = await db.collection('tokens').findOne({ _id: 'google' });
  if (tokenDoc) {
    oauth2Client.setCredentials(tokenDoc.tokens);
    isConnected = true;
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Calendar bridge listening on port ' + PORT));
}

start().catch(e => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
