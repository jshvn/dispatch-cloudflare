# dispatch

Runs GitHub Actions workflows on a schedule, from a Cloudflare Worker.

## Setup

Once, by hand.

### GitHub App

1. Create an App under `jshvn` with one permission -- Repository permissions -> Actions ->
   Read and write -- and no webhook.
2. Install it on the `katoptra` organization with access to all repositories, so a repo
   created or transferred there is covered without another step, and on `jshvn` for the
   repos that stay there. The Worker finds each target's installation from its repo name at
   dispatch time, so there is no installation ID to note.
3. Note the App ID from the App's settings page.
4. Generate a private key and convert it. GitHub issues PKCS#1; WebCrypto imports PKCS#8
   only.

   ```sh
   task pkcs8 KEY=app.private-key.pem   # writes app.pkcs8.pem
   ```

### Worker secrets

1. Run `task secrets`. It prompts for `GITHUB_APP_ID`, then reads `GITHUB_APP_PRIVATE_KEY`
   from `app.pkcs8.pem`. `KEY=` points it at another path.

   The key is piped rather than pasted because `wrangler secret put` reads a single line
   when it has a terminal: a pasted PEM would store its `BEGIN` line and nothing else, and
   that is a non-empty value, so wrangler takes it and the first dispatch is where it shows.
2. Delete both `.pem` files.

### Cloudflare API token

1. My Profile -> API Tokens -> Create Token -> Create Custom Token.
2. Give it one permission: Account -> Workers Scripts -> Edit. Add Account -> Workers Tail
   -> Read to run `task logs` with it.
3. Under Account Resources, include only the account this Worker lives in.

### Repo secrets

1. Put the token above and the account ID (Workers & Pages overview) in 1Password: vault
   `jshvn`, item `dispatch`, section `cloudflare`, fields `token` and `account_id`.
2. Settings -> Secrets and variables -> Actions: `OP_SERVICE_ACCOUNT_TOKEN`, the service
   account that reads that vault. Every jshvn repository holds the same value, so rotating
   it is one `gh secret set` per repository.

Push to `main` deploys. The checks run on every push without the secret.

## Changing what runs

Five slots, named in `schedules/index.ts`, each a cron trigger of its own:

| slot        | UTC    | Pacific, winter |
|-------------|--------|-----------------|
| `hourly`    | :42    | :42             |
| `overnight` | 11:17  | 03:17           |
| `morning`   | 17:17  | 09:17           |
| `afternoon` | 23:17  | 15:17           |
| `evening`   | 05:17  | 21:17           |

One file per GitHub repo in `schedules/`, named for the half of `owner/name` after the
slash. It lists that repo's workflows and the slots each one runs in, and ends in
`as const` so a misspelt slot fails to compile:

```ts
// schedules/terraform.ts
export default {
  repo: "jshvn/terraform",
  workflows: [{ workflow: "drift.yml", slots: ["evening"] }],
} as const
```

`schedules/index.ts` imports every one of them. Bundling is static, so there is no glob and
a file the registry omits never runs.

Cloudflare needs the slots' cron strings in `wrangler.jsonc`, which is JSON and cannot
import them. `task crons` writes the ones in use there; `task check` fails until it has
been run. Registering a workflow in a slot that already has a target changes nothing in
`wrangler.jsonc`.

To add one:

- Write `schedules/<name>.ts` and add its import to `schedules/index.ts`.
- `task crons`, if the slot had no target before.
- Under `katoptra` the App already covers it. Under `jshvn`, add the repo to the App's
  installation there. A repo the App cannot see fails its step for good with
  `App is not installed on <owner>/<name>`, which `task inspect` shows.
- Check three things in the target's own workflow. Nothing here can, and a target failing
  any of them is dispatched into silence:
  - `workflow_dispatch:` in its `on:` block, or the dispatch 404s.
  - a `concurrency` group with `cancel-in-progress: false`, so a retried dispatch queues
    instead of doubling the work.
  - a healthcheck ping. This repo never learns whether a run passed.
- `task check`, then push to `main`.

To remove one:

- Delete `schedules/<name>.ts` and its import from `schedules/index.ts`.
- `task crons`, if it was the slot's only target.
- Give that workflow a `schedule:` of its own. `schedules/` was its only clock.
- `task check`, then push to `main`.

## Day to day

`task` on its own prints the menu.

- `task check` -- everything CI runs: types, format, tests, dry-run deploy.
- `task targets` -- what gets dispatched, and when.
- `task crons` -- write `wrangler.jsonc`'s triggers from `schedules/`.
- `task runs` -- recent runs of each target on GitHub.
- `task instances` -- the Cloudflare side, one instance per cron that fired.
- `task inspect` -- one instance's steps, retries and errors. `ID=<id>`, default latest.
- `task format` -- fix formatting in place.
- `task clean` -- delete `node_modules`, `.wrangler` and `worker-configuration.d.ts`. The
  next task needing them runs `npm ci` itself, so there is nothing to remember. It keeps
  `.pem` files and `.dev.vars`, which it cannot rebuild, and says so when either is there.
- `task dev`, `task logs`, `task deploy` -- run locally, live logs, deploy by hand.

To prove a change for real, trigger a production instance with the payload a cron would have
given it:

```sh
npx wrangler workflows trigger dispatch '{"cron":"42 * * * *","scheduledTime":0}'
```

It dispatches for real. Without the JSON the instance has no cron to look up and throws.

## Notes

- Cloudflare parses the crons; this repo only looks up strings, so `0 * * * *` and
  `0 */1 * * *` are different keys.
- The free plan allows 5 cron expressions per Cloudflare account, shared by every Worker on
  it. The five slots are that whole budget; only slots with a target become triggers, and
  a test holds the count at 5.
- A newly added cron takes up to 15 minutes to propagate, so its first slot may be missed.
  Existing expressions keep firing across deploys. Adding a target to a slot already in use
  adds no cron, so it is live on the next deploy.
