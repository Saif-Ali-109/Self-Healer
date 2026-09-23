# Deploying Self-Healer on a VPS (systemd, no Docker)

Requirements: Node ≥ 22, git, the `gh` CLI (logged in for the service user, or a
credential helper for `git push` over HTTPS), and the toolchains your watched
repos need (node/pnpm, python, go, …). For Ollama, a reachable Ollama server.

```bash
sudo useradd --system --create-home --home-dir /opt/self-healer selfhealer
sudo -u selfhealer git clone <your fork> /opt/self-healer && cd /opt/self-healer
sudo -u selfhealer npm ci && sudo -u selfhealer npm run build
sudo -u selfhealer cp self-healer.config.example.json self-healer.config.json   # edit it

sudo mkdir -p /etc/self-healer && sudo cp .env.example /etc/self-healer/env
sudo chown root:root /etc/self-healer/env && sudo chmod 600 /etc/self-healer/env
sudoedit /etc/self-healer/env          # GH_TOKEN, CI_WEBHOOK_SECRET, SOR_SIGNING_KEY, provider keys

sudo cp deploy/self-healer.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now self-healer
journalctl -u self-healer -f
curl -s localhost:3457/health          # {"ok":true}
```

Check it: `node dist/self-healer.mjs llm show --repo owner/name` then `llm ping`.
Manage with `systemctl`, not `self-healer start/stop`. Edits to
`self-healer.config.json` apply on the next CI failure — no restart needed;
changes to the env file need `systemctl restart self-healer`.

## Two things you must do in each watched repo
1. CI must **run on `ci-fix/*` branches** (e.g. `on: push: branches: ['**']`), or
   the agent never learns whether its fix worked and the re-fix loop cannot start.
2. The notify workflow (`self-healer enable --repo owner/name`) must also cover
   those runs (it reports failed workflow runs of any branch).

## Security model — read this
The agent executes the *repository's own test code* on your server, and the
model decides what commands to run. Built-in containment: no shell, allowlisted
binaries, scrubbed env (no tokens), private `$HOME`, timeouts, worktree-only
file access, `.github/` and `.git/` writes blocked, read-only git, `npx
--no-install`, `core.hooksPath=/dev/null` for the harness's own git calls, and
systemd hardening above. That is **not an OS sandbox**: repo code still runs as
the service user, and a same-user process can read `/proc/<pid>/environ` of the
daemon. So:
- Only watch repos whose code you trust, **or** wrap every repo command:
  `"commandWrapper": ["bwrap","--unshare-all","--share-net","--ro-bind","/usr","/usr","--ro-bind","/lib","/lib","--ro-bind","/lib64","/lib64","--ro-bind","/etc/resolv.conf","/etc/resolv.conf","--bind","/opt/self-healer/.runs","/opt/self-healer/.runs","--bind","/opt/self-healer/data/cache","/opt/self-healer/data/cache","--proc","/proc","--dev","/dev","--chdir","."]`
  (adapt paths; requires `bubblewrap`), or run commands as a second unprivileged user.
- Scope `GH_TOKEN` to the watched repos, with only what is needed (contents:write for
  `ci-fix/*`, pull-requests/issues:write for comments). Use branch protection so
  the token cannot push to `main` regardless of agent bugs.
- Fork PRs: the failing commit may not exist in the base repo; those runs escalate
  as `checkout_failed`.
