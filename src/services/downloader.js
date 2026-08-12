const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const downloadDir = path.join(__dirname, '..', '..', 'storage', 'downloads');

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function downloadSource(video) {
  if (!video.sourceUrl) return Promise.reject(new Error('The source post has no downloadable URL.'));
  const platform = sanitize(video.sourcePlatform || 'source');
  const externalId = sanitize(video.sourceExternalId || Date.now());
  fs.mkdirSync(downloadDir, { recursive: true });
  const base = path.join(downloadDir, `${platform}_${externalId}`);
  const template = `${base}.%(ext)s`;

  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--no-progress', '--no-part', '--newline',
      '--merge-output-format', 'mp4',
      '--format', 'bestvideo*+bestaudio/best',
      '-o', template,
      video.sourceUrl,
    ];
    const child = spawn(process.env.YTDLP_PATH || 'yt-dlp', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') reject(new Error('yt-dlp is not installed or not available in PATH.'));
      else reject(error);
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp exited with ${code}`));
      const files = fs.readdirSync(downloadDir)
        .filter((name) => name.startsWith(`${platform}_${externalId}.`))
        .map((name) => path.join(downloadDir, name));
      const mp4 = files.find((file) => file.toLowerCase().endsWith('.mp4')) || files[0];
      if (!mp4) return reject(new Error('Download finished but no output video was found.'));
      resolve(mp4);
    });
  });
}

function downloadTikTok(video) {
  return downloadSource({ sourcePlatform:'tiktok', sourceExternalId:video.tiktokId, sourceUrl:video.tiktokUrl });
}

module.exports = { downloadSource, downloadTikTok };
