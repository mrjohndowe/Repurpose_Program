const axios = require('axios');
const fs = require('fs');
const store = require('../store');

const graphVersion = () => process.env.FACEBOOK_GRAPH_VERSION || 'v25.0';
const graphBase = () => `https://graph.facebook.com/${graphVersion()}`;

function authUrl(req) {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  req.session.facebookState = state;
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
    state,
    response_type: 'code',
    scope: 'pages_show_list,pages_read_engagement,pages_manage_posts',
  });
  return `https://www.facebook.com/${graphVersion()}/dialog/oauth?${params}`;
}

async function exchangeCode(code) {
  const short = await axios.get(`${graphBase()}/oauth/access_token`, {
    params: {
      client_id: process.env.FACEBOOK_APP_ID,
      client_secret: process.env.FACEBOOK_APP_SECRET,
      redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
      code,
    },
  });

  let userAccessToken = short.data.access_token;
  try {
    const long = await axios.get(`${graphBase()}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        fb_exchange_token: userAccessToken,
      },
    });
    userAccessToken = long.data.access_token || userAccessToken;
  } catch (_) {
    // Short-lived token still lets setup continue. The UI will expose expiry failures.
  }

  const pagesResponse = await axios.get(`${graphBase()}/me/accounts`, {
    params: { fields: 'id,name,access_token', access_token: userAccessToken },
  });
  const pages = pagesResponse.data.data || [];
  store.update((state) => {
    state.oauth.facebook = { access_token: userAccessToken, obtained_at: Date.now() };
    state.facebookPages = pages;
    if (!state.selectedFacebookPageId && pages[0]) state.selectedFacebookPageId = pages[0].id;
  });
  return pages;
}

function selectedPage() {
  const state = store.read();
  const page = state.facebookPages.find((item) => item.id === state.selectedFacebookPageId);
  if (!page) throw new Error('No Facebook Page has been selected.');
  if (!page.access_token) throw new Error('The selected Facebook Page has no Page access token.');
  return page;
}


async function listReels() {
  const page = selectedPage();
  let data;
  try {
    const response = await axios.get(`${graphBase()}/${page.id}/video_reels`, {
      params: {
        access_token: page.access_token,
        fields: 'id,description,created_time,permalink_url,thumbnails',
        limit: 20,
      },
    });
    data = response.data.data || [];
  } catch (error) {
    // Some Graph versions return a narrower shape from the collection endpoint.
    // Falling back to IDs still lets the workflow detect a new Page Reel.
    const response = await axios.get(`${graphBase()}/${page.id}/video_reels`, {
      params: { access_token: page.access_token, limit: 20 },
    });
    data = response.data.data || [];
  }
  return data.map((item) => ({
    fingerprint: `facebook:${String(item.id)}`,
    sourcePlatform: 'facebook',
    sourceExternalId: String(item.id),
    sourceUrl: item.permalink_url || `https://www.facebook.com/reel/${item.id}`,
    title: String(item.description || '').split(/\r?\n/)[0].slice(0, 120),
    caption: item.description || '',
    sourceCreatedAt: item.created_time || null,
    coverImageUrl: item.thumbnails?.data?.[0]?.uri || null,
    metrics: {},
  }));
}

async function uploadReel(video) {
  const page = selectedPage();
  const start = await axios.post(`${graphBase()}/${page.id}/video_reels`, null, {
    params: {
      upload_phase: 'start',
      access_token: page.access_token,
    },
  });
  const videoId = start.data.video_id;
  const uploadUrl = start.data.upload_url;
  if (!videoId || !uploadUrl) throw new Error('Meta did not return a Reel upload session.');

  const stat = fs.statSync(video.localPath);
  await axios.post(uploadUrl, fs.createReadStream(video.localPath), {
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    headers: {
      Authorization: `OAuth ${page.access_token}`,
      offset: '0',
      file_size: String(stat.size),
      'Content-Type': 'application/octet-stream',
    },
  });

  const finish = await axios.post(`${graphBase()}/${page.id}/video_reels`, null, {
    params: {
      upload_phase: 'finish',
      video_id: videoId,
      video_state: 'PUBLISHED',
      description: video.description || video.title || '',
      access_token: page.access_token,
    },
  });
  if (!finish.data.success) throw new Error('Meta accepted the upload but did not confirm publication.');

  return { id: videoId, url: `https://www.facebook.com/reel/${videoId}` };
}

module.exports = { authUrl, exchangeCode, listReels, uploadReel };
