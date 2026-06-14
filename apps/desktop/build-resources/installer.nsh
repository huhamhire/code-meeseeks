; meebox 自定义 NSIS 注入（由 electron-builder.yml 的 nsis.include 引入）。
;
; 解决升级安装时的卸载失败（见各宏内排查结论）：
;   1. customCheckAppRunning：强制结束残留进程；并在触发旧卸载器前**前置强删** pr-agent 运行时目录，
;      绕开旧卸载器「数万文件原子 rename + 瞬时锁整批回滚」的死结（当前从旧版升级即生效）。
;   2. customRemoveFiles：新卸载器改为直接强删、不回滚（数据在 ~/.code-meeseeks、安装目录可重建）。
;   3. customHeader：卸载展开文件明细，慢删时给进度感知。
;
; electron-builder 在生成的 installer.nsi 里按名 !insertmacro 调用下列宏（定义即覆盖其默认行为）。
; 可用变量由 electron-builder 注入：APP_EXECUTABLE_FILENAME（产物 exe 名，含空格）、PRODUCT_NAME 等。

; 顶层属性：仅卸载展开详细文件日志（卸载走逐文件 Delete/RMDir，会打印进度，慢删时有感知）。
; 安装侧 electron-builder 用 Nsis7z::Extract 单包解包 + CopyFiles /SILENT，不产生逐文件日志行，
; 展开只会显示一个空白框、反而像卡住——故安装页保持默认（只显示进度条），不强制展开。
!macro customHeader
  ShowUninstDetails show
!macroend

; 覆盖默认「检测应用在运行 → 提示手动关闭并重试」：改为强制结束残留进程（含无窗口的辅助进程
; 及其子进程树 /T），不弹阻塞对话框。本应用数据在 ~/.code-meeseeks，强杀不丢数据；升级期这是期望行为。
;
; 升级卸载根因（已定位）：electron-builder 旧卸载器对 ${INSTDIR} 走「原子卸载」——把数万个文件
; 逐个 Rename 到暂存区，任一文件在 rename 瞬间被占用（AV/索引/句柄）即 `un.restoreFiles` 整批移回
; （= 用户看到的「删了又还原」），返回非 0；安装器侧仅重试 5 次后弹「文件被占用」。嵌入式 pr-agent
; 运行时（数万小文件）使「某次 rename 撞上瞬时锁」几乎必然发生。
;
; 解法（前置强删）：CHECK_APP_RUNNING 早于 uninstallOldVersion 执行（见 installSection.nsh），且本宏
; 在「新安装器」里跑——故在触发旧卸载器之前，用原生 `rd /s /q` 直接递归强删 pr-agent 目录，旧卸载器
; 随后只剩应用壳层、原子 rename 轻松完成。此举对「当前从旧版升级」即生效，不必等下一版。
!macro customCheckAppRunning
  DetailPrint "正在结束可能残留的 ${PRODUCT_NAME} 进程…"
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 500
  DetailPrint "正在清理旧的嵌入式运行时（pr-agent）…"
  nsExec::Exec `cmd /c rd /s /q "$INSTDIR\resources\pragent"`
  Pop $0
!macroend

; 覆盖默认「原子 rename 到暂存区 + 失败整批回滚」的文件删除（仅卸载/升级时）：不需要回滚——
; 数据在 ~/.code-meeseeks、安装目录可重建。改为直接强删：大头 pr-agent 运行时先原生递归删，其余
; RMDir /r；个别顽固锁走 /REBOOTOK 留待重启删，绝不整批回滚、绝不因瞬时锁返回非 0 触发安装器重试。
!macro customRemoveFiles
  SetOutPath $TEMP
  nsExec::Exec `cmd /c rd /s /q "$INSTDIR\resources\pragent"`
  Pop $0
  RMDir /r /REBOOTOK "$INSTDIR"
!macroend
