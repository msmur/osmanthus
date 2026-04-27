/**
 * Epub parser.
 *
 * An epub is a ZIP archive. We:
 *  1. Unzip it with JSZip
 *  2. Read META-INF/container.xml to find the OPF (package) file
 *  3. Parse the OPF for metadata, manifest, and spine (reading order)
 *  4. Walk the spine, extract text from each HTML chapter
 *  5. Optionally extract cover art as a base64 data URL
 */

import JSZip from 'jszip'
import { tokenise } from './rsvp'
import type { TocEntry } from '../types'

interface ManifestItem {
  href: string
  mediaType: string
  properties: string
}

export interface EpubMeta {
  title: string
  author: string
  coverDataUrl?: string
  words: string[]
  toc: TocEntry[]
  paragraphBreaks: number[]
}

// ─── DOM helpers ────────────────────────────────────────────────────────────

function parseXml(src: string): Document {
  return new DOMParser().parseFromString(src, 'application/xml')
}

function parseHtml(src: string): Document {
  return new DOMParser().parseFromString(src, 'text/html')
}

function allByLocalName(parent: Element | Document, localName: string): Element[] {
  const root = ('documentElement' in parent
    ? (parent as Document).documentElement
    : parent) as Element
  const results: Element[] = []
  function walk(el: Element) {
    if (el.localName === localName) results.push(el)
    for (const child of Array.from(el.children)) walk(child)
  }
  walk(root)
  return results
}

// ─── Cover extraction ────────────────────────────────────────────────────────

async function extractCover(
  zip: JSZip,
  opfDir: string,
  manifest: Map<string, ManifestItem>,
  opfDoc: Document,
): Promise<string | undefined> {
  // Method 1: <meta name="cover" content="cover-id" />
  const coverMeta = allByLocalName(opfDoc, 'meta').find(
    (m) => m.getAttribute('name') === 'cover',
  )
  const coverId = coverMeta?.getAttribute('content')
  if (coverId) {
    const item = manifest.get(coverId)
    if (item) {
      const file = zip.file(opfDir + item.href) ?? zip.file(item.href)
      if (file) {
        const b64 = await file.async('base64')
        const mime = item.mediaType.startsWith('image/') ? item.mediaType : 'image/jpeg'
        return `data:${mime};base64,${b64}`
      }
    }
  }

  // Method 2: manifest item with id or href containing "cover"
  for (const [id, item] of manifest) {
    if (
      /cover/i.test(id) &&
      item.mediaType.startsWith('image/')
    ) {
      const file = zip.file(opfDir + item.href) ?? zip.file(item.href)
      if (file) {
        const b64 = await file.async('base64')
        return `data:${item.mediaType};base64,${b64}`
      }
    }
  }

  // Method 3: properties="cover-image" (epub3)
  for (const item of manifest.values()) {
    if (item.mediaType.startsWith('image/') && /cover/i.test(item.href)) {
      const file = zip.file(opfDir + item.href) ?? zip.file(item.href)
      if (file) {
        const b64 = await file.async('base64')
        return `data:${item.mediaType};base64,${b64}`
      }
    }
  }

  return undefined
}

// ─── Text extraction ─────────────────────────────────────────────────────────

// Returns an array of paragraph strings, preserving structure for pause detection.
function extractText(doc: Document): string[] {
  const remove = ['script', 'style', 'nav', 'aside', 'figure', 'figcaption', 'sup', 'sub']
  remove.forEach((tag) => {
    doc.querySelectorAll(tag).forEach((el) => el.remove())
  })
  const body = doc.body ?? doc.documentElement
  const blocks = Array.from(
    body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote'),
  )
  if (blocks.length > 0) {
    return blocks.map((el) => el.textContent?.trim() ?? '').filter((t) => t.length > 0)
  }
  // Fallback for bare-text chapters
  return [body.textContent?.trim() ?? ''].filter((t) => t.length > 0)
}

// ─── TOC parsing ─────────────────────────────────────────────────────────────

async function parseToc(
  zip: JSZip,
  opfDir: string,
  manifest: Map<string, ManifestItem>,
  ncxId: string,
  chapterWordMap: Map<string, number>,
): Promise<TocEntry[]> {
  // Resolve a TOC href (possibly with a fragment) to a word index.
  // Falls back to basename matching so paths like "Text/ch01.xhtml" match "ch01.xhtml".
  function resolve(tocHref: string): number | undefined {
    const bare = tocHref.split('#')[0]
    if (chapterWordMap.has(bare)) return chapterWordMap.get(bare)
    const base = bare.split('/').pop() ?? bare
    for (const [key, wi] of chapterWordMap) {
      if ((key.split('/').pop() ?? key) === base) return wi
    }
    return undefined
  }

  // Epub3: manifest item with properties containing "nav"
  for (const item of manifest.values()) {
    if (!item.properties.includes('nav')) continue
    const navFile = zip.file(opfDir + item.href) ?? zip.file(item.href)
    if (!navFile) continue
    const navDoc = parseHtml(await navFile.async('text'))
    const navEls = Array.from(navDoc.querySelectorAll('nav'))
    const tocNav =
      navEls.find((n) => n.getAttribute('epub:type') === 'toc' || n.id === 'toc') ??
      navEls[0]
    if (!tocNav) continue
    const entries: TocEntry[] = []
    for (const a of Array.from(tocNav.querySelectorAll('a'))) {
      const title = a.textContent?.trim() ?? ''
      const href = a.getAttribute('href') ?? ''
      if (!title || !href) continue
      const wordIndex = resolve(href)
      if (wordIndex === undefined) continue
      entries.push({ title, wordIndex })
    }
    if (entries.length > 0) return entries
  }

  // Epub2: NCX file referenced from <spine toc="..."> or by media-type
  const ncxItem =
    manifest.get(ncxId) ??
    [...manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml')
  if (ncxItem) {
    const ncxFile = zip.file(opfDir + ncxItem.href) ?? zip.file(ncxItem.href)
    if (ncxFile) {
      const ncxDoc = parseXml(await ncxFile.async('text'))
      const navPoints = allByLocalName(ncxDoc, 'navPoint')
      const entries: TocEntry[] = []
      const seen = new Set<number>()
      for (const np of navPoints) {
        const title = allByLocalName(np, 'text')[0]?.textContent?.trim() ?? ''
        const src = allByLocalName(np, 'content')[0]?.getAttribute('src') ?? ''
        if (!title || !src) continue
        const wordIndex = resolve(src)
        if (wordIndex === undefined || seen.has(wordIndex)) continue
        seen.add(wordIndex)
        entries.push({ title, wordIndex })
      }
      if (entries.length > 0) return entries.sort((a, b) => a.wordIndex - b.wordIndex)
    }
  }

  return []
}

// ─── Main parser ─────────────────────────────────────────────────────────────

export async function parseEpub(arrayBuffer: ArrayBuffer): Promise<EpubMeta> {
  const zip = await JSZip.loadAsync(arrayBuffer)

  // 1. container.xml → OPF path
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('Not a valid epub: missing META-INF/container.xml')

  const containerDoc = parseXml(await containerFile.async('text'))
  const rootfileEl = allByLocalName(containerDoc, 'rootfile')[0]
  const opfPath = rootfileEl?.getAttribute('full-path')
  if (!opfPath) throw new Error('Not a valid epub: cannot find OPF path')

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  // 2. Parse OPF
  const opfFile = zip.file(opfPath)
  if (!opfFile) throw new Error(`Not a valid epub: OPF file not found at ${opfPath}`)
  const opfDoc = parseXml(await opfFile.async('text'))

  // 3. Metadata
  const titleEl = allByLocalName(opfDoc, 'title')[0]
  const creatorEl = allByLocalName(opfDoc, 'creator')[0]
  const title = titleEl?.textContent?.trim() || 'Untitled'
  const author = creatorEl?.textContent?.trim() || 'Unknown author'

  // 4. Manifest — id → { href, mediaType, properties }
  const manifest = new Map<string, ManifestItem>()
  allByLocalName(opfDoc, 'item').forEach((item) => {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    const mediaType = item.getAttribute('media-type') ?? ''
    const properties = item.getAttribute('properties') ?? ''
    if (id && href) manifest.set(id, { href, mediaType, properties })
  })

  // 5. Spine — ordered list of manifest ids; note the NCX item id for epub2 TOC
  const spineEl = allByLocalName(opfDoc, 'spine')[0]
  const ncxId = spineEl?.getAttribute('toc') ?? ''
  const spineIds: string[] = allByLocalName(opfDoc, 'itemref')
    .map((ir) => ir.getAttribute('idref') ?? '')
    .filter(Boolean)

  // 6. Cover
  const coverDataUrl = await extractCover(zip, opfDir, manifest, opfDoc)

  // 7. Walk spine: build word array + track chapter starts and paragraph break indices
  const words: string[] = []
  const paragraphBreaks: number[] = []
  const chapterWordMap = new Map<string, number>() // manifest href → word-start index

  for (const id of spineIds) {
    const item = manifest.get(id)
    if (!item) continue
    const isHtml = item.mediaType.includes('html') || /\.(x?html?|xml)$/i.test(item.href)
    if (!isHtml) continue

    chapterWordMap.set(item.href, words.length)

    const chapterFile = zip.file(opfDir + item.href) ?? zip.file(item.href)
    if (!chapterFile) continue

    const html = await chapterFile.async('text')
    const doc = parseHtml(html)
    const paragraphs = extractText(doc)

    for (const para of paragraphs) {
      const paraWords = tokenise(para)
      if (paraWords.length === 0) continue
      words.push(...paraWords)
      paragraphBreaks.push(words.length - 1) // word index of the last word in this paragraph
    }
  }

  if (words.length === 0) throw new Error('Could not extract any text from this epub.')

  // 8. Parse table of contents
  const toc = await parseToc(zip, opfDir, manifest, ncxId, chapterWordMap)

  return { title, author, coverDataUrl, words, toc, paragraphBreaks }
}
