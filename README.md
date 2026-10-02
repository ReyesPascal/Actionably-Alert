# Actionably Alert

A tiny app that watches your GitHub repo's **Actions** and pops up when a run **starts** and when it **finishes** (passed, failed, cancelled), with how long it took.

## Install

Save [`compose.yml`](compose.yml) on your server (or paste it into Portainer / Dockge as a new stack), then:

```sh
docker compose up -d
```

Open **http://localhost:4000** (or `http://<server-ip>:4000`).

To update later: `docker compose pull && docker compose up -d`.

## Use

1. Type a repo (`owner/repo`) or paste its GitHub link, then press **Watch**. You can watch several.
2. For a private repo, open **Settings** and paste a GitHub token
   ([make one](https://github.com/settings/personal-access-tokens/new) with read-only access to **Actions**).
   A token also lets it check every 15 seconds; without one, GitHub allows 60 checks an hour, so set it to 60s.
3. Press **Turn on** to get desktop notifications when the tab is in the background.
   Use **Settings → Send a test popup** to check.

Keep the page open (a pinned tab works well). Failed runs stay on screen until you dismiss them.

> Desktop notifications need the page on `localhost` or `https`. Over plain `http://<ip>` you still get in-page popups, sound and a flashing tab title.

Settings are saved in the `actionably-alert-data` volume. The token never leaves the server.
