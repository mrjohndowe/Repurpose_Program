const fs = require('fs');
const { google } = require('googleapis');
const store = require('../store');

function client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function authUrl(req) {
  const oauth = client();
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  req.session.youtubeState = state;
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
    state,
  });
}

async function exchangeCode(code) {
  const oauth = client();
  const { tokens } = await oauth.getToken(code);
  store.update((state) => { state.oauth.youtube = tokens; });
  return tokens;
}

function authorizedClient() {
  const state = store.read();
  if (!state.oauth.youtube) throw new Error('YouTube is not connected.');
  const oauth = client();
  oauth.setCredentials(state.oauth.youtube);
  oauth.on('tokens', (tokens) => {
    store.update((next) => {
      next.oauth.youtube = { ...next.oauth.youtube, ...tokens };
    });
  });
  return oauth;
}

function sourceLine(video) {
  if (!video.sourceUrl) return '';
  const label = video.sourcePlatform ? `${video.sourcePlatform[0].toUpperCase()}${video.sourcePlatform.slice(1)}` : 'source';
  return `Originally posted on ${label}: ${video.sourceUrl}`;
}


function parseDuration(value) {
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function listRecentUploads() {
  const auth = authorizedClient();
  const service = google.youtube({ version: 'v3', auth });
  const channels = await service.channels.list({ part:['contentDetails'], mine:true, maxResults:1 });
  const uploadsId = channels.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error('Could not find the connected YouTube channel uploads playlist.');
  const playlist = await service.playlistItems.list({ part:['snippet','contentDetails','status'], playlistId:uploadsId, maxResults:20 });
  const ids = (playlist.data.items || []).map((item) => item.contentDetails?.videoId).filter(Boolean);
  let details = [];
  if (ids.length) {
    const videos = await service.videos.list({ part:['snippet','contentDetails','statistics'], id:ids });
    details = videos.data.items || [];
  }
  const byId = new Map(details.map((item) => [item.id, item]));
  return (playlist.data.items || []).map((item) => {
    const videoId = item.contentDetails?.videoId;
    const detail = byId.get(videoId) || {};
    const snippet = detail.snippet || item.snippet || {};
    return {
      fingerprint: `youtube:${videoId}`,
      sourcePlatform: 'youtube',
      sourceExternalId: videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title: snippet.title || '',
      caption: snippet.description || '',
      sourceCreatedAt: item.contentDetails?.videoPublishedAt || snippet.publishedAt || null,
      coverImageUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
      duration: parseDuration(detail.contentDetails?.duration),
      metrics: {
        views: Number(detail.statistics?.viewCount || 0),
        likes: Number(detail.statistics?.likeCount || 0),
        comments: Number(detail.statistics?.commentCount || 0),
      },
    };
  }).filter((item, index) => item.sourceExternalId && playlist.data.items?.[index]?.status?.privacyStatus !== 'private');
}

async function uploadShort(video) {
  const auth = authorizedClient();
  const youtube = google.youtube({ version: 'v3', auth });
  const title = (video.title || video.caption || 'Repurposed video').replace(/[<>]/g, '').slice(0, 100);
  const description = [video.caption || '', '', sourceLine(video)].filter(Boolean).join('\n').trim().slice(0, 4900);

  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        categoryId: process.env.YOUTUBE_CATEGORY_ID || '22',
      },
      status: {
        privacyStatus: process.env.YOUTUBE_PRIVACY || 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: { body: fs.createReadStream(video.localPath) },
  });

  return {
    platform: 'youtube',
    externalId: response.data.id,
    url: response.data.id ? `https://www.youtube.com/shorts/${response.data.id}` : null,
  };
}

module.exports = { authUrl, exchangeCode, listRecentUploads, uploadShort };
