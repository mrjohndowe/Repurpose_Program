const axios = require('axios');
const crypto = require('crypto');
const store = require('../store');

function authUrl(req) {
  const state = crypto.randomBytes(24).toString('hex');
  req.session.tiktokState = state;
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: 'user.info.basic,video.list',
    response_type: 'code',
    redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: process.env.TIKTOK_REDIRECT_URI,
  });
  const { data } = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (data.error) throw new Error(data.error_description || data.error);
  store.update((state) => {
    state.oauth.tiktok = { ...data, obtained_at: Date.now() };
  });
  return data;
}

async function refreshIfNeeded() {
  const state = store.read();
  const token = state.oauth.tiktok;
  if (!token) throw new Error('TikTok is not connected.');
  const expiresAt = Number(token.obtained_at || 0) + Number(token.expires_in || 0) * 1000;
  if (Date.now() < expiresAt - 60000) return token.access_token;
  if (!token.refresh_token) throw new Error('TikTok access token expired and no refresh token is stored.');

  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });
  const { data } = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (data.error) throw new Error(data.error_description || data.error);
  store.update((next) => {
    next.oauth.tiktok = { ...data, obtained_at: Date.now() };
  });
  return data.access_token;
}

async function listVideos() {
  const accessToken = await refreshIfNeeded();
  const fields = [
    'id', 'create_time', 'cover_image_url', 'share_url', 'video_description',
    'duration', 'height', 'width', 'title', 'like_count', 'comment_count',
    'share_count', 'view_count'
  ].join(',');
  const { data } = await axios.post(
    `https://open.tiktokapis.com/v2/video/list/?fields=${encodeURIComponent(fields)}`,
    { max_count: 20 },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  if (data.error?.code && data.error.code !== 'ok') {
    throw new Error(data.error.message || data.error.code);
  }
  return data.data?.videos || [];
}

module.exports = { authUrl, exchangeCode, listVideos };
