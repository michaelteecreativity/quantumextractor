import dns from 'node:dns/promises'
import net from 'node:net'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MAX_BASE_URLS = 100
const MAX_PATHS = 20
const MAX_BODY_BYTES = 1_500_000
const PAGE_TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 5
const MAX_TARGETS_PER_BATCH = 50
const MAX_SESSION_BATCHES = 400
const SESSION_PATTERN = /^[a-zA-Z0-9_-]{16,96}$/

const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi
const MAILTO_PATTERN = /mailto:([^"'\\s>]+)/gi

function canonicalTarget(value: string) {
  const url = new URL(value)
  url.hash = ''
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString()
}

function normalizePath(value: unknown) {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null
  return path
}

function isPrivateAddress(address: string) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase()
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
  }
  return true
}

async function assertSafeUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('invalid_url')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url')
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || net.isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error('blocked_private_network')
  try {
    const addresses = await dns.lookup(url.hostname, { all: true })
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('blocked_private_network')
  } catch (error) {
    if (error instanceof Error && error.message === 'blocked_private_network') throw error
    throw new Error('connection_failed')
  }
  return url
}

function decodeEntities(value: string) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/gi, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#x27;': "'" }[entity.toLowerCase()] ?? entity))
}

function cleanEmail(value: string) {
  const email = decodeEntities(value).trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

function extractEmails(html: string) {
  const withoutCode = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  const found = new Set<string>()
  for (const match of withoutCode.matchAll(MAILTO_PATTERN)) {
    const email = cleanEmail(match[1].split(/[?#]/, 1)[0])
    if (email) found.add(email)
  }
  const visibleText = withoutCode.replace(/<[^>]+>/g, ' ')
  for (const match of visibleText.matchAll(EMAIL_PATTERN)) {
    const email = cleanEmail(match[0])
    if (email) found.add(email)
  }
  return [...found]
}

async function readLimitedBody(response: Response) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_BODY_BYTES) throw new Error('response_too_large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new Error('response_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(body)
}

async function fetchPage(target: string) {
  let current = await assertSafeUrl(target)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
    try {
      const response = await fetch(current, { signal: controller.signal, redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'QuantumExtractor/1.0 (+https://vercel.com)' }, cache: 'no-store' })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || redirect === MAX_REDIRECTS) return { kind: 'failure' as const, reason: 'http_error', httpStatus: response.status, retryable: false }
        current = await assertSafeUrl(new URL(location, current).toString())
        continue
      }
      if (!response.ok) return { kind: 'failure' as const, reason: 'http_error', httpStatus: response.status, retryable: response.status >= 500 }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) return { kind: 'failure' as const, reason: 'non_html', httpStatus: response.status, retryable: false }
      const html = await readLimitedBody(response)
      const emails = extractEmails(html)
      return { kind: 'success' as const, emails, httpStatus: response.status }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown_error'
      if (reason === 'response_too_large') return { kind: 'failure' as const, reason, retryable: false }
      if (reason === 'invalid_url' || reason === 'blocked_private_network' || reason === 'connection_failed') return { kind: 'failure' as const, reason, retryable: reason === 'connection_failed' }
      if (controller.signal.aborted) return { kind: 'failure' as const, reason: 'timeout', retryable: true }
      return { kind: 'failure' as const, reason: 'connection_failed', retryable: true }
    } finally { clearTimeout(timeout) }
  }
  return { kind: 'failure' as const, reason: 'http_error', retryable: false }
}

export async function POST(request: Request) {
  const session = request.headers.get('x-extraction-session') || ''
  const batchNumber = Number(request.headers.get('x-extraction-batch') || 0)
  const rateLimited = () => NextResponse.json({ error: 'rate_limited', message: 'Too many extraction requests. Please wait and try again.', retryAfter: 30 }, { status: 429, headers: { 'Retry-After': '30' } })
  if (!SESSION_PATTERN.test(session) || !Number.isInteger(batchNumber) || batchNumber < 1 || batchNumber > MAX_SESSION_BATCHES) return rateLimited()
  try {
    const body = await request.json()
    if ((!Array.isArray(body.urls) || !Array.isArray(body.paths)) && !Array.isArray(body.targets)) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    const suppliedTargets = Array.isArray(body.targets) ? [...new Set(body.targets.filter((value: unknown): value is string => typeof value === 'string').map((value: string) => value.trim()).filter(Boolean))].slice(0, MAX_TARGETS_PER_BATCH) : (Array.isArray(body.urls) && Array.isArray(body.paths) && body.paths.length === 0 ? [...new Set(body.urls.filter((value: unknown): value is string => typeof value === 'string').map((value: string) => value.trim()).filter(Boolean))].slice(0, MAX_TARGETS_PER_BATCH) : [])
    const inputUrls = Array.isArray(body.urls) ? [...new Set(body.urls.filter((url: unknown): url is string => typeof url === 'string').map((url: string) => url.trim()).filter(Boolean))].slice(0, MAX_BASE_URLS) : []
    const paths = Array.isArray(body.paths) ? [...new Set(body.paths.map(normalizePath).filter((path): path is string => Boolean(path)))].slice(0, MAX_PATHS) : []
    if (!suppliedTargets.length && (!inputUrls.length || !paths.length)) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    const targets: string[] = []
    let duplicatesRemoved = Math.max(0, (Array.isArray(body.targets) ? body.targets.length : inputUrls.length) - (suppliedTargets.length || inputUrls.length))
    if (suppliedTargets.length) {
      for (const target of suppliedTargets) {
        try {
          const safeTarget = canonicalTarget((await assertSafeUrl(target)).toString())
          if (targets.includes(safeTarget)) duplicatesRemoved += 1
          else targets.push(safeTarget)
        } catch (error) {
          const reason = error instanceof Error && ['invalid_url', 'blocked_private_network', 'connection_failed'].includes(error.message) ? error.message : 'invalid_url'
          targets.push(`__${reason}__${target}`)
        }
      }
    } else for (const input of inputUrls) {
      try {
        const base = await assertSafeUrl(input)
        for (const path of paths) {
          const target = canonicalTarget(new URL(path, `${base.origin}/`).toString())
          if (targets.includes(target)) duplicatesRemoved += 1
          else targets.push(target)
        }
      } catch (error) {
        const reason = error instanceof Error && ['invalid_url', 'blocked_private_network', 'connection_failed'].includes(error.message) ? error.message : 'invalid_url'
        targets.push(`__${reason}__${input}`)
      }
    }
    if (targets.length > MAX_TARGETS_PER_BATCH) return NextResponse.json({ error: 'invalid_request', message: `A batch may contain at most ${MAX_TARGETS_PER_BATCH} pages.` }, { status: 400 })
    const pages = []
    const results = []
    const failedPages = []
    for (const target of targets) {
      const started = Date.now()
      if (target.startsWith('__')) {
        const separator = target.indexOf('__', 2)
        const reason = target.slice(2, separator)
        failedPages.push({ url: target.slice(separator + 2), reason, retryable: reason === 'connection_failed' })
        continue
      }
      const page = await fetchPage(target)
      if (page.kind === 'success') {
        pages.push({ url: target, status: 'success', emails: page.emails, durationMs: Date.now() - started, httpStatus: page.httpStatus })
        for (const email of page.emails) results.push({ email, source: target, status: 'found' })
        if (!page.emails.length) failedPages.push({ url: target, reason: 'no_email', retryable: false })
      } else { pages.push({ url: target, status: 'failed', emails: [], durationMs: Date.now() - started, httpStatus: page.httpStatus }); failedPages.push({ url: target, reason: page.reason, retryable: page.retryable, ...(page.httpStatus ? { httpStatus: page.httpStatus } : {}) }) }
    }
    const uniqueResults = [...new Map(results.map((result) => [result.email, result])).values()]
    return NextResponse.json({ success: true, summary: { urlsScanned: targets.length, emailsFound: uniqueResults.length, duplicatesRemoved, failedPages: failedPages.length }, results: uniqueResults, pages, failedPages })
  } catch { return NextResponse.json({ error: 'invalid_request' }, { status: 400 }) }
}

export async function OPTIONS() { return new NextResponse(null, { status: 204 }) }
