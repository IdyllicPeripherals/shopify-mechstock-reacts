import crypto from "node:crypto"
import { type NextRequest, NextResponse } from "next/server"

// Runs on the Node.js runtime because we need `node:crypto` for HMAC verification.
export const runtime = "nodejs"
// Never cache — every request mutates Shopify metafields.
export const dynamic = "force-dynamic"

const ADMIN_API_VERSION = "2025-01"
const REACTIONS_NAMESPACE = "custom"
const REACTIONS_KEY = "reactions"
const PLAY_COUNT_KEY = "play_count"

// Belt-and-suspenders with `dynamic = "force-dynamic"`: this defeats the Vercel CDN
// caching GET responses (`x-vercel-cache: HIT`), which would otherwise serve stale
// reaction/play counts.
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
} as const

function jsonNoStore(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { status: init?.status, headers: NO_STORE_HEADERS })
}

type ReactionBody = {
  handle: string
  emoji: string
  action: "add" | "remove"
}

type PlayBody = {
  handle: string
  action: "play"
}

type RequestBody = ReactionBody | PlayBody

/**
 * Verifies a Shopify App Proxy request.
 *
 * Shopify signs the *query string* it forwards (not the POST body): it removes the
 * `signature` param, sorts the remaining params, joins them as `key=value` with no
 * separator, and HMAC-SHA256s that string (hex digest) with the app's shared secret.
 * Reproducing that and comparing in constant time proves the request came through
 * Shopify's proxy and wasn't forged by a browser hitting this endpoint directly.
 */
function verifyAppProxySignature(searchParams: URLSearchParams, secret: string): boolean {
  const signature = searchParams.get("signature")
  if (!signature) return false

  // Collect every param except `signature`, grouping repeated keys (Shopify joins
  // array values with a comma).
  const grouped = new Map<string, string[]>()
  for (const [key, value] of searchParams.entries()) {
    if (key === "signature") continue
    const existing = grouped.get(key)
    if (existing) existing.push(value)
    else grouped.set(key, [value])
  }

  const message = Array.from(grouped.keys())
    .sort()
    .map((key) => `${key}=${grouped.get(key)!.join(",")}`)
    .join("")

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex")

  const digestBuffer = Buffer.from(digest, "utf8")
  const signatureBuffer = Buffer.from(signature, "utf8")
  if (digestBuffer.length !== signatureBuffer.length) return false
  return crypto.timingSafeEqual(digestBuffer, signatureBuffer)
}

async function shopifyAdminGraphQL<T>(
  shopDomain: string,
  adminToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Shopify Admin API error ${response.status}: ${text}`)
  }

  const json = (await response.json()) as { data?: T; errors?: unknown }
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`)
  }
  return json.data as T
}

const PRODUCT_QUERY = /* GraphQL */ `
  query ProductMetafields($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id
      reactions: metafield(namespace: "${REACTIONS_NAMESPACE}", key: "${REACTIONS_KEY}") {
        value
      }
      playCount: metafield(namespace: "${REACTIONS_NAMESPACE}", key: "${PLAY_COUNT_KEY}") {
        value
      }
    }
  }
`

const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`

type ProductQueryResult = {
  productByIdentifier: {
    id: string
    reactions: { value: string } | null
    playCount: { value: string } | null
  } | null
}

type MetafieldsSetResult = {
  metafieldsSet: {
    metafields: { key: string; value: string }[]
    userErrors: { field: string[]; message: string }[]
  }
}

function isReactionBody(body: RequestBody): body is ReactionBody {
  return body.action === "add" || body.action === "remove"
}

function parseReactions(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: Record<string, number> = {}
      for (const [key, value] of Object.entries(parsed)) {
        const n = Number(value)
        if (Number.isFinite(n)) result[key] = n
      }
      return result
    }
  } catch {
    // Corrupt/legacy value — start fresh rather than throwing.
  }
  return {}
}

export async function GET(request: NextRequest) {
  const appSecret = process.env.SHOPIFY_APP_SECRET
  const adminToken = process.env.SHOPIFY_ADMIN_TOKEN

  if (!appSecret || !adminToken) {
    return jsonNoStore({ error: "Server is not configured" }, { status: 500 })
  }

  // 1. Verify the request actually came through the Shopify App Proxy.
  const { searchParams } = request.nextUrl
  if (!verifyAppProxySignature(searchParams, appSecret)) {
    return jsonNoStore({ error: "Invalid signature" }, { status: 401 })
  }

  // Prefer the shop domain from the signed query params; fall back to an env override.
  const shopDomain = searchParams.get("shop") ?? process.env.SHOPIFY_STORE_DOMAIN
  if (!shopDomain) {
    return jsonNoStore({ error: "Unable to determine shop domain" }, { status: 400 })
  }

  // 2. Read and validate the request params from the query string.
  // The App Proxy only forwards GET requests, so handle/emoji/action arrive as query params.
  const handle = searchParams.get("handle")
  const action = searchParams.get("action")

  if (!handle) {
    return jsonNoStore({ error: "Missing product handle" }, { status: 400 })
  }

  if (action !== "add" && action !== "remove" && action !== "play") {
    return jsonNoStore({ error: "Unknown action" }, { status: 400 })
  }

  const body: RequestBody =
    action === "play"
      ? { handle, action }
      : { handle, action, emoji: searchParams.get("emoji") ?? "" }

  try {
    // 3. Load the product and its current metafields.
    const data = await shopifyAdminGraphQL<ProductQueryResult>(shopDomain, adminToken, PRODUCT_QUERY, {
      handle: body.handle,
    })

    const product = data.productByIdentifier
    if (!product) {
      return jsonNoStore({ error: "Product not found" }, { status: 404 })
    }

    if (body.action === "play") {
      const current = Number(product.playCount?.value ?? "0")
      const next = (Number.isFinite(current) ? current : 0) + 1

      const result = await shopifyAdminGraphQL<MetafieldsSetResult>(shopDomain, adminToken, METAFIELDS_SET_MUTATION, {
        metafields: [
          {
            ownerId: product.id,
            namespace: REACTIONS_NAMESPACE,
            key: PLAY_COUNT_KEY,
            type: "number_integer",
            value: String(next),
          },
        ],
      })

      const userErrors = result.metafieldsSet.userErrors
      if (userErrors.length > 0) {
        return jsonNoStore({ error: "Failed to update play count", details: userErrors }, { status: 502 })
      }

      return jsonNoStore({ handle: body.handle, playCount: next })
    }

    if (isReactionBody(body)) {
      if (typeof body.emoji !== "string" || !body.emoji) {
        return jsonNoStore({ error: "Missing emoji" }, { status: 400 })
      }

      const reactions = parseReactions(product.reactions?.value)
      const currentCount = reactions[body.emoji] ?? 0

      if (body.action === "add") {
        reactions[body.emoji] = currentCount + 1
      } else {
        const next = currentCount - 1
        if (next <= 0) delete reactions[body.emoji]
        else reactions[body.emoji] = next
      }

      const result = await shopifyAdminGraphQL<MetafieldsSetResult>(shopDomain, adminToken, METAFIELDS_SET_MUTATION, {
        metafields: [
          {
            ownerId: product.id,
            namespace: REACTIONS_NAMESPACE,
            key: REACTIONS_KEY,
            type: "json",
            value: JSON.stringify(reactions),
          },
        ],
      })

      const userErrors = result.metafieldsSet.userErrors
      if (userErrors.length > 0) {
        return jsonNoStore({ error: "Failed to update reactions", details: userErrors }, { status: 502 })
      }

      return jsonNoStore({ handle: body.handle, reactions })
    }

    return jsonNoStore({ error: "Unknown action" }, { status: 400 })
  } catch (error) {
    console.log("[v0] /api/reacts error:", error instanceof Error ? error.message : error)
    return jsonNoStore({ error: "Internal server error" }, { status: 500 })
  }
}
