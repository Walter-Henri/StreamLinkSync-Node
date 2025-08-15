
# StreamLinkSync — Final package (Complete)

This package includes:
- Protected /api/update endpoint (CRON_SECRET required)
- Internal 6-hour gate to avoid excessive updates
- m3u8 extraction (YouTube via ytdl-core + generic probe)
- Persistence on Turso (libSQL)
- UI public/index.html with search, sorting, and manual 'Force update' button
