// 屏保外壳的 preload：网页只能通过 window.desk 收发 saver: 开头的频道，碰不到 Node 和 Electron 别的东西。
// 沙盒里的 preload 只能是 CommonJS。
const { contextBridge, ipcRenderer } = require('electron')

function check(ch) {
  if (typeof ch !== 'string' || !ch.startsWith('saver:')) throw new Error(`不允许的频道 ${ch}`)
}

contextBridge.exposeInMainWorld('desk', {
  invoke: (ch, ...args) => {
    check(ch)
    return ipcRenderer.invoke(ch, ...args)
  },
  on: (ch, fn) => {
    check(ch)
    const listener = (_e, ...args) => fn(...args)
    ipcRenderer.on(ch, listener)
    return () => ipcRenderer.removeListener(ch, listener)
  },
  platform: process.platform,
})
