import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AppSettings,
  DesktopApi,
  ProgressPayload,
  RuleGenerationProgress,
  RuleGenerateInput,
  SiteRule
} from '../shared/types'

const api: DesktopApi = {
  getVersion: () => ipcRenderer.invoke(IPC.APP_VERSION),
  rules: {
    list: () => ipcRenderer.invoke(IPC.RULE_LIST),
    save: (rule: SiteRule) => ipcRenderer.invoke(IPC.RULE_SAVE, rule),
    remove: (siteId: string) => ipcRenderer.invoke(IPC.RULE_REMOVE, siteId),
    generate: (input: RuleGenerateInput) => ipcRenderer.invoke(IPC.RULE_GENERATE, input),
    onGenerationProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: RuleGenerationProgress) => listener(progress)
      ipcRenderer.on(IPC.RULE_GENERATION_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.RULE_GENERATION_PROGRESS, handler)
    }
  },
  vod: {
    search: (input) => ipcRenderer.invoke(IPC.VOD_SEARCH, input),
    detail: (input) => ipcRenderer.invoke(IPC.VOD_DETAIL, input)
  },
  stream: {
    resolve: (input) => ipcRenderer.invoke(IPC.STREAM_RESOLVE, input),
    release: (input) => ipcRenderer.invoke(IPC.STREAM_RELEASE, input)
  },
  history: {
    list: () => ipcRenderer.invoke(IPC.HISTORY_LIST),
    get: (input) => ipcRenderer.invoke(IPC.HISTORY_GET, input),
    save: (payload: ProgressPayload) => ipcRenderer.invoke(IPC.HISTORY_SAVE, payload),
    remove: (input) => ipcRenderer.invoke(IPC.HISTORY_REMOVE, input),
    clear: () => ipcRenderer.invoke(IPC.HISTORY_CLEAR)
  },
  favorites: {
    list: () => ipcRenderer.invoke(IPC.FAVORITE_LIST),
    add: (input) => ipcRenderer.invoke(IPC.FAVORITE_ADD, input),
    remove: (input) => ipcRenderer.invoke(IPC.FAVORITE_REMOVE, input)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    save: (settings: Partial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings),
    hasApiKey: () => ipcRenderer.invoke(IPC.SETTINGS_HAS_API_KEY),
    setApiKey: (apiKey: string) => ipcRenderer.invoke(IPC.SETTINGS_SET_API_KEY, apiKey),
    clearApiKey: () => ipcRenderer.invoke(IPC.SETTINGS_CLEAR_API_KEY),
    testConnection: (input) => ipcRenderer.invoke(IPC.SETTINGS_TEST_CONNECTION, input)
  }
}

contextBridge.exposeInMainWorld('api', Object.freeze(api))
