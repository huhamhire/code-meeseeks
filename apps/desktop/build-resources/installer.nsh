; meebox 自定义 NSIS 注入（由 electron-builder.yml 的 nsis.include 引入）。
;
; 解决两件事（见排查结论）：
;   1. 升级安装时不被「Code Meeseeks 无法关闭」对话框阻塞 —— 直接强制结束残留进程，不弹手动关闭框；
;   2. 展开安装 / 卸载的文件处理明细，让用户对「正在处理大量文件」有进度感知（嵌入式 python 文件多、慢）。
;
; electron-builder 在生成的 installer.nsi 里按名 !insertmacro 调用下列宏（定义即覆盖其默认行为）。
; 可用变量由 electron-builder 注入：APP_EXECUTABLE_FILENAME（产物 exe 名，含空格）、PRODUCT_NAME 等。

; 顶层属性：安装 / 卸载都展开详细文件日志（默认收起，用户看不到逐文件进度）。
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

; 覆盖默认「检测应用在运行 → 提示手动关闭并重试」：改为强制结束残留进程（含无窗口的辅助进程
; 及其子进程树 /T），不弹阻塞对话框。本应用数据在 ~/.code-meeseeks，强杀不丢数据；升级期这是期望行为。
; 经排查：目标机常无进程持有安装目录，阻塞多由检测/慢删误判触发；此宏直接清场、让安装继续。
!macro customCheckAppRunning
  DetailPrint "正在结束可能残留的 ${PRODUCT_NAME} 进程…"
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 500
!macroend
