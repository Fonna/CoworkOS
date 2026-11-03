// CoworkOS modifications to PPTist, licensed under AGPL-3.0.
import { nextTick, reactive, ref, watch } from 'vue'
import { useSlidesStore, useMainStore, useSnapshotStore } from '@/store'
import useImport from '@/hooks/useImport'
import { db } from '@/utils/database'
import type { Slide, SlideTheme } from '@/types/slides'
const channel = new URLSearchParams(location.hash.slice(1)).get('channel')
export const embedded = parent !== window && !!channel
export const editorLocked = ref(false)
export const hostState = reactive({ title: '演示文稿', disabled: true, saveLabel: '保存', saveTitle: '保存到 CoworkOS 工作区', status: '', statusState: 'saved' })
export type HostCommand = 'new' | 'rename' | 'review' | 'undo-save' | 'export' | 'save' | 'save-copy'
export const hostCommand = (command: HostCommand) => { if (!hostState.disabled) send('host-command', { command }) }
export const send = (type: string, payload: Record<string, unknown> = {}) => {
  if (parent !== window && channel) parent.postMessage({ protocol: 'atria-pptist-v1', channel, type, ...payload }, location.origin)
}
export function connect() {
  const slides = useSlidesStore(), main = useMainStore(), history = useSnapshotStore()
  const { importPPTXFile } = useImport()
  let applying = false, queued = false, loaded = false, locked = false
  const document = () => JSON.parse(JSON.stringify({ version: 1, viewportSize: slides.viewportSize, viewportRatio: slides.viewportRatio, theme: slides.theme, slides: slides.slides }))
  const selection = () => ({ slideId: slides.slides[slides.slideIndex]?.id, elementIds: [...main.activeElementIdList] })
  watch(() => [slides.slides, slides.theme, slides.viewportSize, slides.viewportRatio], () => {
    if (applying || !loaded || queued) return
    queued = true
    queueMicrotask(() => { queued = false; if (!applying && loaded) send('change', { document: document() }) })
  }, { deep: true, flush: 'sync' })
  watch(() => [slides.slideIndex, main.activeElementIdList], () => {
    if (!applying && loaded) send('selection', { selection: selection() })
  }, { deep: true })
  const receive = async (event: MessageEvent) => {
    const message = event.data
    if (event.source !== parent || event.origin !== location.origin || message?.protocol !== 'atria-pptist-v1' || message.channel !== channel) return
    try {
      if (message.type === 'load') {
        applying = true
        globalThis.document.body.inert = true
        const doc = message.document, oldId = slides.slides[slides.slideIndex]?.id
        const preserveHistory = loaded && message.preserveHistory === true
        if (!preserveHistory) main.setActiveElementIdList([])
        slides.$patch({ title: String(message.title || '演示文稿'), slides: doc.slides as Slide[], theme: doc.theme as SlideTheme, viewportSize: doc.viewportSize, viewportRatio: doc.viewportRatio, slideIndex: Math.max(0, doc.slides.findIndex((s: Slide) => s.id === (message.slideId || oldId))) })
        if (!preserveHistory) { await db.snapshots.clear(); await history.initSnapshotDatabase() }
        await nextTick()
        loaded = true
        send('loaded', { requestId: message.requestId, selection: selection() })
      }
      if (message.type === 'import-file') {
        const ok = await importPPTXFile([new File([message.body], message.name || 'presentation.pptx')], { cover: true })
        if (!ok) throw new Error('无法解析 PPTX 文件，请确认文件未损坏且未加密')
        send('imported', { document: document() })
      }
      if (message.type === 'export') main.setDialogForExport('pptx')
      if (message.type === 'appearance' && (message.theme === 'light' || message.theme === 'dark')) {
        globalThis.document.documentElement.dataset.theme = message.theme
        globalThis.document.documentElement.style.colorScheme = message.theme
      }
      if (message.type === 'snapshot') send('snapshot', { requestId: message.requestId, document: document(), selection: selection() })
      if (message.type === 'title') slides.setTitle(message.title)
      if (message.type === 'host-state') {
        if (typeof message.title === 'string') hostState.title = message.title.slice(0, 1000)
        if (typeof message.disabled === 'boolean') hostState.disabled = message.disabled
        if (typeof message.saveLabel === 'string') hostState.saveLabel = message.saveLabel.slice(0, 40)
        if (typeof message.saveTitle === 'string') hostState.saveTitle = message.saveTitle.slice(0, 2000)
        if (typeof message.status === 'string') hostState.status = message.status.slice(0, 2000)
        if (['saved', 'dirty', 'error'].includes(message.statusState)) hostState.statusState = message.statusState
      }
      if (message.type === 'locked') {
        locked = !!message.locked
        editorLocked.value = locked
        globalThis.document.body.inert = applying
        if (locked) { main.setEditorareaFocus(false); main.setThumbnailsFocus(false) }
      }
    } catch (error) { send('error', { requestId: message.requestId, message: String(error) }) }
    finally { if (message.type === 'load') { applying = false; globalThis.document.body.inert = false } }
  }
  const exitFullscreen = () => send('exit-fullscreen')
  window.addEventListener('atria-exit-fullscreen', exitFullscreen)
  window.addEventListener('message', receive)
  const saveKey = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopImmediatePropagation(); send('save')
      return
    }
    if (locked && !(event.target as Element)?.closest?.('.atria-pptist-header, .document-menu, .screening-menu')) {
      // Keep native focus navigation available while stopping document-editing
      // shortcuts from reaching the canvas behind a retained recovery draft.
      event.stopImmediatePropagation()
    }
  }
  window.addEventListener('keydown', saveKey, true)
  send('ready', { capabilities: ['host-commands-v1'] })
  return () => { window.removeEventListener('message', receive); window.removeEventListener('keydown', saveKey, true); window.removeEventListener('atria-exit-fullscreen', exitFullscreen); db.close(); void db.delete() }
}
