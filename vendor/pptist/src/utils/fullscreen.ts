// Fullscreen transitions are asynchronous, especially on macOS Electron.
// Remember an exit requested while entry is pending so the iframe cannot get
// stranded in the top layer after the presentation has already closed.
let wantsFullscreen = false
let entering: Promise<void> | undefined

const leave = () => {
  if (window.parent && window.parent !== window) {
    window.dispatchEvent(new Event('atria-exit-fullscreen'))
    return
  }
  if (document.exitFullscreen) return document.exitFullscreen()
  if (document.mozCancelFullScreen) return document.mozCancelFullScreen()
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen()
  if (document.msExitFullscreen) return document.msExitFullscreen()
}

export const enterFullscreen = () => {
  wantsFullscreen = true
  if (entering || isFullscreen()) return
  const element = document.documentElement
  try {
    const request = element.requestFullscreen ? element.requestFullscreen()
      : element.mozRequestFullScreen ? element.mozRequestFullScreen()
        : element.webkitRequestFullScreen ? element.webkitRequestFullScreen()
          : element.msRequestFullscreen?.()
    entering = Promise.resolve(request).then(async () => {
      if (!wantsFullscreen && isFullscreen()) await leave()
    }).catch(() => {
      // Presentation remains usable in the editor when fullscreen is denied.
    }).finally(() => { entering = undefined })
  }
  catch { entering = undefined }
}

export const exitFullscreen = () => {
  wantsFullscreen = false
  if (isFullscreen()) void Promise.resolve(leave()).catch(() => {})
}

export const isFullscreen = () => !!(
  document.fullscreenElement || document.mozFullScreenElement ||
  document.webkitFullscreenElement || document.msFullscreenElement ||
  document.webkitCurrentFullScreenElement
)

// Some embedded browsers report the fullscreen element after the entry promise
// settles. Keep cancellation active until the corresponding change event.
document.addEventListener('fullscreenchange', () => {
  if (!wantsFullscreen && isFullscreen()) exitFullscreen()
})

