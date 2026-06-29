# Higgsfield Setup

This project uses [Higgsfield AI](https://higgsfield.ai) for image/video/marketing
generation, supporting the Evil Eye Studio iGaming slot studio and art/animation work.

## What's already set up in this repo

- **Higgsfield agent skills** are committed under `.agents/skills/` (tracked by
  `skills-lock.json`). These are picked up automatically by Claude Code and other
  agents:
  - `higgsfield-generate` — image/video generation
  - `higgsfield-marketplace-cards` — marketplace product cards
  - `higgsfield-product-photoshoot` — brand-quality product imagery
  - `higgsfield-soul-id` — train/manage Soul reference identities

## One-time install (per machine)

```bash
npm install -g @higgsfield/cli      # provides `higgsfield` / `higgs` / `hf`
npx skills add higgsfield-ai/skills # already done in this repo; re-run only to update
```

## Authentication

`higgsfield auth login` uses a **browser-based OAuth flow** (loopback redirect to
`http://127.0.0.1:8765/callback`). Run it **on your own machine**, where the browser
and the loopback callback live on the same host:

```bash
higgsfield auth login     # opens a browser; sign in with your Higgsfield account
higgsfield auth token     # prints the current access token to verify
```

Credentials are stored locally (override the location with `HIGGSFIELD_CREDENTIALS_PATH`).

### Note for Claude Code on the web / remote sessions

Browser-based login does **not** work inside the remote/cloud container:

1. The container's default network policy blocks `*.higgsfield.ai` (including
   `clerk.higgsfield.ai`), so the CLI can't reach the OAuth or API servers.
2. The OAuth loopback redirect targets the container's own `127.0.0.1`, which a
   browser on your machine can't reach.
3. The container is ephemeral — any credentials would be lost when it's reclaimed.

To use Higgsfield from remote sessions you would need to (a) choose/allow a network
policy that permits `higgsfield.ai` outbound, and (b) provision credentials via the
environment configuration rather than interactive login. See
https://code.claude.com/docs/en/claude-code-on-the-web for network policies and
environment setup. For normal day-to-day use, run the CLI authenticated on your
local machine.

## Quick reference

```bash
higgsfield model list --video        # list available models
higgsfield workflow list             # list workflows
higgsfield generate create <model> --prompt "cinematic slot symbol" --image <upload_id>
higgsfield account                   # credits and transactions
```
