import { describe, expect, it } from "vitest"
import { appJwt, dispatchWorkflow, isFatal, repoInstallation } from "../src/github"

// src/github.ts: the App JWT, the installation lookup, and the one POST that starts a
// workflow. No network -- appJwt is verified against a key generated here, and the two
// requests are handed their own fetch.

const PEM_HEAD = `-----BEGIN ${"PRIVATE KEY"}-----`
const PEM_TAIL = `-----END ${"PRIVATE KEY"}-----`

// atob/btoa rather than Buffer: the code under test runs on Workers, which has no Buffer.
const toBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const fromBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

const generatePkcs8Pem = async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer
  const b64 = toBase64(der).replace(/(.{64})/g, "$1\n")
  return { pem: `${PEM_HEAD}\n${b64}\n${PEM_TAIL}\n`, pair }
}

describe("appJwt", () => {
  it("signs claims GitHub accepts and verifies against the public key", async () => {
    const { pem, pair } = await generatePkcs8Pem()
    const now = 1_756_000_000_000
    const jwt = await appJwt("123456", pem, now)

    const [header, claims, sig] = jwt.split(".")
    const json = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(s)))
    expect(json(header as string)).toEqual({ alg: "RS256", typ: "JWT" })
    expect(json(claims as string)).toEqual({
      iss: "123456",
      iat: now / 1000 - 60, // backdated; GitHub rejects a future iat
      exp: now / 1000 - 60 + 540, // inside GitHub's 10 minute ceiling
    })

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      fromBase64Url(sig as string),
      new TextEncoder().encode(`${header}.${claims}`),
    )
    expect(verified).toBe(true)
  })

  it("rejects a PKCS#1 key with the conversion command", async () => {
    const pkcs1 = `-----BEGIN RSA ${"PRIVATE KEY"}-----\nAAAA\n-----END RSA ${"PRIVATE KEY"}-----`
    await expect(appJwt("1", pkcs1)).rejects.toThrow(/openssl pkcs8 -topk8/)
  })
})

/** A fetch answering every call with one status and body, remembering what it was asked. */
const responding = (status: number, body: string | null = null) => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init as RequestInit })
    return new Response(body, { status })
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

describe("repoInstallation", () => {
  it("asks for the repo's installation with the App JWT and returns its id", async () => {
    const { calls, fetch } = responding(200, JSON.stringify({ id: 12345678 }))
    const id = await repoInstallation("jwt", "acme/alpha", fetch)

    expect(id).toBe("12345678")
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/alpha/installation")
    expect(calls[0]?.init.method).toBeUndefined()
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer jwt")
  })

  // The message is the diagnosis: the App is installed per account, and a 404 here means
  // this repo's owner is not one of them. isFatal makes it a hard failure.
  it("names the repo and fails for good when the App is not installed there", async () => {
    const { fetch } = responding(404, "Not Found")
    const err = await repoInstallation("jwt", "acme/new-repo", fetch).catch((e) => e)
    expect(err.message).toMatch(/App is not installed on acme\/new-repo/)
    expect(isFatal(err)).toBe(true)
  })

  it("leaves a server error retryable", async () => {
    const { fetch } = responding(502, "bad gateway")
    const err = await repoInstallation("jwt", "acme/alpha", fetch).catch((e) => e)
    expect(err.message).toMatch(/502/)
    expect(isFatal(err)).toBe(false)
  })

  it("throws when the answer carries no id", async () => {
    const { fetch } = responding(200, "{}")
    await expect(repoInstallation("jwt", "acme/alpha", fetch)).rejects.toThrow(/no id/)
  })
})

describe("dispatchWorkflow", () => {
  const target = { repo: "jshvn/terraform", workflow: "sync.yml" }

  it("posts to the dispatches endpoint, defaulting the ref to main", async () => {
    const { calls, fetch } = responding(204)
    await dispatchWorkflow("tok", target, fetch)

    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/jshvn/terraform/actions/workflows/sync.yml/dispatches",
    )
    expect(calls[0]?.init.method).toBe("POST")
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ ref: "main", inputs: {} })
  })

  it("sends the target's own ref and inputs when given", async () => {
    const { calls, fetch } = responding(204)
    await dispatchWorkflow("tok", { ...target, ref: "trunk", inputs: { seed: "true" } }, fetch)
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      ref: "trunk",
      inputs: { seed: "true" },
    })
  })

  it("throws on anything but 204", async () => {
    const { fetch } = responding(404, "not found")
    await expect(dispatchWorkflow("tok", target, fetch)).rejects.toThrow(/404/)
  })

  // The step retries what a second attempt could fix and fails fast on what it cannot.
  it("marks a refusal fatal and a server error retryable", async () => {
    const fatal = [400, 401, 403, 404, 422]
    const retryable = [408, 429, 500, 502, 503]
    for (const status of [...fatal, ...retryable]) {
      const { fetch } = responding(status, "body")
      const err = await dispatchWorkflow("tok", target, fetch).catch((e) => e)
      expect(isFatal(err), String(status)).toBe(fatal.includes(status))
    }
  })

  it("does not call a plain error fatal", () => {
    expect(isFatal(new Error("network"))).toBe(false)
  })
})
