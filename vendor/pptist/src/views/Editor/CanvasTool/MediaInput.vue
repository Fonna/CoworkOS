<template>
  <div class="media-input">
    <div class="media-tabs" role="group" aria-label="媒体类型">
      <button v-for="tab in tabs" :key="tab.key" type="button" :aria-pressed="type === tab.key" @click="type = tab.key">{{ tab.label }}</button>
    </div>

    <template v-if="type === 'video'">
      <label><span class="field-label">视频地址</span><Input v-model:value="videoSrc" placeholder="https://example.com/video.mp4"></Input></label>
      <div class="btns">
        <FileInput accept="video/*" @change="files => uploadVideo(files)">
          <Button><i-icon-park-outline:upload /> 上传本地视频</Button>
        </FileInput>
        <div class="group">
          <Button @click="emit('close')" style="margin-right: 10px;">取消</Button>
          <Button type="primary" @click="insertVideo()">确认</Button>
        </div>
      </div>
    </template>

    <template v-if="type === 'audio'">
      <label><span class="field-label">音频地址</span><Input v-model:value="audioSrc" placeholder="https://example.com/audio.mp3"></Input></label>
      <div class="btns">
        <FileInput accept="audio/*" @change="files => uploadAudio(files)">
          <Button><i-icon-park-outline:upload /> 上传本地音频</Button>
        </FileInput>
        <div class="group">
          <Button @click="emit('close')" style="margin-right: 10px;">取消</Button>
          <Button type="primary" @click="insertAudio()">确认</Button>
        </div>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { fileDataURL } from '@/atria/import'
import message from '@/utils/message'
import { MIME_MAP } from '@/configs/mime'
import Input from '@/components/Input.vue'
import Button from '@/components/Button.vue'
import FileInput from '@/components/FileInput.vue'

type TypeKey = 'video' | 'audio'
interface TabItem {
  key: TypeKey
  label: string
}

const emit = defineEmits<{
  (event: 'insertVideo', payload: { src: string, ext?: string }): void
  (event: 'insertAudio', payload: { src: string, ext?: string }): void
  (event: 'close'): void
}>()

const type = ref<TypeKey>('video')

const videoSrc = ref('')
const audioSrc = ref('')

const tabs: TabItem[] = [
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
]

const insertVideo = () => {
  if (!videoSrc.value) return message.error('请先输入正确的视频地址')
  emit('insertVideo', { src: videoSrc.value })
}

const insertAudio = () => {
  if (!audioSrc.value) return message.error('请先输入正确的音频地址')
  emit('insertAudio', { src: audioSrc.value })
}

const uploadVideo = async (files: FileList) => {
  const file = files[0]
  if (!file) return
  const ext = MIME_MAP[file.type] || ''
  try { emit('insertVideo', { src: await fileDataURL(file), ext }) } catch (e) { message.error(String(e)) }
}

const uploadAudio = async (files: FileList) => {
  const file = files[0]
  if (!file) return
  const ext = MIME_MAP[file.type] || ''
  try { emit('insertAudio', { src: await fileDataURL(file), ext }) } catch (e) { message.error(String(e)) }
}
</script>

<style lang="scss" scoped>
.media-input {
  width: min(480px, calc(100vw - 54px));
}
.media-tabs { display:flex; gap:4px; margin-bottom:12px; }
.media-tabs button { flex:1; height:30px; border:0; border-radius:6px; color:var(--atria-muted); background:transparent; font:inherit; cursor:pointer; }
.media-tabs button[aria-pressed='true'] { color:var(--atria-text); background:var(--atria-hover); }
.field-label { display:block; margin-bottom:6px; font-size:12px; color:var(--atria-muted); }
.btns {
  margin-top: 10px;
  display: flex;
  justify-content: space-between;
}
</style>

<style scoped>
@media (max-width:520px) { .btns { flex-wrap:wrap; gap:10px; } .btns .group { display:flex; margin-left:auto; } }
</style>
