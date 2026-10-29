# The Morning Servo

A personal daily AI and robotics newspaper, delivered to your phone at 8:00 IST as an installable web app (PWA).

## How it works

```
05:45 IST  GitHub Actions "Print edition"
           fetch ~20 RSS feeds → dedupe → triage (cheap model) → pick top 10 + briefs
           → write top 10 (writing model) → funding table (cheap model) → THINK page (frontier model)
           → commit site/editions/YYYY-MM-DD.json → deploy to GitHub Pages
08:00 IST  GitHub Actions "Morning push" sends the notification
Phone      the app reads editions/*.json and keeps them for offline reading
```

## Files

| Path | What it is |
|---|---|
| `config/models.json` | Which model does which job, plus fallbacks and bake-off candidates |
| `config/settings.json` | Cost cap per edition, story counts, section caps |
| `config/sources.json` | RSS feeds |
| `config/profile.md` | Who the paper is written for. Override privately with `config/profile.local.md` or the `READER_PROFILE` secret |
| `scripts/generate.js` | Builds one edition |
| `scripts/bakeoff.js` | Compares models: `npm run bakeoff -- triage` and `npm run bakeoff -- write` |
| `scripts/notify.js` | Sends the push |
| `site/` | The app itself |

## Commands

```
npm run generate              # build today's edition locally
FORCE_SUNDAY=1 npm run generate   # build with the Sunday Think page
npm run serve                 # preview at http://localhost:4173
npm run bakeoff -- triage     # cheap-model comparison (≈ $0.35)
npm run bakeoff -- write      # writing comparison, opens a blind side-by-side page (≈ $0.05)
```

## Secrets (GitHub → Settings → Secrets and variables → Actions)

| Name | Type | Value |
|---|---|---|
| `OPENROUTER_API_KEY` | secret | OpenRouter key with a credit limit |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | secret | from `npm run vapid` |
| `PUSH_SUBSCRIPTION` | secret | device code from the app's Settings tab |
| `READER_PROFILE` | secret, optional | a more detailed private reader profile |
| `SITE_URL` | variable | `https://antimonitor8.github.io/morning-servo/` |

## Costs

Each edition records its real cost (from OpenRouter) in `cost` inside the edition JSON, and the app shows it on the last page and the monthly total in Archive. A run stops making model calls once it passes `maxCostPerEditionUsd`.
