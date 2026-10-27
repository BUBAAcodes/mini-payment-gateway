# Mini payment gateway (learning project)

The full spec is docs/SPEC.md. Before any work, read section 0 (how we work),
section 3 (rules that must always hold) and the build step I name (section 14).

## How we work
- I am learning. One build step per session. Never start the next step on your own.
- First show a short plan and wait for my approval.
- Write the tests first, then the code. Run tests and typecheck until they pass.
- Then explain what you built in plain words and ask me 3 quiz questions.
- Commit as `step-NN: short description` only after I say ok.
- Never break a rule in section 3. If a step seems to need to, stop and ask me.

## Repo
pnpm monorepo: apps/api, apps/web, apps/demo-store, packages/db, packages/shared.
Root commands: pnpm typecheck, pnpm lint, pnpm test.