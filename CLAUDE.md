# dispatch

Starts GitHub Actions workflows on a schedule, from a Cloudflare Workflow. GitHub's own
`schedule:` event delivered 3 of 51 consecutive hourly slots on `jshvn/ctan`. Free plan.

`README.md` is for users. This file is the design.

## The files

- `schedules/` -- one file per GitHub repo, named for the half of `owner/name` after the
  slash, listing that repo's workflows and the slots each one runs in. Routine changes touch
  only this directory. `schedules/index.ts` imports them all: it holds `SLOTS`, the five
  named cron expressions, `JITTER`, the random wait some slots take before dispatching,
  plus the types, the registry and `selectTargets`. A target's cron
  is its slot's; the Worker only ever sees the cron.
- `wrangler.jsonc` -- the same expressions as Worker cron triggers, generated into it by
  `task crons`. Cloudflare parses them.
- `src/github.ts` -- App JWT, installation lookup, installation token, `workflow_dispatch`.
  No SDK, three requests.
- `src/index.ts` -- `scheduled` creates one instance per firing, under `instanceId`. The
  instance dispatches every target claiming that cron, then ends.
- `test/` -- one file per source it covers: `schedules.test.ts`, `github.test.ts`,
  `index.test.ts`. The last mocks `src/github`.

## Constraints

- It dispatches. It does not poll, monitor outcomes, or run work itself.
- Free plan. 3,000 workflow steps a day, one step per target per fire, plus two for a slot
  in `JITTER` (the drawn delay and its sleep). Polling outcomes
  would cost about 13 steps a run.
- No secrets in the repo. Worker secrets `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, set
  with `task secrets`. Repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, for
  deploying.
- One App, installed on `jshvn` for the repos it runs. The installation is resolved from
  each target's repo name, so nothing in the Worker names an owner, and a target under
  another account is one more installation, not a code change.
- The only network endpoint is `api.github.com`.
- No cron parser. Cloudflare parses the expressions; this repo looks up strings.
- One expression per slot, never a multi-hour daily. Cloudflare hands the Worker the same
  string for every hour a list expression matches, so a target could not pick one of them;
  and a trigger Cloudflare drops takes one slot down, not every daily. `every4h` is the
  exception that fits: its targets run on every firing, so none has to pick.
- `JITTER` delays a whole slot by a random wait drawn per firing, inside a step so a
  restarted instance keeps its draw. The slot waits rather than a target because targets
  dispatch in turn.

Accepted ceilings: no backfill, no outcome monitoring, the crons copied into
`wrangler.jsonc` by a generator rather than read from one place, a registry that lists its
own files by hand, five slots and no per-target minute, and a subrequest budget that bounds
how many targets one slot can carry.

## Must knows

Each of these fails silently, or only in production.

- **`wrangler.jsonc`'s crons are generated; do not edit them.** `task crons` writes
  `triggers.crons` from `schedules/`: the expression of every slot some target is in, and no
  other. The strings are copied rather than shared because `wrangler.jsonc` is JSON and
  cannot import. A slot that is not also a trigger never runs; a trigger no target claims
  throws every time it fires. `test/schedules.test.ts` fails until the two match exactly,
  order included. Only a slot's first target, its last, or a change to `SLOTS` itself
  moves the file.
- **A file in `schedules/` that `index.ts` does not import never runs.** Workers bundling is
  static, so there is no glob and the import list is the registry. The tests read the
  directory and assert it against `TARGETS` both ways, matching a file name to the half of
  `owner/name` after the slash. `ponytail:` two owners with the same repo name would collide;
  the fix is `schedules/<owner>/<repo>.ts`.
- **A leaf ends in `as const`.** Without it the slot names widen to `string`, and the
  `REPOS` line in `schedules/index.ts` is where that fails to compile -- the same line a
  misspelt slot fails on. The check lives there so a leaf stays data with no import.
- **`schedules/index.ts` imports its leaves with a `.ts` extension.** `task crons` and
  `task targets` load that file with node's own resolver, which does not guess one.
  `allowImportingTsExtensions` in `tsconfig.json` is what lets tsc accept it.
- **Lookup is verbatim.** `0 */1 * * *` and `0 * * * *` are different keys.
- **Resolve the installation and mint its token inside a dispatch step, never in a step of
  their own.** Step output persists three days, so a shared token step would store a live
  credential. `tokenFor` caches one token per owner in memory for the invocation: an
  installation belongs to an account, so every repo under one owner shares it. Costs two
  subrequests per owner per firing, none per extra target.
- **A 404 from the installation lookup means the App is not installed on that repo's
  owner.** The step fails for good with `App is not installed on <owner>/<name>`. A repo
  has to be added to the installation by hand.
- **A dispatch names a ref, and an unnamed one is `main`, not the repo's default branch.**
  `dispatchWorkflow` sends `ref: target.ref ?? "main"`; GitHub requires the field, so there is
  no asking it for the default. Every target is on `main`, which is what makes the default
  right. A repo whose default is anything else answers 404, `isFatal` makes that
  non-retryable, and the slot goes quiet with nothing on GitHub to see -- so such a repo sets
  `ref`, or is renamed. Nothing here can check a ref against the real repo.
- **This is the targets' only clock, and it never learns whether a run passed.** Their
  workflows carry no `schedule:`. Each workload pings its own healthcheck; that is the only
  alert, and it is what catches this repo being the thing that broke. A workload without
  one says so in its `schedules/` file -- jshvn/apartments posts failures to an issue and
  accepts that a run never started goes unnoticed.
- **The target's `concurrency` group is what makes a retried dispatch safe.** GitHub keeps
  one pending run per group. Without `cancel-in-progress: false` a target can stack runs.
- **The instance id is the firing: `<scheduledTime>-<slugged cron>`.** In `src/index.ts`,
  beside its only caller. `scheduled` uses
  `createBatch`, which skips an id still in its retention window, so a slot Cloudflare
  invokes twice dispatches once. `create` would throw. The cron belongs in the id because
  two expressions can match the same minute.
- **A 4xx from GitHub is a typo, not a bad day.** `isFatal` names the statuses a retry
  cannot fix; the step rethrows those as `NonRetryableError`. 408 and 429 stay retryable.
- **`Env` is `Cloudflare.Env` plus the secrets.** Bindings come from the generated types, so
  a binding renamed in `wrangler.jsonc` stops compiling. Declaring `DISPATCH` by hand would
  typecheck clean and fail in production.
- **The cron arrives as `event.payload.cron`, put there by `scheduled`.** `run()` throws
  without it: nothing else should create instances. The binding's own `schedules` would
  carry it instead, but they need a paid plan, which is why the handler exists.
- **5 cron expressions per Cloudflare account** on the free plan, shared by every Worker on
  the account. Targets sharing an expression share one trigger, and `test/schedules.test.ts`
  holds the generated count at 5 -- otherwise `wrangler deploy` is where it is found out.
- **The `fetch` handler must exist and must not create instances.** Wrangler requires a
  default export, and an endpoint that started runs would let anyone fire every workload.
- **GitHub issues App keys as PKCS#1; WebCrypto imports PKCS#8 only.** `github.ts` throws
  with the `openssl` command rather than failing inside the signature. `task pkcs8`
  converts.
- **`wrangler secret put` reads one line when it has a terminal, and the whole of stdin
  when it does not.** A pasted PEM stores its `BEGIN` line alone, which is non-empty, so
  wrangler accepts it and the first dispatch is where it surfaces. `task secrets` redirects
  the file in for `GITHUB_APP_PRIVATE_KEY`; the two id secrets stay prompts.

## Verifying a change

`task check` is everything CI runs: typecheck, format, tests, dry-run deploy. After a change
that alters which expressions are in use, run `task crons` first -- `check` verifies the
generated triggers, it does not write them.

- Typecheck runs `wrangler types` first. `worker-configuration.d.ts` is gitignored and
  carries the runtime types and the bindings. Rerun after any binding change.
- Format is Biome, formatting only. No lint rules, so it will not catch `any`, an unused
  binding or a stray `console.log`.
- The dry run proves wrangler still parses `wrangler.jsonc` and resolves the binding.

None of that covers the GitHub App contract. Only a real dispatch does:

    npx wrangler workflows trigger dispatch '{"cron":"42 * * * *","scheduledTime":0}'

It dispatches for real, and `task inspect` shows the step and its output. Without the JSON
the instance has no cron to look up and `run()` throws.

## Hazards

- **A new cron does not fire straight away.** Cloudflare takes up to 15 minutes to
  propagate one. Measured here: a slot 59 seconds out was missed, one 6 minutes out fired.
  Changing or removing an expression counts as a change. Unchanged ones keep firing across
  deploys.
- **A push touching only docs, `LICENSE`, `Taskfile.yml` or `.github/` does not deploy.**
  `deploy.yml` uses a `paths-ignore` deny-list, so a new shipping file deploys without being
  added to anything. `check` still runs on every push. `workflow_dispatch` forces a deploy.
- **npm 11 gates install scripts, and `allowScripts` in `package.json` pins the approvals
  by exact version.** `esbuild@0.28.1` and `workerd@1.20260828.1` are approved there, so
  `npm ci` alone gives working binaries. Bumping either package moves it past its pin, and
  until `allowScripts` is updated wrangler and vitest install without theirs. `fsevents`
  warns and is meant to: vitest only wants it to watch files.
- **`task clean` removes `node_modules`, `.wrangler` and `worker-configuration.d.ts`, and
  nothing has to be run by hand afterwards.** Every task using a binary from `node_modules`
  depends on the internal `installed` task, which runs `npm ci` when
  `node_modules/.bin/wrangler` is missing and is skipped by its `status` when it is not --
  so a clean costs one install on the next task and nothing on any run after. Untouched, the
  failure would be `sh: wrangler: command not found`, and the `npx` tasks are worse: they
  fetch a wrangler from the registry without a word, so a deploy would ship through a version
  this repo never pinned. `clean` leaves `*.pem` and `.dev.vars` -- both gitignored, neither
  reproducible by a rebuild, and a `.pem` still present is a live App key.
- **A PEM private-key header in Bash tool text trips the secret-scan hook**, test fixtures
  included. `test/github.test.ts` builds the header from fragments. Write such files with
  Write or Edit.
- **A transferred repo has to be renamed in `schedules/`.** GitHub answers the old name with
  a redirect, and a redirected POST is not a dispatch.
- **Check `npm view` before pinning anything.** TypeScript is on 7, vitest on 4;
  `@cloudflare/workers-types` is superseded by `wrangler types`.
