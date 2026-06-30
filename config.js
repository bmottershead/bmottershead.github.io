// Deployment-specific frontend config — the ONE file that differs per deploy.
// `setup.sh` (re)writes this to point the app at *this* deployment's Worker, so
// the application source (tally.js) stays byte-identical across every fork.
// GitHub Pages must serve it to the browser, so unlike wrangler.toml it IS
// committed. On sync/pull, keep your own copy if it conflicts.
export const WORKER_URL = "https://countdown.riverscape.workers.dev";
