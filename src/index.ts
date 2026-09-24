// A cron trigger in wrangler.jsonc invokes `scheduled` once per matching expression, and it
// creates one Workflow instance carrying that expression. All the instance has to do is look
// up the targets claiming it and dispatch them.
//
// The cron lives on the Worker rather than on the Workflow binding's own `schedules`, which
// are a paid-plan feature: `wrangler deploy` rejects them on the free plan. The cost is this
// one indirection, and a ceiling of 5 cron expressions per Cloudflare account.
//
// It does not watch what happens next. Each workload alerts on its own, most by pinging a
// healthcheck, which also catches a run that never starts -- including when this repo is
// the thing that broke. schedules/ says which workloads alert some other way.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { jitterMinutes, selectTargets } from "../schedules"
import { appJwt, dispatchWorkflow, installationToken, isFatal, repoInstallation } from "./github"

/** What `scheduled` hands the instance. The cron string is the whole lookup key. */
export type Params = {
  /** The expression that fired, verbatim as Cloudflare configured it. */
  cron: string
  /** Epoch ms of the slot, for the log line. */
  scheduledTime: number
}

/**
 * The bindings come from `Cloudflare.Env`, which `wrangler types` generates from
 * wrangler.jsonc -- a binding renamed there stops compiling here instead of failing at
 * runtime. Secrets are set with `wrangler secret put`, so they are never in that file and
 * have to be declared.
 */
export type Env = Cloudflare.Env & {
  GITHUB_APP_ID: string
  /** PKCS#8 PEM. See the conversion note in github.ts. */
  GITHUB_APP_PRIVATE_KEY: string
}

// A dispatch is a single POST. Retrying it is safe: the target's concurrency group keeps at
// most one run pending, so a duplicate queues rather than doubling the work.
const RETRY = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const

/**
 * An installation token for one repo. The App is installed per account, so the token is
 * cached by owner: a firing with several targets under one owner looks the installation up
 * and mints once. The cache lives in memory for this invocation of `run` only -- never in
 * a step's output, which persists three days -- so a restarted instance simply mints again.
 *
 * ponytail: the cache trusts the owner, not the repo. A repo an installation excludes still
 * gets that owner's token when a sibling resolved first in the same firing, and fails at the
 * dispatch with a plain 404 instead of the "not installed" message. Keying by repo would
 * cost the lookup per target; the README says which install covers which owner.
 */
const tokenFor = async (env: Env, cache: Map<string, string>, repo: string): Promise<string> => {
  const owner = repo.split("/")[0] as string
  const cached = cache.get(owner)
  if (cached) return cached
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY)
  const token = await installationToken(jwt, await repoInstallation(jwt, repo))
  cache.set(owner, token)
  return token
}

export class Dispatch extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const cron = event.payload?.cron
    if (!cron) throw new Error("instance carried no cron; only the scheduled handler creates these")

    const targets = selectTargets(cron)
    // wrangler.jsonc and schedules/ disagree. The tests catch this before deploy; if it
    // reaches production, failing loudly beats a schedule that silently does nothing.
    if (targets.length === 0) throw new Error(`no target in schedules/ claims cron "${cron}"`)

    // A jittered slot waits before dispatching anything. The wait is drawn inside a step so
    // a restarted instance sleeps what it drew rather than drawing again. A sleep costs no
    // CPU, and the two steps are all a firing adds.
    const jitter = jitterMinutes(cron)
    if (jitter > 0) {
      const ms = await step.do("pick a delay", RETRY, async () =>
        Math.floor(Math.random() * jitter * 60_000),
      )
      await step.sleep("jitter", ms)
    }

    const tokens = new Map<string, string>()
    const dispatched: string[] = []
    for (const target of targets) {
      // The token is resolved inside the step rather than in one shared step above, so it
      // is never written to workflow state. The cost is two subrequests per owner per
      // firing: one lookup, one mint.
      await step.do(`dispatch ${target.repo} ${target.workflow}`, RETRY, async () => {
        try {
          const token = await tokenFor(this.env, tokens, target.repo)
          await dispatchWorkflow(token, target)
        } catch (err) {
          // A 404 for a workflow file that is not there, or for a repo the App is not
          // installed on, a 403 for a permission the App was never granted: three retries
          // only delay the message by a minute.
          if (isFatal(err)) throw new NonRetryableError((err as Error).message)
          throw err
        }
        return { repo: target.repo, workflow: target.workflow }
      })
      dispatched.push(`${target.repo}/${target.workflow}`)
    }

    return { cron, scheduledTime: event.payload.scheduledTime, dispatched }
  }
}

/**
 * The instance id for one firing. Deterministic, so a slot that Cloudflare invokes twice
 * asks for an id that already exists instead of dispatching twice. The cron belongs in the
 * id because two expressions can match the same minute.
 *
 * Cloudflare allows `[A-Za-z0-9_-]`. Every character outside that set becomes `_` and two
 * hex digits -- including `_` itself, so nothing but an escape can produce one and distinct
 * crons keep distinct ids whatever they contain. Escaping by code point rather than by a
 * table of the characters cron is known to use is what keeps that true: it needs no claim
 * about which spellings Cloudflare accepts, and it leaves case alone, so two expressions
 * differing only in case stay two expressions here as they do everywhere else.
 *
 * ponytail: the escape expands, so a long enough list cron would pass Cloudflare's
 * 100-character id limit and be rejected at `createBatch`. The tests assert the configured
 * crons are inside it; a longer one would want a hash here instead.
 */
export const instanceId = (cron: string, scheduledTime: number): string =>
  `${scheduledTime}-${cron.replace(
    /[^A-Za-z0-9-]/g,
    (c) => `_${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  )}`

export default {
  // One instance per firing, under an id derived from the slot. `createBatch` rather than
  // `create` because it is the documented idempotent one: an id still inside its retention
  // window is skipped, so a slot Cloudflare invokes twice dispatches once. A batch of one
  // is the whole batch -- this handler is called once per expression.
  scheduled: async (controller: ScheduledController, env: Env) => {
    await env.DISPATCH.createBatch([
      {
        id: instanceId(controller.cron, controller.scheduledTime),
        params: { cron: controller.cron, scheduledTime: controller.scheduledTime },
      },
    ])
  },

  // Wrangler requires a fetch handler. Nothing should reach this Worker over HTTP, and an
  // endpoint that created instances would let anyone start every workload on the list.
  fetch: () => new Response("not found", { status: 404 }),
}
