# AgriLink Escrow Platform — Prototype

This is a static hackathon prototype for the AgriLink Escrow Platform (Agri-Fin Escrow Pipeline). The UI is a front-end demo demonstrating escrow flows between buyers and farmers.

Files
- `index.html`: main static prototype UI.

Quick local preview

Option A — Open in browser directly
- Double-click `index.html` or open it with your browser.

Option B — Serve with Python (works on most systems)

```bash
# from the agrilink folder
python -m http.server 8000
# then open http://localhost:8000 in your browser
```

Option C — Serve with Node (npx `serve`)

```bash
# from the agrilink folder
npx serve -l 8000 .
# or install serve globally
npm i -g serve
serve -l 8000 .
```

Deploy

- GitHub Pages: push this repo and enable Pages from the `main` or `gh-pages` branch.
- Netlify / Vercel: drag-and-drop the `agrilink` folder or connect your repo.

Run the simulated API server locally

1. Install Node.js (v16+ recommended).
2. From the `agrilink` folder install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
# opens at http://localhost:3000
```

The Express server serves the static `index.html` and provides simulated endpoints at `/api/*` used by the UI.

Auto-deploy to GitHub Pages (CI)

This repository includes a GitHub Actions workflow that automatically deploys the `agrilink` folder to GitHub Pages when you push to the `main` branch.

What the workflow does:
- Checks out the repository
- Copies the `agrilink` folder into a temporary `site/` artifact
- Uploads the artifact and deploys it via the `actions/deploy-pages` action

How to enable Pages for this repo
1. Push your changes to the `main` branch:

```bash
git add .
git commit -m "Add agrilink site and Pages workflow"
git push origin main
```

2. Wait for the Actions workflow to finish (check the Actions tab in GitHub). The workflow publishes the site using the Pages artifact.

3. After the workflow completes, open your repository's Settings → Pages to see the published URL (it may take a minute to appear). If you want a custom domain, add a `CNAME` file to the `agrilink` folder and configure DNS.

Notes
- The workflow assumes the site files live under the `agrilink` directory at the repository root.
- If you prefer using a different branch for Pages, adjust the workflow trigger accordingly.

Suggested next steps
- Add simple backend API to persist listings and escrow state.
- Add real payment gateway or simulated payment flow for demos.
- Improve accessibility and form interactions.

If you'd like, I can:
- Add a minimal Express server to host the site and simulate escrow endpoints.
- Create a GitHub Actions workflow to deploy to GitHub Pages automatically.

