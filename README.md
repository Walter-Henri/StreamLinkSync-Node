
# StreamLinkSync - Final (rewrite live_links)

This package downloads `channels.json` (Google Drive), resolves each channel URL to the current live
watch URL (for channel links like /@SBT/live), extracts an m3u8 HLS manifest (when present), and **rewrites**
the Turso table `live_links` with the fresh set of links (DELETE + INSERT).

**Important:** Set the following environment variables in Vercel (Project Settings -> Environment Variables):
- TURSO_URL (libsql://...)
- TURSO_TOKEN
- CHANNELS_JSON_URL (optional)
- (optional) CRON_API_KEY, CRON_JOB_ID for cron-job.org reset behavior
- CONCURRENCY (default 1)

Deploy to Vercel and schedule cron-job.org to call `/api/update` every 60 minutes. The endpoint will only
perform the rewrite if the last successful update was >= 6 hours ago; otherwise it returns skipped:true.
