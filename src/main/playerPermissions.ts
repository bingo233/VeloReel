import type { Session, WebContents } from 'electron'

export function configurePlayerPermissions(
  rendererSession: Session,
  getPlayerContents: () => WebContents | undefined
): void {
  const canFullscreen = (contents: WebContents | null, permission: string, isMainFrame: boolean): boolean =>
    permission === 'fullscreen' && isMainFrame && contents !== null &&
    contents === getPlayerContents() && !contents.isDestroyed()

  // 全屏属于本机播放器的操作权限；远程子页面和其他权限仍按默认策略拒绝。
  rendererSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(canFullscreen(contents, permission, details.isMainFrame))
  })
  rendererSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    canFullscreen(contents, permission, details.isMainFrame)
  )
}
