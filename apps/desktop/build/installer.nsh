# Check payloads, not the setup filename: electron-builder can also embed both
# architectures in one installer. Keep its x64-on-ARM64 emulation support.
!macro customInit
  Push $R0
  Push $R1
  StrCpy $R0 "x86"
  ${If} ${IsNativeARM64}
    StrCpy $R0 "arm64"
  ${ElseIf} ${IsNativeAMD64}
    StrCpy $R0 "x64"
  ${EndIf}

  !ifdef APP_ARM64
    StrCpy $R1 "arm64"
    ${If} ${IsNativeARM64}
      Goto doriterm_arch_supported
    ${EndIf}
  !endif
  !ifdef APP_64
    !ifdef APP_ARM64
      StrCpy $R1 "x64/arm64"
    !else
      StrCpy $R1 "x64"
    !endif
    ${If} ${IsNativeAMD64}
    ${OrIf} ${IsNativeARM64}
      Goto doriterm_arch_supported
    ${EndIf}
  !endif

  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONSTOP "This Doriterm installer contains $R1, but this machine runs $R0 Windows. Download the $R0 setup from the Doriterm release page."
  ${EndIf}
  # .onInit may have created /D's directory with SetOutPath. Remove only an
  # empty directory; never remove an existing installation or any user files.
  SetOutPath $TEMP
  RMDir $INSTDIR
  SetErrorLevel 1633 # ERROR_INSTALL_PLATFORM_UNSUPPORTED, including /S.
  Quit

doriterm_arch_supported:
  Pop $R1
  Pop $R0
!macroend
