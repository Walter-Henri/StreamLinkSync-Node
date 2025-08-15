
# StreamLinkSync - Improved (redirect resolution + optimized extraction)

This release improves YouTube live resolution for channel URLs like `/@SBT/live` by resolving redirects
and extracting the active `watch?v=` video id before using `ytdl-core`. It also includes a cron-job.org
reset helper (optional) and conservative concurrency (default 1) for Vercel Hobby.

**Important:** Do NOT commit secrets. Configure them in Vercel environment variables.
