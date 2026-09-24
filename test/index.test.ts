import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { crons, SLOTS, selectTargets, TARGETS } from "../schedules"
import type { Env, Params } from "../src/index"

// src/index.ts: the two handlers, the instance body and the instance id. Everything
// GitHub-facing is mocked -- what matters here is which targets get a step, what reaches the
// instance, and that the fetch handler stays inert.
vi.mock("../src/github", () => ({
  appJwt: vi.fn(async () => "jwt"),
  repoInstallation: vi.fn(async (_jwt: string, repo: string) => `inst-${repo.split("/")[0]}`),
  installationToken: vi.fn(async (_jwt: string, id: string) => `tok-${id}`),
  dispatchWorkflow: vi.fn(async () => undefined),
  isFatal: vi.fn(() => false),
}))

// The registry stays real; only selectTargets is wrapped, so one test can hand the instance
// a cron with a shape schedules/ does not have today, such as two targets under one owner.
vi.mock("../schedules", async (importOriginal) => {
  const real = await importOriginal<typeof import("../schedules")>()
  return { ...real, selectTargets: vi.fn(real.selectTargets) }
})

const { Dispatch, default: worker, instanceId } = await import("../src/index")
const github = await import("../src/github")
const schedules = await import("../schedules")

/** An env whose Workflow binding records every instance asked for and creates none. */
const recordingEnv = () => {
  const created: { id: string; params: Params }[] = []
  const env = {
    DISPATCH: {
      create: vi.fn(async () => {
        throw new Error("create() must not be called; scheduled uses createBatch")
      }),
      createBatch: vi.fn(async (batch: { id: string; params: Params }[]) => {
        created.push(...batch)
      }),
    },
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "pem",
  }
  return { created, env: env as unknown as Env }
}

/** A step that runs its callback inline and remembers the step names, in order. A sleep
 * returns at once and is named `sleep <name>`, with its length kept in `slept`. */
const recordingStep = () => {
  const names: string[] = []
  const slept: number[] = []
  const step = {
    do: async (name: string, _opts: unknown, fn: () => Promise<unknown>) => {
      names.push(name)
      return fn()
    },
    sleep: async (name: string, ms: number) => {
      names.push(`sleep ${name}`)
      slept.push(ms)
    },
  }
  return { names, slept, step: step as unknown as WorkflowStep }
}

const runWith = (payload: Partial<Params>, env: Env, step: WorkflowStep) =>
  new Dispatch(undefined as never, env).run({ payload } as unknown as WorkflowEvent<Params>, step)

// The handler declares no parameters at all, so within this codebase it cannot reach the
// binding even if it wanted to. Handing it one anyway is what shows the runtime agrees.
const callFetch = worker.fetch as unknown as (req: Request, env: Env) => Response

describe("fetch handler", () => {
  it("404s and never creates an instance", async () => {
    const { created, env } = recordingEnv()
    const res = callFetch(new Request("https://dispatch/"), env)

    expect(res.status).toBe(404)
    expect(created).toEqual([])
    expect(env.DISPATCH.create).not.toHaveBeenCalled()
    expect(env.DISPATCH.createBatch).not.toHaveBeenCalled()
  })

  it("stays a 404 for the paths that would be worth guessing", async () => {
    const { env } = recordingEnv()
    for (const path of ["/", "/__scheduled", "/dispatch", "/42%20*%20*%20*%20*"]) {
      const res = callFetch(new Request(`https://dispatch${path}`), env)
      expect(res.status, path).toBe(404)
    }
  })
})

describe("scheduled handler", () => {
  it("asks for exactly one instance, keyed to the slot, carrying the cron", async () => {
    const { created, env } = recordingEnv()
    const at = 1_756_000_000_000
    await worker.scheduled({ cron: "42 * * * *", scheduledTime: at } as ScheduledController, env)

    expect(created).toEqual([
      { id: instanceId("42 * * * *", at), params: { cron: "42 * * * *", scheduledTime: at } },
    ])
  })

  it("gives the same slot the same id twice, so a repeated invocation collides", async () => {
    const { created, env } = recordingEnv()
    const slot = { cron: "42 * * * *", scheduledTime: 1_756_000_000_000 } as ScheduledController
    await worker.scheduled(slot, env)
    await worker.scheduled(slot, env)

    expect(created[0]?.id).toBe(created[1]?.id)
  })
})

// Cloudflare's rule for instance ids: [A-Za-z0-9_-], first character not a dash, 100 max.
describe("instanceId", () => {
  it("is legal for every cron this Worker is configured with", () => {
    for (const cron of crons()) {
      const id = instanceId(cron, 1_756_000_000_000)
      expect(id, id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/)
      expect(id.length, id).toBeLessThanOrEqual(100)
    }
  })

  it("gives one slot one id, so a repeated invocation collides on purpose", () => {
    expect(instanceId("42 * * * *", 1_756_000_000_000)).toBe(
      instanceId("42 * * * *", 1_756_000_000_000),
    )
  })

  it("keeps expressions apart that fire in the same minute", () => {
    const at = 1_756_000_000_000
    expect(instanceId("0 3 * * *", at)).not.toBe(instanceId("0 * * * *", at))
  })

  // Steps, lists and names are all legal cron and none of their characters are legal in an
  // id. Only the two expressions configured today are covered above, so this is the guard
  // that a cron using any of them stays deployable.
  it("is legal for every character cron can contain", () => {
    const spellings = [
      "*/15 * * * *",
      "0,30 * * * *",
      "0 9-17 * * 1-5",
      "0 0 1 JAN,JUN *",
      "0 0 * * sun",
      "15 3 */2 * MON-FRI",
    ]
    for (const cron of spellings) {
      const id = instanceId(cron, 1_756_000_000_000)
      expect(id, cron).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/)
      expect(id.length, cron).toBeLessThanOrEqual(100)
    }
  })

  // A range and a list are different schedules; an escape that flattened both to the same
  // character would make one firing skip the other as an id it had already seen.
  it("keeps a range, a list and a step apart", () => {
    const at = 1_756_000_000_000
    const ids = ["0 1-5 * * *", "0 1,5 * * *", "0 1/5 * * *"].map((c) => instanceId(c, at))
    expect(new Set(ids).size).toBe(3)
  })

  // Lookup is verbatim everywhere else, so two spellings are two expressions here too. An
  // escape that case-folded would hand them one id and skip whichever fired second.
  it("keeps two spellings of one schedule apart", () => {
    const at = 1_756_000_000_000
    expect(instanceId("0 0 * * sun", at)).not.toBe(instanceId("0 0 * * SUN", at))
  })

  // Nothing in cron has to be a character this function was written knowing about.
  it("escapes anything a cron field could carry", () => {
    const at = 1_756_000_000_000
    for (const cron of ["0 0 1 JAN,JUN *", "0 0 L W * ?", "0 0 * * 5#3", "@daily", "0 0 * * *"]) {
      const id = instanceId(cron, at)
      expect(id, cron).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/)
    }
  })

  // The escape expands, so length is the ceiling worth pinning: this is the guard that the
  // crons actually configured stay inside Cloudflare's limit.
  it("stays inside the 100-character limit for a realistic list cron", () => {
    const id = instanceId("0,5,10,15,20,25,30,35,40,45,50,55 * * * *", 1_756_000_000_000)
    expect(id.length, id).toBeLessThanOrEqual(100)
  })
})

describe("Dispatch.run", () => {
  beforeEach(() => {
    vi.mocked(github.repoInstallation).mockClear()
    vi.mocked(github.installationToken).mockClear()
    vi.mocked(github.dispatchWorkflow).mockClear()
    vi.mocked(schedules.selectTargets).mockClear()
  })

  /** What the mocked GitHub saw: the repos looked up, the ids minted, the tokens dispatched. */
  const seen = () => ({
    lookedUp: vi.mocked(github.repoInstallation).mock.calls.map(([, repo]) => repo),
    minted: vi.mocked(github.installationToken).mock.calls.map(([, id]) => id),
    dispatched: vi.mocked(github.dispatchWorkflow).mock.calls.map(([tok, t]) => [tok, t.repo]),
  })

  /** Run one firing whose cron is claimed by exactly these repos, each on a sync.yml. */
  const dispatchTo = (...repos: string[]) => {
    const cron = "0 5 * * *"
    vi.mocked(schedules.selectTargets).mockReturnValueOnce(
      repos.map((repo) => ({ repo, workflow: "sync.yml", cron })),
    )
    return runWith({ cron, scheduledTime: 0 }, recordingEnv().env, recordingStep().step)
  }

  it("throws when the instance carries no cron", async () => {
    const { env } = recordingEnv()
    await expect(runWith({}, env, recordingStep().step)).rejects.toThrow(/no cron/)
  })

  it("throws when no target claims the cron", async () => {
    const { env } = recordingEnv()
    const { step } = recordingStep()
    await expect(runWith({ cron: "0 0 31 2 *" }, env, step)).rejects.toThrow(/no target/)
  })

  it("runs one step per target and reports what it dispatched", async () => {
    const { env } = recordingEnv()
    const { names, step } = recordingStep()
    const cron = TARGETS[0]?.cron as string
    const claiming = selectTargets(cron)

    const out = await runWith({ cron, scheduledTime: 0 }, env, step)

    expect(names).toEqual(claiming.map((t) => `dispatch ${t.repo} ${t.workflow}`))
    expect(out.dispatched).toEqual(claiming.map((t) => `${t.repo}/${t.workflow}`))
    expect(vi.mocked(github.dispatchWorkflow)).toHaveBeenCalledTimes(claiming.length)
  })

  // The wait is the point of a jittered slot. Drawn outside a step, a restarted instance
  // would draw again; drawn after the dispatch, it would delay nothing.
  it("waits a drawn delay under the slot's ceiling before dispatching a jittered slot", async () => {
    const { env } = recordingEnv()
    const { names, slept, step } = recordingStep()
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999999)

    await runWith({ cron: SLOTS.every4h, scheduledTime: 0 }, env, step)
    random.mockRestore()

    const dispatches = selectTargets(SLOTS.every4h).map((t) => `dispatch ${t.repo} ${t.workflow}`)
    expect(names).toEqual(["pick a delay", "sleep jitter", ...dispatches])
    expect(slept).toEqual([Math.floor(0.999999 * 30 * 60_000)])
  })

  it("mints the token inside the step and keeps it out of the step's output", async () => {
    const { env } = recordingEnv()
    const outputs: unknown[] = []
    const step = {
      do: async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => {
        const out = await fn()
        outputs.push(out)
        return out
      },
    } as unknown as WorkflowStep

    await runWith({ cron: TARGETS[0]?.cron as string, scheduledTime: 0 }, env, step)

    // Step output persists for three days. A token reaching it would be a stored credential.
    expect(vi.mocked(github.installationToken)).toHaveBeenCalled()
    for (const out of outputs) expect(JSON.stringify(out)).not.toContain("tok")
  })

  it("looks up and mints once for a burst of targets under one owner", async () => {
    await dispatchTo("acme/alpha", "acme/beta")

    expect(seen()).toEqual({
      lookedUp: ["acme/alpha"],
      minted: ["inst-acme"],
      dispatched: [
        ["tok-inst-acme", "acme/alpha"],
        ["tok-inst-acme", "acme/beta"],
      ],
    })
  })

  it("keeps two owners on two installations and two tokens", async () => {
    await dispatchTo("jshvn/terraform", "acme/alpha")

    expect(seen()).toEqual({
      lookedUp: ["jshvn/terraform", "acme/alpha"],
      minted: ["inst-jshvn", "inst-acme"],
      dispatched: [
        ["tok-inst-jshvn", "jshvn/terraform"],
        ["tok-inst-acme", "acme/alpha"],
      ],
    })
  })

  // A repo the App is not installed on answers the lookup with a 404, which isFatal routes
  // to a hard failure. The message has to name the repo, since that is the whole diagnosis.
  it("fails the step for good when the App is not installed on the repo", async () => {
    vi.mocked(github.repoInstallation).mockRejectedValueOnce(
      new Error("App is not installed on acme/new-repo"),
    )
    vi.mocked(github.isFatal).mockReturnValueOnce(true)

    const err = await dispatchTo("acme/new-repo").catch((e) => e)

    expect(err).toBeInstanceOf(NonRetryableError)
    expect(err.message).toMatch(/not installed on acme\/new-repo/)
    expect(seen().dispatched).toEqual([])
  })
})
