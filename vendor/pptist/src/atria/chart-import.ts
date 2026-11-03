// pptxtojson exposes chart data but omits text/legend/label presentation.
// Recover those properties from the related OOXML parts, before conversion.
import JSZip from 'jszip'

interface ParsedElement { type: string; order?: number; elements?: ParsedElement[] }
interface ParsedSlide { elements: ParsedElement[]; layoutElements?: ParsedElement[] }
export interface ChartStyle { textColor?: string; showLegend: boolean; showLabel?: boolean }
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const chartNS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const relation = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const descendants = (node: Document | Element, ns: string, name: string) => Array.from(node.getElementsByTagNameNS(ns, name))
const child = (node: Element | undefined, name: string) => Array.from(node?.children || []).find(el => el.localName === name)

export async function readChartStyles(input: ArrayBuffer, slides: ParsedSlide[]) {
  const zip = await JSZip.loadAsync(input)
  const cache = new Map<string, Document>()
  const read = async (path: string) => {
    if (!cache.has(path)) {
      const file = zip.file(path)
      if (!file) return undefined
      cache.set(path, new DOMParser().parseFromString(await file.async('string'), 'application/xml'))
    }
    return cache.get(path)
  }
  const relationships = async (path: string) => {
    const slash = path.lastIndexOf('/')
    const doc = await read(`${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`)
    return doc ? descendants(doc, '*', 'Relationship').flatMap(el => {
      if (el.getAttribute('TargetMode') === 'External') return []
      const target = new URL(el.getAttribute('Target') || '', `https://pptx.invalid/${path}`)
      if (target.origin !== 'https://pptx.invalid') return []
      return [{ id: el.getAttribute('Id'), type: el.getAttribute('Type')?.split('/').pop(), path: decodeURIComponent(target.pathname.slice(1)) }]
    }) : []
  }
  const styles = new Map<number, ChartStyle>()
  const presentation = await read('ppt/presentation.xml')
  if (!presentation) return styles
  const slideRelations = await relationships('ppt/presentation.xml')
  const slideIds = descendants(presentation, '*', 'sldId')
  // pptxtojson 2.2 returns slides in numeric part-name order, not sldId order.
  const contentTypes = await read('[Content_Types].xml')
  const parsedPaths = contentTypes ? descendants(contentTypes, '*', 'Override')
    .filter(el => el.getAttribute('ContentType')?.endsWith('presentationml.slide+xml'))
    .map(el => (el.getAttribute('PartName') || '').replace(/^\//, ''))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1])) : []
  for (let i = 0; i < slides.length; i++) {
    const slidePath = parsedPaths[i]
    if (!slidePath) continue
    const slideRels = await relationships(slidePath)
    const layoutPath = slideRels.find(rel => rel.type === 'slideLayout')?.path
    const layoutRels = layoutPath ? await relationships(layoutPath) : []
    const masterPath = layoutRels.find(rel => rel.type === 'slideMaster')?.path
    const masterRels = masterPath ? await relationships(masterPath) : []
    const themePath = masterRels.find(rel => rel.type === 'theme')?.path
    const theme = themePath ? await read(themePath) : undefined
    const palette: Record<string, string> = {}
    const scheme = theme && descendants(theme, drawing, 'clrScheme')[0]
    for (const entry of Array.from(scheme?.children || [])) {
      const value = entry.firstElementChild
      const hex = value?.getAttribute('lastClr') || value?.getAttribute('val')
      if (hex && /^[0-9a-f]{6}$/i.test(hex)) palette[entry.localName] = hex
    }
    const aliases: Record<string, string> = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' }
    for (const part of [masterPath, layoutPath, slidePath]) {
      const doc = part ? await read(part) : undefined
      const mapping = doc && (descendants(doc, '*', 'overrideClrMapping')[0] || descendants(doc, '*', 'clrMap')[0])
      for (const attr of Array.from(mapping?.attributes || [])) aliases[attr.name] = attr.value
    }
    const textColor = (node: Element | undefined) => {
      if (!node) return undefined
      const fill = descendants(node, drawing, 'solidFill')[0]?.firstElementChild
      if (!fill) return undefined
      const value = fill.getAttribute('val') || ''
      const hex = fill.localName === 'schemeClr' ? palette[aliases[value] || value] : fill.getAttribute('lastClr') || value
      if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined
      let rgb = [0, 2, 4].map(n => parseInt(hex.slice(n, n + 2), 16))
      for (const transform of Array.from(fill.children)) {
        const amount = Number(transform.getAttribute('val')) / 100000
        if (transform.localName === 'tint') rgb = rgb.map(c => c + (255 - c) * amount)
        if (transform.localName === 'shade' || transform.localName === 'lumMod') rgb = rgb.map(c => c * amount)
        if (transform.localName === 'lumOff') rgb = rgb.map(c => c + 255 * amount)
      }
      return '#' + rgb.map(c => Math.min(255, Math.max(0, Math.round(c))).toString(16).padStart(2, '0')).join('').toUpperCase()
    }
    const decorate = async (path: string, elements: ParsedElement[]) => {
      const doc = await read(path)
      if (!doc) return
      const rels = await relationships(path)
      const refs = descendants(doc, chartNS, 'chart')
      const charts: ParsedElement[] = []
      const collect = (items: ParsedElement[]) => {
        for (const el of items) {
          if (el.type === 'chart') charts.push(el)
          if (el.elements) collect(el.elements)
        }
      }
      collect(elements)
      // Parser groups nodes by tag; its order restores the document ordering,
      // including charts nested in groups. Never pair a partial parse by index.
      charts.sort((a, b) => (a.order || 0) - (b.order || 0))
      if (refs.length !== charts.length) return
      for (let n = 0; n < refs.length; n++) {
        const part = rels.find(rel => rel.id === refs[n].getAttributeNS(relation, 'id'))?.path
        const source = part ? await read(part) : undefined
        if (!source) continue
        const space = source.documentElement
        const chart = child(space, 'chart')
        const plot = child(chart, 'plotArea')
        const axis = child(plot, 'catAx') || child(plot, 'valAx')
        const value = textColor(child(axis, 'txPr')) || textColor(child(space, 'txPr'))
        const label = descendants(source, chartNS, 'showVal')[0]
        styles.set(charts[n].order!, {
          ...(value ? { textColor: value } : {}),
          showLegend: !!child(chart, 'legend'),
          ...(label ? { showLabel: !['0', 'false'].includes(label.getAttribute('val') || '1') } : {}),
        })
      }
    }
    await decorate(slidePath, slides[i].elements)
    if (layoutPath && slides[i].layoutElements) await decorate(layoutPath, slides[i].layoutElements!)
  }
  const ordered = slideIds.map(id => {
    const path = slideRelations.find(rel => rel.id === id.getAttributeNS(relation, 'id'))?.path
    return slides[parsedPaths.indexOf(path || '')]
  })
  if (ordered.length === slides.length && ordered.every(Boolean) && new Set(ordered).size === slides.length) slides.splice(0, slides.length, ...ordered)
  return styles
}
