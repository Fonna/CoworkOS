// Normalize category caches that pptxtojson 2.2 does not yet read.
// PptxGenJS writes multiLvlStrRef even for ordinary, single-level labels.
import JSZip from 'jszip'
export async function preparePptx(input: ArrayBuffer): Promise<ArrayBuffer> {
  if (input.byteLength > 32 * 1024 * 1024) throw new Error('PPTX 文件超过 32 MiB')
  const zip = await JSZip.loadAsync(input)
  let changed = false
  // Older exports passed CSS-quoted font names straight to PptxGenJS, creating
  // typeface=""Font Name"". Repair only that known attribute form in memory;
  // otherwise the tolerant upstream parser silently truncates table cells.
  for (const [path, file] of Object.entries(zip.files)) {
    if (!path.startsWith('ppt/') || !path.endsWith('.xml')) continue
    const text = await file.async('string')
    const repaired = text.replace(/(<a:(?:latin|ea|cs|font)\b[^>]*?\btypeface=)""([^"<>]+)""(?=[\s/>])/g, '$1"$2"')
    if (repaired !== text) { zip.file(path, repaired); changed = true }
  }
  // Office stores an SVG alongside a raster fallback. The parser only reads
  // a:blip, so prefer the embedded SVG when present (the fallback can be a placeholder).
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const svg = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'
  const relation = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  for (const [path, file] of Object.entries(zip.files)) {
    if (!/^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(path)) continue
    const text = await file.async('string')
    if (!text.includes('svgBlip')) continue
    const slash = path.lastIndexOf('/')
    const relFile = zip.file(`${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`)
    if (!relFile) continue
    const relDoc = new DOMParser().parseFromString(await relFile.async('string'), 'application/xml')
    const relations = Array.from(relDoc.getElementsByTagNameNS('*', 'Relationship'))
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    let updated = false
    for (const source of Array.from(doc.getElementsByTagNameNS(svg, 'svgBlip'))) {
      const id = source.getAttributeNS(relation, 'embed')
      const entry = relations.find(item => item.getAttribute('Id') === id && item.getAttribute('TargetMode') !== 'External')
      const target = entry?.getAttribute('Target')
      if (!id || !target) continue
      const media = new URL(target, `https://pptx.invalid/${path}`)
      if (media.origin !== 'https://pptx.invalid' || !zip.file(decodeURIComponent(media.pathname.slice(1)))) continue
      let blip = source.parentElement
      while (blip && !(blip.localName === 'blip' && blip.namespaceURI === drawing)) blip = blip.parentElement
      if (blip) { blip.setAttributeNS(relation, 'r:embed', id); updated = true }
    }
    if (updated) { zip.file(path, new XMLSerializer().serializeToString(doc)); changed = true }
  }
  const ns = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
  for (const [path, file] of Object.entries(zip.files)) {
    if (!/^ppt\/charts\/chart\d+\.xml$/.test(path)) continue
    const text = await file.async('string')
    if (!text.includes('multiLvlStrRef')) continue
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    for (const source of Array.from(doc.getElementsByTagNameNS(ns, 'multiLvlStrRef'))) {
      const levels = Array.from(source.getElementsByTagNameNS(ns, 'lvl'))
      if (!levels.length) continue
      const ref = doc.createElementNS(ns, 'c:strRef'), cache = doc.createElementNS(ns, 'c:strCache')
      const formula = source.getElementsByTagNameNS(ns, 'f')[0]
      if (formula) ref.appendChild(formula.cloneNode(true))
      const count = source.getElementsByTagNameNS(ns, 'ptCount')[0]
      if (count) cache.appendChild(count.cloneNode(true))
      for (const point of Array.from(levels[0].children)) cache.appendChild(point.cloneNode(true))
      ref.appendChild(cache); source.replaceWith(ref); changed = true
    }
    zip.file(path, new XMLSerializer().serializeToString(doc))
  }
  return changed ? zip.generateAsync({type:'arraybuffer'}) : input
}

/** PptxGenJS expects one font name and interpolates it into XML attributes. */
export function pptxFontFace(value: string): string {
  const family = value.trim()
  const first = /^(["'])(.*?)\1\s*(?:,|$)/.exec(family)?.[2] ?? family.split(',')[0]
  return (first.trim() || 'Arial').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
}
