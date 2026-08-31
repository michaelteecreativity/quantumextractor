'use client'

import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Clipboard, Download, FileDown, FileUp, Info, Link2, Mail, Pause, Play, RotateCcw, Search, Target, Trash2, X } from 'lucide-react'

const MAX_URLS = 2000
const PRIVACY_POLICY_PATH = '/policies/privacy-policy'
const DEFAULT_PATHS = ['/contact', '/about']
const SEGMENTS = ['All', 'Gmail', 'Outlook', 'Yahoo', 'Domain'] as const
type Segment = typeof SEGMENTS[number]
type Result = { email: string; source: string; status: string }
type Failure = { url: string; reason: string; retryable?: boolean; httpStatus?: number; durationMs?: number; retryCount?: number }

function normalizeLines(value: string) { return value.split(/\n|,|\s+/).map((item) => item.trim()).filter(Boolean) }
function validUrl(value: string) { try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false } }
function validPath(value: string) { return value.startsWith('/') && !value.startsWith('//') }
function classify(email: string): Exclude<Segment, 'All'> { const domain = email.split('@')[1]?.toLowerCase(); if (domain === 'gmail.com') return 'Gmail'; if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'Outlook'; if (['yahoo.com', 'ymail.com', 'rocketmail.com'].includes(domain)) return 'Yahoo'; return 'Domain' }
function csvCell(value: unknown) { return `"${String(value ?? '').replaceAll('"', '""')}"` }
function csvRows(rows: Result[]) { return [['Email', 'Source', 'Status'], ...rows.map((row) => [row.email, row.source, row.status])].map((row) => row.map(csvCell).join(',')).join('\n') }
function download(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url) }

export default function Page() {
  const [urls, setUrls] = useState('')
  const [paths, setPaths] = useState<string[]>(DEFAULT_PATHS)
  const [privacyPath, setPrivacyPath] = useState(PRIVACY_POLICY_PATH)
  const [privacyAdded, setPrivacyAdded] = useState(false)
  const [customPath, setCustomPath] = useState('')
  const [isScanning, setIsScanning] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState('Preparing URLs')
  const [notice, setNotice] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [failures, setFailures] = useState<Failure[]>([])
  const [duplicatesRemoved, setDuplicatesRemoved] = useState(0)
  const [query, setQuery] = useState('')
  const [segment, setSegment] = useState<Segment>('All')
  const [copied, setCopied] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pauseRef = useRef(false)
  const urlList = useMemo(() => [...new Set(normalizeLines(urls))], [urls])
  const invalidCount = urlList.filter((url) => !validUrl(url)).length
  const uniqueResults = useMemo(() => [...new Map(results.map((result) => [result.email, result])).values()], [results])
  const filteredResults = useMemo(() => uniqueResults.filter((result) => (segment === 'All' || classify(result.email) === segment) && (!query || `${result.email} ${result.source}`.toLowerCase().includes(query.toLowerCase()))), [uniqueResults, segment, query])
  const counts = useMemo(() => Object.fromEntries(SEGMENTS.slice(1).map((name) => [name, uniqueResults.filter((result) => classify(result.email) === name).length])) as Record<Exclude<Segment, 'All'>, number>, [uniqueResults])

  function addPath(value: string) { const path = value.trim(); if (!validPath(path)) { setNotice('Custom paths must begin with a single /.'); return } if (paths.includes(path)) { setNotice('That page path is already selected.'); return } setPaths((current) => [...current, path]); setCustomPath(''); setNotice(`${path} added to the scan.`) }
  function addPrivacy() {
    const path = privacyPath.trim() || PRIVACY_POLICY_PATH
    if (!validPath(path)) { setNotice('Privacy path must begin with a single /.'); return }
    const baseUrls = [...new Set(normalizeLines(urls))]
    if (!baseUrls.length) { setNotice('Add or import URLs first, then add the privacy policy path.'); return }
    const transformed = [...new Set(baseUrls.map((value) => {
      try { return new URL(path, `${new URL(value).origin}/`).toString() } catch { return value }
    }))]
    setUrls(transformed.join('\n'))
    setPaths((current) => current.filter((item) => item !== path))
    setPrivacyAdded(true)
    setNotice(`${transformed.length} URL${transformed.length === 1 ? '' : 's'} updated to the privacy policy path.`)
  }
  function removePath(path: string) { setPaths((current) => current.filter((item) => item !== path)); if (path === privacyPath) setPrivacyPath(PRIVACY_POLICY_PATH) }

  async function startScan() {
    if (!urlList.length) return setNotice('Add at least one website URL to begin.')
    if (invalidCount) return setNotice('Please remove invalid URLs before scanning.')
    if (!paths.length) return setNotice('Select at least one page path before scanning.')
    setNotice(''); setResults([]); setFailures([]); setDuplicatesRemoved(0); setIsScanning(true); setIsPaused(false); pauseRef.current = false; setProgress(0); setPhase('Preparing URLs'); abortRef.current = new AbortController()
    const session = `${crypto.randomUUID()}-${crypto.randomUUID()}`; const allResults: Result[] = []; const allFailures: Failure[] = []; let duplicates = 0
    const baseBatchSize = Math.max(1, Math.floor(50 / paths.length))
    const scanCount = urlList.length * paths.length
    try {
    for (let offset = 0; offset < urlList.length; offset += baseBatchSize) {
        while (pauseRef.current) await new Promise((resolve) => window.setTimeout(resolve, 200))
        const batch = urlList.slice(offset, offset + baseBatchSize); setPhase(offset === 0 ? 'Scanning pages' : 'Extracting emails')
        let response: Response | undefined
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const payload = { urls: batch, paths: [...paths] }
          if (process.env.NODE_ENV === 'development') console.log('[v0] extraction payload', payload)
          response = await fetch('/api/extract', { method: 'POST', headers: { 'content-type': 'application/json', 'x-extraction-session': session, 'x-extraction-batch': String(Math.floor(offset / baseBatchSize) + 1) }, body: JSON.stringify(payload), signal: abortRef.current.signal })
          if (response.status !== 429) break
          const wait = Math.min(Number(response.headers.get('Retry-After') || 5), 30); setNotice(`The extraction service asked us to wait ${wait} seconds.`); await new Promise((resolve) => window.setTimeout(resolve, wait * 1000))
        }
        if (!response) throw new Error('No response from extraction service')
        let data: { results?: Result[]; failedPages?: Failure[]; duplicatesRemoved?: number; error?: string; message?: string }
        try { data = await response.json() } catch { throw new Error('The extraction service returned invalid JSON.') }
        if (!response.ok) throw new Error(data.message || data.error || `Extraction failed with HTTP ${response.status}.`)
        allResults.push(...(data.results || [])); allFailures.push(...(data.failedPages || [])); duplicates += data.duplicatesRemoved || 0; setResults([...new Map(allResults.map((item) => [item.email, item])).values()]); setFailures([...allFailures]); setDuplicatesRemoved(duplicates); setProgress(Math.round((((offset + batch.length) * paths.length) / scanCount) * 100)); if (offset + batch.length >= urlList.length) setPhase('Cleaning results')
      }
      setProgress(100); setPhase('Complete'); setNotice(allResults.length ? `Scan complete. Found ${new Set(allResults.map((item) => item.email)).size} unique email${allResults.length === 1 ? '' : 's'}.` : 'Scan complete. No public emails found.')
    } catch (error) { setNotice(error instanceof DOMException && error.name === 'AbortError' ? 'Scan stopped.' : error instanceof Error ? error.message : 'Extraction failed. Please try again.') } finally { setIsScanning(false); abortRef.current = null }
  }

  function reset() { abortRef.current?.abort(); pauseRef.current = false; setPrivacyAdded(false); setUrls(''); setProgress(0); setPhase('Preparing URLs'); setNotice(''); setIsScanning(false); setIsPaused(false); setResults([]); setFailures([]); setDuplicatesRemoved(0) }
  function clearResults() { setResults([]); setFailures([]); setDuplicatesRemoved(0); setNotice('Results cleared. Your URLs and paths are unchanged.') }
  function importFile(event: React.ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setUrls(String(reader.result || '')); reader.readAsText(file); event.target.value = '' }
  function copy(items: Result[], label: string) { navigator.clipboard?.writeText(items.map((item) => item.email).join('\n')).then(() => { setCopied(label); window.setTimeout(() => setCopied(''), 2200) }).catch(() => setCopied('Clipboard unavailable.')) }
  function exportData(format: 'csv' | 'json') { download(`quantum-extractor-results.${format}`, format === 'csv' ? csvRows(uniqueResults) : JSON.stringify(uniqueResults, null, 2), format === 'csv' ? 'text/csv' : 'application/json') }
  function exportFailures() { download('quantum-extractor-failed-pages.csv', [['URL', 'Reason', 'HTTP Status'], ...failures.map((item) => [item.url, item.reason, item.httpStatus || ''])].map((row) => row.map(csvCell).join(',')).join('\n'), 'text/csv') }

  return <main className="extractor-shell"><header className="brand-bar"><div className="brand-mark"><Target aria-hidden="true" /></div><div><p className="brand-name">Quantum Extractor</p><p className="brand-subtitle">Bulk email extraction tool</p></div></header><section className="hero"><h1>Extract Emails from Any Website</h1><p>Paste your URLs below to automatically scan pages, extract email<br className="desktop-break" /> addresses, and export a clean, deduplicated list.</p></section><div className="tip-banner" role="note"><Info aria-hidden="true" /><span><strong>Tip:</strong> Add <code>/policies/privacy-policy</code> to scan Shopify privacy pages.</span></div><section className="extract-card"><div className="section-heading"><div className="lime-icon"><Link2 aria-hidden="true" /></div><div><h2>Enter URLs</h2><p>Paste website URLs below (one per line, max 2000)</p></div></div><label className="sr-only" htmlFor="urls">Website URLs</label><textarea id="urls" value={urls} onChange={(event) => setUrls(event.target.value)} placeholder={'https://example-store.myshopify.com\nhttps://another-store.com'} disabled={isScanning} /><div className="url-meta"><span>{urlList.length.toLocaleString()} / {MAX_URLS} URLs {invalidCount ? `· ${invalidCount} invalid` : ''}</span></div><div className="path-list" aria-label="Selected page paths">{paths.map((path) => <button className="path-chip" type="button" key={path} onClick={() => removePath(path)}>{path}<X aria-hidden="true" /></button>)}</div><div className="actions-row"><div className="import-action"><input ref={fileInputRef} type="file" accept=".txt,.csv,.json" onChange={importFile} hidden /><button className="outline-button" type="button" onClick={() => fileInputRef.current?.click()}><FileUp aria-hidden="true" /> Import File</button><span>.txt, .csv, .json</span></div><div className="path-control"><span>+</span><input value={customPath} onChange={(event) => setCustomPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addPath(customPath) } }} placeholder="/custom-path" aria-label="Custom page path" /><button type="button" onClick={() => addPath(customPath)}>Add path</button></div></div><button className="privacy-add" type="button" onClick={addPrivacy}>{privacyAdded ? '✓ Privacy Policy URLs Added' : 'Add /policies/privacy-policy'}</button><button className="primary-button" type="button" onClick={startScan} disabled={isScanning || urlList.length > MAX_URLS || Boolean(invalidCount)}><Mail aria-hidden="true" />{isScanning ? `${phase} · ${progress}%` : 'Extract & Verify Emails'}</button>{(isScanning || progress > 0) && <div className="progress-wrap"><div className="progress-track"><div className="progress-bar" style={{ width: `${progress}%` }} /></div>{isScanning && <button className="text-button" type="button" onClick={() => { const next = !pauseRef.current; pauseRef.current = next; setIsPaused(next) }}>{isPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}{isPaused ? 'Resume scan' : 'Pause scan'}</button>}</div>}{notice && <p className="notice" role="status">{notice}</p>}{!results.length && !failures.length && !isScanning && <div className="result-empty"><div className="empty-icon"><Mail aria-hidden="true" /></div><div><strong>No results yet</strong><p>Results will appear here after you run an extraction.</p></div><button className="icon-button" type="button" onClick={reset} aria-label="Reset extractor"><RotateCcw aria-hidden="true" /></button></div>}</section><div className="important-banner"><AlertTriangle aria-hidden="true" /><span><strong>Important:</strong> Only use this tool on websites you own or have explicit permission to scan.</span></div>{(results.length > 0 || failures.length > 0 || progress === 100) && <Results results={uniqueResults} filtered={filteredResults} counts={counts} failures={failures} duplicates={duplicatesRemoved} urls={urlList.length} query={query} setQuery={setQuery} segment={segment} setSegment={setSegment} copied={copied} copy={copy} exportData={exportData} exportFailures={exportFailures} clearResults={clearResults} />}<footer>Built with care. Please use responsibly and ethically.</footer></main>
}

function Results({ results, filtered, counts, failures, duplicates, urls, query, setQuery, segment, setSegment, copied, copy, exportData, exportFailures, clearResults }: { results: Result[]; filtered: Result[]; counts: Record<Exclude<Segment, 'All'>, number>; failures: Failure[]; duplicates: number; urls: number; query: string; setQuery: (value: string) => void; segment: Segment; setSegment: (value: Segment) => void; copied: string; copy: (items: Result[], label: string) => void; exportData: (format: 'csv' | 'json') => void; exportFailures: () => void; clearResults: () => void }) { return <section className="results-dashboard" aria-labelledby="results-heading"><div className="results-head"><div><p className="eyebrow">Extraction report</p><h2 id="results-heading">Results</h2></div><div className="result-actions"><button className="outline-button" type="button" onClick={() => copy(results, 'Copied all emails')} disabled={!results.length}><Clipboard aria-hidden="true" /> Copy All Emails</button><button className="outline-button" type="button" onClick={() => exportData('csv')} disabled={!results.length}><Download aria-hidden="true" /> Export CSV</button><button className="outline-button" type="button" onClick={() => exportData('json')} disabled={!results.length}><Download aria-hidden="true" /> Export JSON</button><button className="danger-button" type="button" onClick={clearResults}><Trash2 aria-hidden="true" /> Clear Results</button></div></div>{copied && <p className="copy-confirmation" role="status">{copied}</p>}<div className="stats-grid"><Stat label="URLs scanned" value={urls} /><Stat label="Emails found" value={results.length} /><Stat label="Duplicates removed" value={duplicates} /><Stat label="Failed pages" value={failures.length} /></div><div className="segment-grid">{(SEGMENTS.slice(1) as Exclude<Segment, 'All'>[]).map((name) => <div className="segment-card" key={name}><div><span className={`segment-dot ${name.toLowerCase()}`} /><h3>{name}</h3></div><strong>{counts[name]}</strong><p>matching emails</p><button className="outline-button" type="button" onClick={() => download(`focus-extractor-${name.toLowerCase()}.csv`, csvRows(results.filter((item) => classify(item.email) === name)), 'text/csv')} disabled={!counts[name]}><FileDown aria-hidden="true" /> Download {name}</button></div>)}</div><div className="filter-row"><label className="search-control"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email or source" aria-label="Search results" /></label><div className="segment-tabs">{SEGMENTS.map((name) => <button className={segment === name ? 'active' : ''} type="button" key={name} onClick={() => setSegment(name)}>{name}{name !== 'All' ? ` (${counts[name as Exclude<Segment, 'All'>]})` : ` (${results.length})`}</button>)}</div><span className="matching-count">{filtered.length} matching</span></div><div className="results-list">{filtered.length ? filtered.map((item) => <div className="result-row" key={`${item.email}-${item.source}`}><div><strong>{item.email}</strong><span>{item.source}</span></div><span className="result-segment">{classify(item.email)}</span><button className="icon-button" type="button" onClick={() => copy([item], `Copied ${item.email}`)} aria-label={`Copy ${item.email}`}><Clipboard aria-hidden="true" /></button></div>) : <div className="empty-results"><Mail aria-hidden="true" /><strong>No matching results</strong><p>Try another search or segment.</p></div>}</div>{failures.length > 0 && <div className="failures-panel"><div className="section-heading"><div className="lime-icon"><AlertTriangle aria-hidden="true" /></div><div><h2>Failed pages</h2><p>Pages that could not be reached or parsed.</p></div><div className="result-actions"><button className="outline-button" type="button" onClick={exportFailures}><Download aria-hidden="true" /> Export failures</button></div></div><div className="failure-list">{failures.map((failure) => <div className="failure-row" key={`${failure.url}-${failure.reason}`}><strong>{failure.url}</strong><span>{failure.reason}</span><span>{failure.httpStatus || '—'}</span></div>)}</div></div>}</section> }
function Stat({ label, value }: { label: string; value: number }) { return <div className="stat-card"><span>{label}</span><strong>{value.toLocaleString()}</strong></div> }
