## What and why

<!-- One concern per PR. What changed, and why. Link the issue: Closes #n -->

## How it was tested

<!-- Commands run and results, e.g. npm test, npm run postman -- --mode jwt, docker smoke -->

## Checklist

- [ ] CI is green (unit, newman, storage, docker)
- [ ] `CLAUDE.md` is updated, or this change doesn't affect architecture, conventions, commands or gotchas
- [ ] New or changed settings are in `DEFS`, `.env.example` and the README env table
- [ ] Every item in `CLAUDE.md` → "Checklist: what to update when a feature changes" that applies is done (README, dashboard help, guides, OpenAPI specs, `docs/platform-test-checklist.md`)
- [ ] If the Postman collection changed, it was regenerated with `npm run postman:build` and both files are committed
- [ ] Lab deploy is unaffected, or the impact is described below (merging to `master` deploys to the API Lab)

## Lab deploy impact

<!-- "None", or what changes: workflow/job names, Dockerfile, ports, /health, /data, env vars -->
