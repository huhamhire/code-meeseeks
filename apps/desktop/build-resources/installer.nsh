; meebox 自定义 NSIS 注入（由 electron-builder.yml 的 buildResources 自动收录）。
;
; 解决升级安装时旧卸载器卡死/回滚（根因已定位、实测验证）：
;
; 旧卸载器在被 uninstallOldVersion 以 `_?=$INSTDIR` 原位模式静默调起时，即便无任何文件锁也会做
; 「数万文件原子 rename → 任一瞬时占用即整批回滚」并返回非 0，安装器重试 5 次后弹「无法关闭」。
; 该行为固化在旧版卸载器、无法从新安装器修改。本应用为 per-machine 安装（C:\Program Files），
; 升级需 UAC 提权 → 安装 Section 在**内层(提权)实例**执行；electron-builder 的 customCheckAppRunning
; 被 `${ifNot} ${UAC_IsInnerInstance}` 守卫挡在内层之外，放那里的清理逻辑在升级时根本不执行。
;
; 解法（绕过旧卸载器）：改用 customInit —— 位于 .onInit 的 check64BitAndSetRegView 与 initMultiUser
; 之后、且不在 UAC 守卫内 → 内外层实例都执行、且早于 Section 的 uninstallOldVersion，此时 RegView 已 64、
; $INSTDIR 与 SHELL_CONTEXT 已解析。在此清掉旧版卸载注册表项 → uninstallOldVersion 读到空 UninstallString
; 即直接 Return（installUtil.nsh:155-163），**根本不调用旧卸载器** → 无回滚；再自行强删旧安装目录。
; 数据在 ~/.code-meeseeks、安装目录可重建，强删安全；新安装随后写入全新文件与注册表项。
;
; 注入变量/宏：APP_EXECUTABLE_FILENAME、PRODUCT_NAME、UNINSTALL_REGISTRY_KEY、UAC_IsInnerInstance 等。

; 仅卸载展开文件明细（慢删时给进度感知）。安装侧 electron-builder 整包解包不产生逐文件日志，
; 展开只会是空白框，故不开 ShowInstDetails。
!macro customHeader
  ShowUninstDetails show
!macroend

; 绕过旧卸载器 + 清理旧目录。内外层实例都会进来；幂等，重复执行无害（per-machine 升级靠外层清 HKLM
; 即可让内层 uninstallOldVersion 读到空值）。仅在检测到旧版本（UninstallString 非空）时动作。
!macro customInit
  ReadRegStr $R7 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R7 != ""
    ; 结束可能残留的进程，避免占用安装目录文件
    nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $0
    ; 清掉旧版卸载注册表项 → uninstallOldVersion no-op，不触发易卡死的旧卸载器
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
    ; 自行递归强删旧安装目录（数据在 ~/.code-meeseeks，可重建）
    SetOutPath $TEMP
    nsExec::Exec `cmd /c rd /s /q "$INSTDIR"`
    Pop $0
  ${EndIf}
!macroend

; 新卸载器自身的卸载/升级删除：直接强删、不做原子 rename + 回滚（数据在 ~/.code-meeseeks、目录可重建）。
!macro customRemoveFiles
  SetOutPath $TEMP
  nsExec::Exec `cmd /c rd /s /q "$INSTDIR\resources\pragent"`
  Pop $0
  RMDir /r /REBOOTOK "$INSTDIR"
!macroend
