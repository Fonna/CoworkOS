<template>
  <Screen v-if="audience" />
  <template v-else-if="slides.length"><Screen v-if="screening" /><Editor v-else /></template>
  <FullscreenSpin v-else tip="正在载入演示文稿…" loading :mask="false" />
</template>
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useScreenStore, useSlidesStore } from '@/store'
import { connect } from './atria/bridge'
import Editor from './views/Editor/index.vue'
import Screen from './views/Screen/index.vue'
import FullscreenSpin from './components/FullscreenSpin.vue'
const { slides } = storeToRefs(useSlidesStore())
const { screening } = storeToRefs(useScreenStore())
const audience = new URLSearchParams(location.search).get('mode') === 'audience'
let disconnect: (() => void) | undefined
onMounted(() => { if (!audience) disconnect = connect() })
onUnmounted(() => disconnect?.())
</script>
<style>#app { height: 100%; }</style>
