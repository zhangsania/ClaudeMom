!define YCLAUDE_LEGACY_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeMom"
Var YClaudeMigratedLegacy

!macro NSIS_HOOK_PREINSTALL
  StrCpy $YClaudeMigratedLegacy 0
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" "InstallLocation"
  ReadRegStr $R1 SHCTX "${YCLAUDE_LEGACY_UNINSTALL}" "Publisher"
  ReadRegStr $R2 SHCTX "${YCLAUDE_LEGACY_UNINSTALL}" "MainBinaryName"
  ${If} $R0 == ""
  ${AndIf} $R1 == "zhangsania"
  ${AndIf} $R2 == "claude-mom.exe"
    ${If} $UpdateMode = 1
    ${OrIf} $INSTDIR == "$LOCALAPPDATA\YClaude"
      ReadRegStr $R0 SHCTX "${YCLAUDE_LEGACY_UNINSTALL}" "InstallLocation"
      StrCpy $R1 $R0 1
      StrCpy $R2 $R0 1 -1
      ${If} $R1 == '$\"'
      ${AndIf} $R2 == '$\"'
        StrCpy $R0 $R0 -1 1
      ${EndIf}
      ${If} $R0 != ""
      ${AndIf} ${FileExists} "$R0\claude-mom.exe"
      ${AndIf} ${FileExists} "$R0\uninstall.exe"
        StrCpy $INSTDIR "$R0"
        SetOutPath "$INSTDIR"
        StrCpy $YClaudeMigratedLegacy 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $YClaudeMigratedLegacy = 1
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "InstallLocation"
    ${If} $R0 == '$\"$INSTDIR$\"'
      !insertmacro IsShortcutTarget "$SMPROGRAMS\ClaudeMom.lnk" "$INSTDIR\claude-mom.exe"
      Pop $0
      ${If} $0 = 1
        ${IfNot} ${FileExists} "$SMPROGRAMS\YClaude.lnk"
          CreateShortCut "$SMPROGRAMS\YClaude.lnk" "$INSTDIR\claude-mom.exe"
          !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\YClaude.lnk"
        ${EndIf}
        !insertmacro IsShortcutTarget "$SMPROGRAMS\YClaude.lnk" "$INSTDIR\claude-mom.exe"
        Pop $0
        ${If} $0 = 1
          Delete "$SMPROGRAMS\ClaudeMom.lnk"
        ${EndIf}
      ${EndIf}
      DeleteRegKey SHCTX "${YCLAUDE_LEGACY_UNINSTALL}"
    ${EndIf}
  ${EndIf}
!macroend
