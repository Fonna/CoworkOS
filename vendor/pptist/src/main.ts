import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

import 'prosemirror-view/style/prosemirror.css'
import 'animate.css'
import '@/assets/styles/prosemirror.scss'
import '@/assets/styles/global.scss'
// CoworkOS uses installed fonts; no remote font downloads.
import './atria/embedded.scss'

import Directive from '@/directive'

const app = createApp(App)
app.use(Directive)
app.use(createPinia())
app.mount('#app')

document.addEventListener('contextmenu', event => event.preventDefault())
