require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const store = require('./store');
const tiktok = require('./services/tiktok');
const youtube = require('./services/youtube');
const facebook = require('./services/facebook');
const engine = require('./services/workflow-engine');

const app = express();
const port = Number(process.env.PORT || 3080);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'replace-me-before-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    console.error(error);
    res.status(500).json({ error: error.message || 'Unexpected server error.' });
  });
}

app.get('/api/state', (req, res) => res.json(store.publicState()));

app.get('/api/catalog', (req, res) => {
  res.json({
    nodes: [
      { key: 'tiktok.new_video', type: 'trigger', label: 'New TikTok Video', platform: 'TikTok', enabled: true, description: 'Starts when a new public video appears on the connected TikTok account.' },
      { key: 'youtube.new_video', type: 'trigger', label: 'New YouTube Video', platform: 'YouTube', enabled: true, description: 'Starts when a new upload appears on the connected YouTube channel.' },
      { key: 'facebook.new_reel', type: 'trigger', label: 'New Facebook Reel', platform: 'Facebook', enabled: true, description: 'Starts when a new Reel appears on the selected Facebook Page.' },
      { key: 'media.download', type: 'action', label: 'Get Clean Video', platform: 'Processing', enabled: true, description: 'Retrieves the best available copy from the source post.' },
      { key: 'caption.preserve', type: 'action', label: 'Preserve Caption', platform: 'Processing', enabled: true, description: 'Carries the source caption into destination posts.' },
      { key: 'caption.strip_source_tags', type: 'action', label: 'Clean Source Tags', platform: 'Processing', enabled: true, description: 'Removes TikTok-specific discovery tags before reposting.' },
      { key: 'youtube.short', type: 'destination', label: 'YouTube Short', platform: 'YouTube', enabled: true, description: 'Publishes the video to the connected YouTube channel.' },
      { key: 'facebook.reel', type: 'destination', label: 'Facebook Page Reel', platform: 'Facebook', enabled: true, description: 'Publishes the video to the selected Facebook Page.' },
    ],
  });
});

app.post('/api/settings', (req, res) => {
  store.update((state) => {
    if (req.body.pollIntervalMs != null) state.settings.pollIntervalMs = Math.max(60000, Number(req.body.pollIntervalMs));
  });
  engine.schedule();
  res.json({ ok: true, settings: store.read().settings });
});

app.post('/api/facebook/select', (req, res) => {
  const state = store.read();
  if (!state.facebookPages.some((page) => String(page.id) === String(req.body.pageId))) {
    return res.status(400).json({ error: 'Unknown Facebook Page.' });
  }
  store.update((next) => { next.selectedFacebookPageId = String(req.body.pageId); });
  res.json({ ok: true });
});

app.post('/api/workflows', (req, res) => {
  const candidate = { ...req.body, id: undefined };
  engine.validateWorkflow(candidate);
  res.status(201).json(store.saveWorkflow(candidate));
});

app.put('/api/workflows/:id', (req, res) => {
  const state = store.read();
  const existing = state.workflows.find((w) => w.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Workflow not found.' });
  const candidate = { ...existing, ...req.body, id: existing.id };
  engine.validateWorkflow(candidate);
  res.json(store.saveWorkflow(candidate));
});

app.delete('/api/workflows/:id', (req, res) => {
  if (!store.deleteWorkflow(req.params.id)) return res.status(404).json({ error: 'Workflow not found.' });
  res.json({ ok: true });
});

app.post('/api/workflows/:id/toggle', (req, res) => {
  const current = store.read().workflows.find((w) => w.id === req.params.id);
  if (!current) return res.status(404).json({ error: 'Workflow not found.' });
  if (req.body.active === true) engine.validateWorkflow(current);
  res.json(store.patchWorkflow(req.params.id, { active: Boolean(req.body.active) }));
});

app.post('/api/workflows/:id/run', asyncRoute(async (req, res) => {
  const result = await engine.scanWorkflow(req.params.id, { forceProcessExisting: Boolean(req.body?.forceProcessExisting) });
  res.json(result);
}));

app.post('/api/runs/:id/retry', asyncRoute(async (req, res) => {
  res.json(await engine.retryRun(req.params.id));
}));

app.post('/api/scan', asyncRoute(async (req, res) => {
  res.json(await engine.scanActiveWorkflows());
}));

app.get('/auth/tiktok', (req, res) => {
  if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) return res.status(500).send('TikTok app credentials are not configured in .env.');
  res.redirect(tiktok.authUrl(req));
});

app.get('/auth/tiktok/callback', asyncRoute(async (req, res) => {
  if (!req.query.state || req.query.state !== req.session.tiktokState) throw new Error('TikTok OAuth state mismatch.');
  if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
  await tiktok.exchangeCode(String(req.query.code));
  res.redirect('/#connections');
}));

app.get('/auth/youtube', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(500).send('Google OAuth credentials are not configured in .env.');
  res.redirect(youtube.authUrl(req));
});

app.get('/auth/youtube/callback', asyncRoute(async (req, res) => {
  if (!req.query.state || req.query.state !== req.session.youtubeState) throw new Error('YouTube OAuth state mismatch.');
  await youtube.exchangeCode(String(req.query.code));
  res.redirect('/#connections');
}));

app.get('/auth/facebook', (req, res) => {
  if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) return res.status(500).send('Facebook app credentials are not configured in .env.');
  res.redirect(facebook.authUrl(req));
});

app.get('/auth/facebook/callback', asyncRoute(async (req, res) => {
  if (!req.query.state || req.query.state !== req.session.facebookState) throw new Error('Facebook OAuth state mismatch.');
  if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
  await facebook.exchangeCode(String(req.query.code));
  res.redirect('/#connections');
}));

app.get('/api/health', (req, res) => res.json({ ok: true, version: '0.2.0', time: new Date().toISOString() }));

app.listen(port, () => {
  console.log(`Repurpose Program v0.2: http://localhost:${port}`);
  engine.schedule();
});
