# Genrebase

A music genre reference with a daily tracker. The site is plain HTML. A small job runs once a day, saves the totals for each song and works out the daily change.

## What the numbers are

- **Plays** come from Last.fm. They are scrobbles, not Spotify streams. They lean toward Last.fm users.
- **Views and likes** come from YouTube.
- Spotify does not offer stream counts or public likes through its official API. That is why the tracker uses these two sources.
- The daily change is today's total minus the last saved total. History starts on the first run. The daily columns fill in after the second run.

## Setup (about 20 minutes)

### 1. Get two API keys

- **Last.fm:** go to https://www.last.fm/api/account/create and make an app. Copy the API key.
- **YouTube:** open Google Cloud Console and make a project. Enable "YouTube Data API v3". Go to Credentials and make an API key. Restrict it to the YouTube Data API.

### 2. Make a GitHub repo

Make a new public repo. Free GitHub Pages needs a public repo.

Upload everything in this folder. Keep the structure:

```
public/            the website and its data
scripts/update.mjs the daily job
.github/workflows/daily.yml
```

The web uploader can skip hidden folders. If `.github` is missing, use Add file, then Create new file. Name it `.github/workflows/daily.yml` and paste in the contents.

### 3. Add three secrets

Repo Settings, then Secrets and variables, then Actions, then New repository secret.

| Name | Value |
| --- | --- |
| `LASTFM_API_KEY` | your Last.fm key |
| `LASTFM_USER` | your Last.fm username |
| `YOUTUBE_API_KEY` | your YouTube key |

`LASTFM_USER` is what adds your own top tracks to the tracker.

### 4. Turn on Pages

Repo Settings, then Pages. Set Source to **GitHub Actions**.

### 5. Run it once

Open the Actions tab. Pick "Daily update". Click Run workflow. Check the log. It should say how many songs got Last.fm and YouTube data.

Your site lives at `https://YOUR-USERNAME.github.io/YOUR-REPO/`. After that it updates itself around 1:17 AM Eastern.

## Things to know

- **YouTube matching is automatic.** The job searches YouTube for each song and saves the video ID in `public/data/matches.json`. A search costs 100 quota units and the free daily quota is 10,000. So the job matches up to 60 new songs per run. The rest fill in over the next days.
- **Wrong match?** Open `public/data/matches.json`. Replace the video ID for that song. Use the ID from the video's URL. Last.fm matches work the same way. Use `{"artist": "...", "track": "..."}`.
- **Add or remove songs** by editing `public/data/tracks.json`.
- **Quiet repos.** GitHub can pause scheduled jobs in quiet public repos. If the numbers stop moving, open the Actions tab and re-enable the workflow.

## Run it on your own computer

```
LASTFM_API_KEY=your_key YOUTUBE_API_KEY=your_key LASTFM_USER=you node scripts/update.mjs
```

Then open `public/index.html`. You need Node 20 or newer.
