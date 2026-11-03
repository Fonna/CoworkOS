// CoworkOS import boundary: validate before Vue renders untrusted document content.
import DOMPurify from 'dompurify'
import type { Slide } from '@/types/slides'
export const safeRichText = (value: string): string => DOMPurify.sanitize(value, { ALLOWED_TAGS: ['p','div','span','br','strong','b','em','i','u','s','strike','sub','sup','ul','ol','li','a','blockquote','code'], ALLOWED_ATTR: ['style','href','target'] })
export const fileDataURL = (file: Blob): Promise<string> => new Promise((resolve, reject) => {
  if (file.size > 22 * 1024 * 1024) return reject(new Error('媒体文件过大，请压缩到 22 MiB 以内'))
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(new Error('无法读取媒体文件'))
  reader.readAsDataURL(file)
})
export function safeData<T>(value: T): T {
  const visit = (v: any, key = '', depth = 0): any => {
    if (depth > 30) throw new Error('文件嵌套过深')
    if (typeof v === 'string') {
      if (key === 'content' || key === 'remark') return safeRichText(v)
      if (['src','poster'].includes(key) && v && !/^(https?:\/\/|data:(image|audio|video)\/[a-z0-9.+-]+;base64,)/i.test(v)) throw new Error('媒体链接无效，请重新上传')
      if (key === 'target' && /^(javascript|data|file|vbscript):/i.test(v.trim())) throw new Error('不支持该链接协议')
      return v
    }
    if (Array.isArray(v)) return v.map(item => visit(item, key, depth + 1))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => {
      if (['__proto__','constructor','prototype'].includes(k)) throw new Error('文件包含无效字段')
      return [k, visit(item, k, depth + 1)]
    }))
    return v
  }
  return visit(value)
}
export function safeSlides(value: unknown): Slide[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new Error('文件须包含 1–200 页幻灯片')
  const slides = safeData(value) as Slide[]
  const ids = new Set()
  for (const slide of slides) {
    if (!slide || typeof slide.id !== 'string' || ids.has(slide.id) || !Array.isArray(slide.elements) || slide.elements.length > 500) throw new Error('幻灯片格式无效')
    ids.add(slide.id)
    const elIds = new Set()
    for (const el of slide.elements) {
      if (!el || !el.id || elIds.has(el.id) || !['text','shape','image','line','chart','table','latex','video','audio'].includes(el.type)) throw new Error('元素格式无效')
      elIds.add(el.id)
      if (![el.left,el.top,el.width, ...('height' in el ? [el.height] : [])].every(Number.isFinite)) throw new Error('元素坐标无效')
      if (el.type === 'text' && typeof el.content !== 'string') throw new Error('文本格式无效')
      if ((el.type === 'shape' || el.type === 'latex') && (typeof el.path !== 'string' || !Array.isArray(el.viewBox) || el.viewBox.length !== 2)) throw new Error('形状格式无效')
      if (el.type === 'chart' && (!el.data || !Array.isArray(el.data.labels) || !Array.isArray(el.data.series) || !Array.isArray(el.data.legends))) throw new Error('图表格式无效')
      if (el.type === 'table' && (!Array.isArray(el.data) || !el.data.length || !Array.isArray(el.colWidths))) throw new Error('表格格式无效')
      if (el.type === 'table') {
        for (const row of el.data) {
          if (!Array.isArray(row) || !row.length || row.some(cell => !cell || typeof cell.text !== 'string')) throw new Error('表格单元格格式无效')
          for (const cell of row) cell.text = safeRichText(cell.text)
        }
      }
    }
  }
  return slides
}
export function importDocument(raw: any) {
  const width = raw.width ?? raw.viewportSize ?? 1000
  const height = raw.height ?? width * (raw.viewportRatio ?? 0.5625)
  if (!Number.isFinite(width) || width < 100 || width > 4000 || !Number.isFinite(height) || height / width < .1 || height / width > 4) throw new Error('页面尺寸无效')
  if (new TextEncoder().encode(JSON.stringify(raw)).length > 32 * 1024 * 1024) throw new Error('文件超过 32 MiB')
  return { ...safeData(raw), width, height, slides: safeSlides(raw.slides) }
}

export async function embedBlobMedia(value: any): Promise<void> {
  if (!value || typeof value !== 'object') return
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string' && v.startsWith('blob:')) {
      const response = await fetch(v)
      value[key] = await fileDataURL(await response.blob())
      URL.revokeObjectURL(v)
    }
    else if (v && typeof v === 'object') await embedBlobMedia(v)
  }
}
