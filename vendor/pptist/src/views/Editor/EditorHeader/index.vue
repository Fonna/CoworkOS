<template>
  <div class="atria-pptist-header" @keydown.stop>
    <Popover trigger="click" v-model:value="menu" @show="focusMenu()">
      <template #content>
        <div class="document-menu" data-pptist-file-panel ref="menuPanel" @keydown.esc.stop.prevent="closeMenu()" @keydown.stop="navigateMenu($event)">
          <div v-if="embedded" class="document-title" data-pptist-title :title="hostState.title">{{ hostState.title }}</div>
          <template v-if="embedded">
            <button type="button" data-pptist-command="new" :disabled="hostState.disabled" @click="run('new')">新建演示文稿</button>
            <button type="button" @click="openFile('.pptx')">打开 PPTX…</button>
            <button type="button" @click="openFile('.json')">打开 JSON…</button>
            <button type="button" data-pptist-command="rename" :disabled="hostState.disabled" @click="run('rename')">重命名…</button>
            <button type="button" data-pptist-command="save-copy" :disabled="hostState.disabled" @click="run('save-copy')">保存副本…</button>
            <button type="button" data-pptist-command="export" :disabled="hostState.disabled" @click="run('export')">导出…</button>
            <button type="button" data-pptist-command="review" :disabled="hostState.disabled" @click="run('review')">修改对比</button>
            <button type="button" data-pptist-command="undo-save" :disabled="hostState.disabled" title="将文稿恢复为上一次保存前的版本" @click="run('undo-save')">撤销上一次保存</button>
          </template>
          <button v-else type="button" @click="main.setDialogForExport('pptx'); closeMenu()">导出…</button>
          <details class="import-slides" :inert="editorLocked">
            <summary>{{ embedded ? '插入幻灯片' : '导入幻灯片' }}</summary>
            <FileInput accept=".pptx" @change="files => { importPPTXFile(files); closeMenu() }"><button type="button">{{ embedded ? '插入 PPTX 幻灯片' : '导入 PPTX' }}</button></FileInput>
            <FileInput accept=".json" @change="files => { importJSON(files); closeMenu() }"><button type="button">{{ embedded ? '插入 JSON 幻灯片' : '导入 JSON' }}</button></FileInput>
            <FileInput accept=".pptist" @change="files => { importSpecificFile(files); closeMenu() }"><button type="button">{{ embedded ? '插入源文件幻灯片' : '导入源文件' }}</button></FileInput>
          </details>
          <a class="source-link" href="./source.tar.gz" download="atria-presentation-editor-source.tar.gz" aria-label="开源许可">编辑器源码与开源许可</a>
        </div>
      </template>
      <button class="command-button file-button" ref="menuTrigger" type="button" aria-label="文件操作" :aria-expanded="menu" aria-haspopup="true">文件<i-icon-park-outline:down /></button>
    </Popover>
    <slot></slot>
    <div class="presentation-actions">
      <div class="screening-actions">
        <button class="command-button screening-button" type="button" aria-label="从头放映" title="从头放映" @click="enterScreeningFromStart()"><i-icon-park-outline:play-one /><span>放映</span></button>
        <Popover trigger="click" v-model:value="screeningMenu" @show="focusScreeningMenu()">
          <template #content>
            <div class="screening-menu" ref="screeningPanel" @keydown.stop @keydown.esc.stop.prevent="closeScreeningMenu()">
              <button class="menu-action" type="button" @click="closeScreeningMenu(); enterScreening()">当前页放映</button>
            </div>
          </template>
          <button class="command-button screening-options" ref="screeningTrigger" type="button" aria-label="放映选项" :aria-expanded="screeningMenu" aria-haspopup="true" @keydown.esc.stop.prevent="closeScreeningMenu()"><i-icon-park-outline:down /></button>
        </Popover>
      </div>
      <button class="command-button icon-button" type="button" aria-label="幻灯片列表" title="幻灯片列表" :aria-pressed="thumbnailsVisible" @click="emit('toggle-thumbnails')"><i-icon-park-outline:slide-two /></button>
      <button class="command-button icon-button" type="button" aria-label="属性面板" title="属性面板" :aria-pressed="propertiesVisible" @click="emit('toggle-properties')"><i-icon-park-outline:setting-config /></button>
      <button v-if="embedded" class="command-button save-button" type="button" data-pptist-save :disabled="hostState.disabled" :title="[hostState.status, hostState.saveTitle].filter(Boolean).join(' · ')" @click="hostCommand('save')">{{ hostState.saveLabel }}</button>
    </div>
    <span v-if="embedded" class="sr-only" data-pptist-status :data-state="hostState.statusState" role="status" aria-live="polite">{{ hostState.status }}</span>
    <FullscreenSpin :loading="exporting" tip="正在导入…" />
  </div>
</template>
<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useMainStore } from '@/store'
import useScreening from '@/hooks/useScreening'
import useImport from '@/hooks/useImport'
import Popover from '@/components/Popover.vue'
import FileInput from '@/components/FileInput.vue'
import FullscreenSpin from '@/components/FullscreenSpin.vue'
import { editorLocked, embedded, hostCommand, hostState, send, type HostCommand } from '@/atria/bridge'
defineProps<{ thumbnailsVisible: boolean; propertiesVisible: boolean }>()
const emit = defineEmits<{ (event: 'toggle-thumbnails'): void; (event: 'toggle-properties'): void }>()
const main = useMainStore(), menu = ref(false), screeningMenu = ref(false)
const menuPanel = ref<HTMLElement>(), menuTrigger = ref<HTMLButtonElement>()
const screeningPanel = ref<HTMLElement>(), screeningTrigger = ref<HTMLButtonElement>()
const focusScreeningMenu = () => nextTick(() => screeningPanel.value?.querySelector<HTMLButtonElement>('button')?.focus())
const closeScreeningMenu = () => { screeningMenu.value = false; screeningTrigger.value?.focus() }
const focusMenu = () => nextTick(() => menuPanel.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
const closeMenu = () => { menu.value = false; menuTrigger.value?.focus() }
const run = (command: HostCommand) => { closeMenu(); hostCommand(command) }
const openFile = (accept: string) => { closeMenu(); send('open-file', { accept }) }
const navigateMenu = (event: KeyboardEvent) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...(menuPanel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a') || [])].filter(item => item.getClientRects().length)
  if (!items.length) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
  items[next].focus()
}
const { enterScreening, enterScreeningFromStart } = useScreening()
const { importSpecificFile, importPPTXFile, importJSON, exporting } = useImport()
</script>
<style scoped>
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
.atria-pptist-header { display:flex; align-items:center; gap:6px; width:100%; min-width:0; padding:0 10px; box-sizing:border-box; background:var(--atria-panel); color:var(--atria-text); font-size:12px; }
.presentation-actions, .screening-actions { display:flex; align-items:center; flex-shrink:0; gap:3px; }
.screening-actions { gap:0; }
.command-button { height:30px; display:inline-flex; align-items:center; justify-content:center; gap:5px; padding:0 8px; border:0; border-radius:8px; background:transparent; color:inherit; font:inherit; cursor:pointer; white-space:nowrap; }
.command-button:hover, .command-button[aria-pressed='true'], .command-button[aria-expanded='true'] { background:var(--atria-hover); }
.command-button:disabled { opacity:.45; cursor:default; }
.command-button svg { font-size:16px; flex-shrink:0; }
.file-button { gap:3px; }
.file-button svg, .screening-options svg { font-size:11px; }
.icon-button { width:30px; padding:0; }
.screening-options { width:18px; padding:0; }
.save-button { min-width:44px; background:var(--atria-text); color:var(--atria-panel); font-weight:500; }
.save-button:hover { background:var(--atria-accent); color:var(--atria-on-accent); }
.document-menu { width:230px; max-width:calc(100vw - 44px); }
.document-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:5px 9px 10px; color:var(--atria-muted); font-size:11px; }
.document-menu button, .menu-action { display:block; width:100%; min-height:32px; padding:6px 9px; text-align:left; border:0; border-radius:6px; background:transparent; color:var(--atria-text); font:inherit; cursor:pointer; }
.document-menu button:hover, .menu-action:hover, .document-menu summary:hover { background:var(--atria-hover); }
.document-menu button:disabled { opacity:.4; cursor:default; }
.import-slides summary { padding:7px 9px; border-radius:6px; cursor:pointer; }
.import-slides .file-input { margin-left:10px; }
.source-link { display:block; padding:8px 9px 3px; color:var(--atria-muted); font-size:11px; text-decoration:none; }
.source-link:hover { color:var(--atria-text); }
@media (max-width:760px) { .screening-button span { display:none; } .screening-button { width:28px; padding:0; } }
@media (max-width:520px) { .atria-pptist-header { gap:3px; padding:0 6px; } .presentation-actions { gap:2px; } .icon-button { width:28px; } .file-button { padding:0 6px; } }
</style>
