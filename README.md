# Label Cutter

An opinionated workflow for making consistently styled labels with a 40W xTool S1.

## Development

Install dependencies and start the local app:

```sh
pnpm install
pnpm run dev
```

Create a production build with:

```sh
pnpm run build
```

Vite writes the production files to `dist/`.

## Deployment

Cloudflare Pages is expected to build this project from its connected Git repository. For a Vite project, use `pnpm run build` as the build command and `dist` as the output directory. Deployments are managed by the Cloudflare Pages project settings; this repository does not use a Wrangler deployment script.
