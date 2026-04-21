# GitHub Pages OAuth Callback Setup

The `oauth-callback.html` file in this directory bridges the FreeQ auth broker back to Obsidian.

## How to host it

1. Go to your repository **Settings → Pages**
2. Set **Source** to "Deploy from a branch"
3. Select branch `main` and folder `/docs`
4. Save

Your callback URL will be:
```
https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/oauth-callback.html
```

Paste this URL into **FreeQ Chat settings → OAuth callback URL**.

## How it works

1. FreeQ broker redirects here with `#oauth=BASE64`
2. This page decodes the data and redirects to `obsidian://freeq-chat?oauth=BASE64`
3. Obsidian catches it and completes login
