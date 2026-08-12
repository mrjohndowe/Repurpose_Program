# Platform Setup Notes

## TikTok

The current source adapter uses TikTok API v2 `video.list` with `video.list` authorization. It records video IDs, share URLs, captions, timestamps, dimensions, duration, covers, and public metrics when available.

For local development, the TikTok callback must be registered to an HTTPS URL. Point an HTTPS tunnel at the local port and use:

```text
https://YOUR-TUNNEL/auth/tiktok/callback
```

## YouTube

Enable YouTube Data API v3 and create a Web Application OAuth client.

Register:

```text
http://localhost:3080/auth/youtube/callback
```

The application requests:

```text
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube.readonly
```

The read adapter locates the authenticated channel's uploads playlist through `channels.list(mine=true)` and then reads recent playlist items. Private uploads are skipped because the media retrieval layer does not currently authenticate yt-dlp with the Google session.

## Facebook

Create a Meta app with Facebook Login and register:

```text
http://localhost:3080/auth/facebook/callback
```

The current permissions are:

```text
pages_show_list
pages_read_engagement
pages_manage_posts
```

After connection, select a Page in the Repurpose dashboard. That Page is used by Facebook source and destination nodes.

For production, permissions and publishing features can require App Review / Advanced Access depending on the Meta app and account setup.
