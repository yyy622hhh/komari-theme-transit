import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { installGlobalErrorHandler } from '@/utils/errorBoundary'
import { setupIconify } from '@/utils/iconify'
import { message } from '@/utils/message'
import { logAppWarning } from '@/utils/safeError'
import App from './App.vue'
import router from './router'

import './styles/main.css'

window.$message = message

setupIconify().catch((err) => {
  logAppWarning('Iconify initialization failed', err)
})

const pinia = createPinia()
const app = createApp(App)
installGlobalErrorHandler(app)

app.use(pinia)
app.use(router)

app.mount('#app')
