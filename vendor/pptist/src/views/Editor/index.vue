<template>
  <div class="pptist-editor">
    <div class="editor-command-bar">
      <EditorHeader class="layout-header" :thumbnails-visible="thumbnailsVisible" :properties-visible="propertiesVisible" @toggle-thumbnails="thumbnailsVisible = !thumbnailsVisible" @toggle-properties="propertiesVisible = !propertiesVisible">
        <CanvasTool class="canvas-tool-inline" :inert="editorLocked" />
      </EditorHeader>
    </div>
    <div class="layout-content" :inert="editorLocked" @keydown.esc="closeCompactPanels()">
      <button v-if="(compact && propertiesVisible) || (narrow && thumbnailsVisible)" class="atria-panel-dismiss" type="button" aria-label="关闭侧栏" @click="closeCompactPanels()"></button>
      <Thumbnails v-show="thumbnailsVisible" class="layout-content-left" @click="closeThumbnailDrawer($event)" />
      <div class="layout-content-center">
        <Canvas class="center-body" :style="{ height: `calc(100% - ${remarkHeight}px)` }" />
        <Remark
          class="center-bottom" 
          v-model:height="remarkHeight" 
          :style="{ height: `${remarkHeight}px` }"
        />
      </div>
      <Toolbar v-show="propertiesVisible" class="layout-content-right" />
    </div>
  </div>

  <SelectPanel :inert="editorLocked" v-if="showSelectPanel" />
  <SearchPanel :inert="editorLocked" v-if="showSearchPanel" />
  <NotesPanel :inert="editorLocked" v-if="showNotesPanel" />
  <MarkupPanel :inert="editorLocked" v-if="showMarkupPanel" />
  <SymbolPanel :inert="editorLocked" v-if="showSymbolPanel" />
  <ChartDataEditorDialog />
  <LatexEditorDialog />

  <Modal
    :visible="!!dialogForExport" 
    :width="680"
    @closed="closeExportDialog()"
  >
    <ExportDialog />
  </Modal>

</template>

<script lang="ts" setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore } from '@/store'
import useGlobalHotkey from '@/hooks/useGlobalHotkey'
import usePasteEvent from '@/hooks/usePasteEvent'
import { editorLocked } from '@/atria/bridge'

import EditorHeader from './EditorHeader/index.vue'
import Canvas from './Canvas/index.vue'
import CanvasTool from './CanvasTool/index.vue'
import Thumbnails from './Thumbnails/index.vue'
import Toolbar from './Toolbar/index.vue'
import Remark from './Remark/index.vue'
import ChartDataEditorDialog from './ChartDataEditorDialog.vue'
import LatexEditorDialog from './LatexEditorDialog.vue'
import ExportDialog from './ExportDialog/index.vue'
import SelectPanel from './SelectPanel.vue'
import SearchPanel from './SearchPanel.vue'
import NotesPanel from './NotesPanel.vue'
import SymbolPanel from './SymbolPanel.vue'
import MarkupPanel from './MarkupPanel.vue'
import Modal from '@/components/Modal.vue'

const mainStore = useMainStore()
const {
  dialogForExport,
  showSelectPanel,
  showSearchPanel,
  showNotesPanel,
  showSymbolPanel,
  showMarkupPanel,
} = storeToRefs(mainStore)

const closeExportDialog = () => mainStore.setDialogForExport('')

const remarkHeight = ref(40)
const compactQuery = matchMedia('(max-width: 1050px)')
const narrowQuery = matchMedia('(max-width: 760px)')
const compact = ref(compactQuery.matches), narrow = ref(narrowQuery.matches)
const thumbnailsVisible = ref(!narrow.value), propertiesVisible = ref(!compact.value)
const adaptPanels = () => {
  if (compact.value !== compactQuery.matches) propertiesVisible.value = !compactQuery.matches
  if (narrow.value !== narrowQuery.matches) thumbnailsVisible.value = !narrowQuery.matches
  compact.value = compactQuery.matches
  narrow.value = narrowQuery.matches
}
const closeCompactPanels = () => {
  if (compact.value) propertiesVisible.value = false
  if (narrow.value) thumbnailsVisible.value = false
}
const closeThumbnailDrawer = (event: MouseEvent) => {
  if (narrow.value && (event.target as HTMLElement).closest('.thumbnail-item')) thumbnailsVisible.value = false
}
onMounted(() => {
  compactQuery.addEventListener('change', adaptPanels)
  narrowQuery.addEventListener('change', adaptPanels)
})
onUnmounted(() => {
  compactQuery.removeEventListener('change', adaptPanels)
  narrowQuery.removeEventListener('change', adaptPanels)
})

useGlobalHotkey()
usePasteEvent()
</script>

<style lang="scss" scoped>
.pptist-editor {
  height: 100%;
}
.layout-header {
  height: 100%;
}
.layout-content {
  position: relative;
  height: calc(100% - var(--atria-tools-height));
  display: flex;
}
.editor-command-bar {
  display: flex;
  align-items: center;
  width: 100%;
  height: var(--atria-tools-height);
  min-width: 0;
}
.layout-content-left {
  width: 160px;
  height: 100%;
  flex-shrink: 0;
}
.layout-content-center {
  flex: 1;
  min-width: 0;
}
.layout-content-right {
  width: 260px;
  height: 100%;
}
.atria-panel-dismiss {
  position: absolute;
  inset: 0;
  z-index: 8;
  border: 0;
  background: rgba(0, 0, 0, .12);
  cursor: pointer;
}
</style>
