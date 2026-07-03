import DefaultTheme from 'vitepress/theme'
import DownloadPanel from './components/DownloadPanel.vue'
import './styles/index.scss'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('DownloadPanel', DownloadPanel)
  },
}
