<template>
  <div class="canvas-tool">
    <div class="history-actions">
      <button type="button" class="tool-button icon-button" :disabled="!canUndo" title="撤销（Ctrl + Z）" aria-label="撤销（Ctrl + Z）" @click="undo()"><i-icon-park-outline:back /></button>
      <button type="button" class="tool-button icon-button" :disabled="!canRedo" title="重做（Ctrl + Y）" aria-label="重做（Ctrl + Y）" @click="redo()"><i-icon-park-outline:next /></button>
    </div>
    <Popover trigger="click" v-model:value="insertVisible" @show="openInsert()">
      <template #content>
        <div class="insert-menu" :inert="editorLocked" ref="insertPanel" @keydown.esc.stop.prevent="closeInsert()" @keydown.stop="panelKey($event, insertPanel)">
          <template v-if="!insertView">
            <div class="insert-grid">
              <button type="button" aria-label="插入文字" @click="drawText()"><i-icon-park-outline:font-size />文字</button>
              <button type="button" aria-label="插入竖排文字" @click="drawText(true)"><i-icon-park-outline:text-rotation-down />竖排文字</button>
              <button type="button" aria-label="插入形状" @click="chooseInsert('shape')"><i-icon-park-outline:graphic-design />形状</button>
              <FileInput @change="insertImageElement"><button type="button" aria-label="插入图片"><i-icon-park-outline:picture />图片</button></FileInput>
              <button type="button" aria-label="插入线条" @click="chooseInsert('line')"><i-icon-park-outline:connection />线条</button>
              <button type="button" aria-label="插入图表" @click="chooseInsert('chart')"><i-icon-park-outline:chart-proportion />图表</button>
              <button type="button" aria-label="插入表格" @click="chooseInsert('table')"><i-icon-park-outline:insert-table />表格</button>
              <button type="button" aria-label="插入公式" @click="closeInsert(); latexEditorVisible = true"><i-icon-park-outline:formula />公式</button>
              <button type="button" aria-label="插入音视频" @click="chooseInsert('media')"><i-icon-park-outline:video-two />音视频</button>
              <button type="button" aria-label="插入符号" @click="closeInsert(); toggleSymbolPanel()"><i-icon-park-outline:symbol />符号</button>
            </div>
          </template>
          <template v-else>
            <button class="back-button" type="button" aria-label="返回插入菜单" @click="insertView = ''"><i-icon-park-outline:left />返回</button>
            <template v-if="insertView === 'shape'">
              <ShapePool @select="shape => drawShape(shape)" />
              <div class="shape-actions">
                <button type="button" @click="closeInsert(); svgPathEditorVisible = true">路径绘制</button>
                <button type="button" @click="drawCustomShape()">自由绘制</button>
              </div>
            </template>
            <LinePool v-if="insertView === 'line'" @select="line => drawLine(line)" />
            <ChartPool v-if="insertView === 'chart'" @select="chart => { createChartElement(chart); closeInsert() }" />
            <TableGenerator v-if="insertView === 'table'" @close="closeInsert()" @insert="({ row, col }) => { createTableElement(row, col); closeInsert() }" />
            <MediaInput v-if="insertView === 'media'" @close="closeInsert()" @insertVideo="({ src, ext }) => { createVideoElement(src, ext); closeInsert() }" @insertAudio="({ src, ext }) => { createAudioElement(src, ext); closeInsert() }" />
          </template>
        </div>
      </template>
      <button class="tool-button insert-button" ref="insertTrigger" type="button" aria-label="插入" aria-haspopup="true" :aria-expanded="insertVisible"><i-icon-park-outline:plus /><span>插入</span></button>
    </Popover>
    <Popover trigger="click" v-model:value="moreVisible" @show="nextTick(() => focusPanel(morePanel))">
      <template #content>
        <div class="tools-menu" :inert="editorLocked" ref="morePanel" @keydown.esc.stop.prevent="closeMore()" @keydown.stop="panelKey($event, morePanel)">
          <button type="button" :disabled="!canUndo" @click="toolAction(undo)"><i-icon-park-outline:back />撤销<span>Ctrl Z</span></button>
          <button type="button" :disabled="!canRedo" @click="toolAction(redo)"><i-icon-park-outline:next />重做<span>⇧ Ctrl Z</span></button>
          <button type="button" :aria-pressed="showNotesPanel" @click="toolAction(toggleNotesPanel)"><i-icon-park-outline:comment />批注面板</button>
          <button type="button" :aria-pressed="showSelectPanel" @click="toolAction(toggleSelectPanel)"><i-icon-park-outline:move-one />选择窗格</button>
          <button type="button" :aria-pressed="showSearchPanel" @click="toolAction(toggleSraechPanel)"><i-icon-park-outline:search />查找替换</button>
          <div class="menu-zoom">
            <button type="button" aria-label="画布缩小（Ctrl + -）" @click="scaleCanvas('-')"><i-icon-park-outline:minus /></button>
            <span>{{ canvasScalePercentage }}</span>
            <button type="button" aria-label="画布放大（Ctrl + =）" @click="scaleCanvas('+')"><i-icon-park-outline:plus /></button>
            <button type="button" aria-label="适应屏幕（Ctrl + 0）" @click="resetCanvas()">适应</button>
          </div>
          <div class="zoom-presets"><button v-for="item in canvasScalePresetList" type="button" :key="item" @click="applyCanvasPresetScale(item)">{{ item }}%</button></div>
        </div>
      </template>
      <button class="tool-button icon-button" ref="moreTrigger" type="button" aria-label="更多工具" title="更多工具" aria-haspopup="true" :aria-expanded="moreVisible"><i-icon-park-outline:more /></button>
    </Popover>
    <Popover class="zoom-shortcut" trigger="click" v-model:value="canvasScaleVisible" @show="nextTick(() => focusPanel(scalePanel))">
      <template #content>
        <div class="tools-menu" :inert="editorLocked" ref="scalePanel" @keydown.esc.stop.prevent="canvasScaleVisible = false; scaleTrigger?.focus()" @keydown.stop="panelKey($event, scalePanel)">
          <button v-for="item in canvasScalePresetList" type="button" :key="item" @click="applyCanvasPresetScale(item)">{{ item }}%</button>
          <button type="button" @click="resetCanvas(); canvasScaleVisible = false">适应屏幕</button>
        </div>
      </template>
      <button class="tool-button" ref="scaleTrigger" type="button" aria-label="缩放" aria-haspopup="true" :aria-expanded="canvasScaleVisible">{{ canvasScalePercentage }}<i-icon-park-outline:down /></button>
    </Popover>
    <Modal v-model:visible="latexEditorVisible" :width="880"><LaTeXEditor @close="latexEditorVisible = false" @update="data => { createLatexElement(data); latexEditorVisible = false }" /></Modal>
    <Modal v-model:visible="svgPathEditorVisible" :width="800"><SVGPathEditor @close="svgPathEditorVisible = false" @insert="path => insertSvgPath(path)" /></Modal>
  </div>
</template>

<script lang="ts" setup>
import { nextTick, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore, useSlidesStore, useSnapshotStore } from '@/store'
import { getImageDataURL } from '@/utils/image'
import type { ShapePoolItem } from '@/configs/shapes'
import type { LinePoolItem } from '@/configs/lines'
import type { PPTShapeElement } from '@/types/slides'
import useScaleCanvas from '@/hooks/useScaleCanvas'
import useHistorySnapshot from '@/hooks/useHistorySnapshot'
import useCreateElement from '@/hooks/useCreateElement'
import { editorLocked } from '@/atria/bridge'

import ShapePool from './ShapePool.vue'
import LinePool from './LinePool.vue'
import ChartPool from './ChartPool.vue'
import TableGenerator from './TableGenerator.vue'
import MediaInput from './MediaInput.vue'
import SVGPathEditor from './SVGPathEditor.vue'
import LaTeXEditor from '@/components/LaTeXEditor/index.vue'
import FileInput from '@/components/FileInput.vue'
import Modal from '@/components/Modal.vue'
import Popover from '@/components/Popover.vue'

const mainStore = useMainStore()
const slidesStore = useSlidesStore()
const { showSelectPanel, showSearchPanel, showNotesPanel, showSymbolPanel } = storeToRefs(mainStore)
const { canUndo, canRedo } = storeToRefs(useSnapshotStore())
const { theme, viewportRatio, viewportSize } = storeToRefs(slidesStore)

const { redo, undo } = useHistorySnapshot()

const {
  scaleCanvas,
  setCanvasScalePercentage,
  resetCanvas,
  canvasScalePercentage,
} = useScaleCanvas()

const canvasScalePresetList = [200, 150, 125, 100, 75, 50]
const canvasScaleVisible = ref(false)

const applyCanvasPresetScale = (value: number) => {
  setCanvasScalePercentage(value)
  canvasScaleVisible.value = false
}

const {
  createImageElement,
  createChartElement,
  createTableElement,
  createLatexElement,
  createVideoElement,
  createAudioElement,
  createShapeElement,
} = useCreateElement()

const insertImageElement = (files: FileList) => {
  closeInsert()
  const imageFile = files[0]
  if (!imageFile) return
  getImageDataURL(imageFile).then(dataURL => createImageElement(dataURL))
}

const latexEditorVisible = ref(false)
const svgPathEditorVisible = ref(false)
const insertVisible = ref(false), moreVisible = ref(false)
const insertView = ref('')
const insertPanel = ref<HTMLElement>(), insertTrigger = ref<HTMLButtonElement>()
const morePanel = ref<HTMLElement>(), moreTrigger = ref<HTMLButtonElement>()
const scaleTrigger = ref<HTMLButtonElement>(), scalePanel = ref<HTMLElement>()
const focusPanel = (panel: HTMLElement | undefined) => nextTick(() => panel?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
const openInsert = () => { insertView.value = ''; nextTick(() => focusPanel(insertPanel.value)) }
const closeInsert = () => { insertVisible.value = false; insertTrigger.value?.focus() }
const closeMore = () => { moreVisible.value = false; moreTrigger.value?.focus() }
const chooseInsert = (view: string) => { insertView.value = view; nextTick(() => focusPanel(insertPanel.value)) }
const panelKey = (event: KeyboardEvent, panel?: HTMLElement) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...(panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])].filter(item => item.getClientRects().length)
  if (!items.length) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
  items[target].focus()
}
const toolAction = (action: () => void) => { closeMore(); action() }

// 绘制文字范围
const drawText = (vertical = false) => {
  closeInsert()
  mainStore.setCreatingElement({
    type: 'text',
    vertical,
  })
}

// 绘制形状范围
const drawShape = (shape: ShapePoolItem) => {
  mainStore.setCreatingElement({
    type: 'shape',
    data: shape,
  })
  closeInsert()
}
// 绘制自定义任意多边形
const drawCustomShape = () => {
  mainStore.setCreatingCustomShapeState(true)
  closeInsert()
}
// 根据路径插入形状
const insertSvgPath = (path: string) => {
  const width = 400
  const height = 400
  const isClosedPath = /z\s*$/i.test(path)
  const position = {
    width,
    height,
    left: (viewportSize.value - width) / 2,
    top: (viewportSize.value * viewportRatio.value - height) / 2,
  }
  const supplement: Partial<PPTShapeElement> = isClosedPath
    ? { fill: theme.value.themeColors[0] }
    : {
      fill: 'rgba(0, 0, 0, 0)',
      outline: {
        width: 2,
        color: theme.value.themeColors[0],
        style: 'solid',
      },
    }

  createShapeElement(position, {
    path,
    viewBox: [width, height],
  }, supplement)
  svgPathEditorVisible.value = false
}

// 绘制线条路径
const drawLine = (line: LinePoolItem) => {
  mainStore.setCreatingElement({
    type: 'line',
    data: line,
  })
  closeInsert()
}

// 打开选择面板
const toggleSelectPanel = () => {
  mainStore.setSelectPanelState(!showSelectPanel.value)
}

// 打开搜索替换面板
const toggleSraechPanel = () => {
  mainStore.setSearchPanelState(!showSearchPanel.value)
}

// 打开批注面板
const toggleNotesPanel = () => {
  mainStore.setNotesPanelState(!showNotesPanel.value)
}

// 打开符号面板
const toggleSymbolPanel = () => {
  mainStore.setSymbolPanelState(!showSymbolPanel.value)
}

// 图库搜索由 CoworkOS 对话提供。
</script>


<style lang="scss" scoped>
.canvas-tool { display:flex; align-items:center; gap:3px; min-width:0; color:var(--atria-text); font-size:12px; }
.history-actions { display:flex; gap:2px; }
.tool-button { height:30px; display:inline-flex; align-items:center; justify-content:center; gap:5px; padding:0 8px; border:0; border-radius:8px; color:inherit; background:transparent; font:inherit; white-space:nowrap; cursor:pointer; }
.tool-button:hover, .tool-button[aria-expanded='true'] { background:var(--atria-hover); }
.tool-button:disabled { opacity:.35; cursor:default; }
.tool-button svg { font-size:16px; }
.icon-button { width:30px; padding:0; }
.zoom-shortcut { margin-left:auto; }
.zoom-shortcut svg { font-size:10px; }
.insert-menu { min-width:244px; max-width:calc(100vw - 42px); }
.insert-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:3px; }
.insert-grid button, .tools-menu > button, .shape-actions button, .back-button { width:100%; min-height:34px; display:flex; align-items:center; gap:10px; padding:7px 9px; border:0; border-radius:6px; color:var(--atria-text); background:transparent; font:inherit; text-align:left; cursor:pointer; }
.insert-grid button:hover, .tools-menu button:hover, .shape-actions button:hover, .back-button:hover { background:var(--atria-hover); }
.insert-grid svg, .tools-menu > button svg { font-size:18px; color:var(--atria-muted); }
.back-button { width:auto; min-height:28px; margin:0 0 12px; padding:4px; font-size:12px; color:var(--atria-muted); }
.shape-actions { display:flex; gap:4px; margin-top:8px; }
.shape-actions button { justify-content:center; }
.tools-menu { width:220px; max-width:calc(100vw - 42px); }
.tools-menu > button:disabled { opacity:.35; cursor:default; }
.tools-menu > button span { margin-left:auto; color:var(--atria-muted); font-size:11px; }
.menu-zoom { display:flex; align-items:center; justify-content:space-between; padding:7px 0 2px; }
.menu-zoom button, .zoom-presets button { min-height:30px; border:0; border-radius:6px; background:transparent; color:var(--atria-text); font:inherit; cursor:pointer; }
.menu-zoom button { min-width:34px; }
.menu-zoom span { min-width:46px; text-align:center; }
.zoom-presets { display:grid; grid-template-columns:repeat(3,1fr); gap:2px; padding-top:4px; }
@media (max-width:760px) { .zoom-shortcut { display:none; } }
@media (max-width:520px) { .history-actions { display:none; } .canvas-tool { gap:1px; } .insert-button { gap:3px; padding:0 6px; } .icon-button { width:28px; } }
</style>
