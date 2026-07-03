import DefaultTheme from 'vitepress/theme'
import DownloadPanel from './components/DownloadPanel.vue'
import HomeFeatures from './components/HomeFeatures.vue'
import ModelStrip from './components/ModelStrip.vue'
import './styles/index.scss'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('DownloadPanel', DownloadPanel)
    app.component('HomeFeatures', HomeFeatures)
    app.component('ModelStrip', ModelStrip)
  },
}
