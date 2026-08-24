require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
app.use(cors());

const TOKEN_PATH = './tokens.json';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Load a previously saved token, if one exists, so the server stays
// connected after restarts (until a fresh deploy wipes the disk).
function loadTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(tokens);
      return true;
    } catch (e) {
      console.error('Could not read saved tokens:', e.message);
    }
  }
  return false;
}
let isConnected = loadTokens();

app.get('/', (req, res) => {
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align:center;">
      <h2>Tuition Calendar Bridge</h2>
      <p>Status: <b>${isConnected ? 'Connected to Google Calendar ✅' : 'Not connected'}</b></p>
      <p><a href="/auth/google">${isConnected ? 'Reconnect' : 'Connect'} Google Calendar</a></p>
    </body></html>
  `);
});

// Step 1: send the coordinator to Google to grant read-only calendar access.
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // needed to get a refresh_token
    prompt: 'consent',      // forces Google to always return a refresh_token
    scope: ['https://www.googleapis.com/auth/calendar.readonly']
  });
  res.redirect(url);
});

// Step 2: Google sends the browser back here with a one-time code.
app.get('/oauth2callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    isConnected = true;
    res.send('<h2>Connected! You can close this tab and go back to the dashboard.</h2>');
  } catch (e) {
    console.error(e);
    res.status(500).send('Something went wrong connecting to Google. Please try /auth/google again.');
  }
});

// The dashboard calls this to get today's (or any date's) scheduled classes.
// GET /api/schedule?date=2026-08-24
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
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime'
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Calendar bridge listening on port ' + PORT));
