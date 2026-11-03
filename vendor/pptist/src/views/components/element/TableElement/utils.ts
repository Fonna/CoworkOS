import type { CSSProperties } from 'vue'
import type { PPTElementOutline, TableCellStyle } from '@/types/slides'
import { safeRichText } from '@/atria/import'

export const getTableRowHeight = (rowHeights: number[] | undefined, rowIndex: number, cellMinHeight: number) => {
  return Math.max(rowHeights?.[rowIndex] || cellMinHeight, cellMinHeight)
}

/**
 * 计算单元格样式
 * @param style 单元格文本样式原数据
 */
export const getCellStyle = (outline: PPTElementOutline, style?: TableCellStyle): CSSProperties => {
  return {
    backgroundColor: style?.backcolor || '',
    borderStyle: outline.style,
    borderColor: outline.color,
    borderWidth: outline.width + 'px',
  }
}

/**
 * 计算单元格文本样式
 * @param style 单元格文本样式原数据
 */
export const getTextStyle = (cellMinHeight: number, style?: TableCellStyle): CSSProperties => {
  if (!style) return {}

  const {
    bold,
    em,
    underline,
    strikethrough,
    color,
    fontsize,
    fontname,
    align,
    vAlign,
  } = style

  const vAlignMap = {
    'top': 'flex-start',
    'middle': 'center',
    'bottom': 'flex-end',
  }

  let textDecoration = `${underline ? 'underline' : ''} ${strikethrough ? 'line-through' : ''}`
  if (textDecoration === ' ') textDecoration = 'none'
  
  return {
    fontWeight: bold ? 'bold' : 'normal',
    fontStyle: em ? 'italic' : 'normal',
    textDecoration,
    color: color || '#000',
    fontSize: fontsize || '14px',
    fontFamily: fontname || '',
    justifyContent: vAlignMap[vAlign || 'top'],
    textAlign: align || 'left',
    minHeight: (cellMinHeight - 4) + 'px',
  }
}

export const formatText = (text: string) => {
  const template = document.createElement('template')
  template.innerHTML = safeRichText(text)
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  // Preserve cell whitespace without rewriting spaces inside HTML attributes.
  for (const node of nodes) {
    const formatted = document.createDocumentFragment()
    node.data.split('\n').forEach((line, index) => {
      if (index) formatted.append(document.createElement('br'))
      formatted.append(document.createTextNode(line.replace(/ /g, '\u00a0')))
    })
    node.replaceWith(formatted)
  }
  return template.innerHTML
}
