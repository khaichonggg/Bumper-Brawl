Unicode true
!include "MUI2.nsh"

!define PRODUCT_NAME "Bumper Brawl"
!define PRODUCT_VERSION "2.6.1"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BumperBrawl"

!ifndef NODE_EXE
  !error "Pass /DNODE_EXE=<path to node.exe> to makensis"
!endif
!ifndef NODE_LICENSE
  !error "Pass /DNODE_LICENSE=<path to the Node.js LICENSE file> to makensis"
!endif
!ifndef OUTPUT_FILE
  !define OUTPUT_FILE "..\..\Codex\outputs\MyGameSetup.exe"
!endif

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
Caption "Bumper Brawl Setup"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Bumper Brawl"
InstallDirRegKey HKCU "Software\BumperBrawl" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!define MUI_ICON "assets\bumper-brawl.ico"
!define MUI_UNICON "assets\bumper-brawl.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "assets\header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "assets\header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "assets\welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "assets\welcome.bmp"
!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "1D1D1F"
!define MUI_INSTFILESPAGE_COLORS "FFFFFF 1D1D1F"

VIProductVersion "2.6.1.0"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey /LANG=1033 "CompanyName" "Bumper Brawl"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "OriginalFilename" "MyGameSetup.exe"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to Bumper Brawl"
!define MUI_WELCOMEPAGE_TEXT "Quick matches. Big collisions. Friends welcome.$\r$\n$\r$\nThis wizard will install Bumper Brawl ${PRODUCT_VERSION} on your computer."
!define MUI_LICENSEPAGE_TEXT_TOP "Please read and accept the ISC License to continue."
!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "I agree to the ISC License terms"
!define MUI_DIRECTORYPAGE_TEXT_TOP "Choose where Bumper Brawl should be installed."
!define MUI_FINISHPAGE_TITLE "You are ready to play."
!define MUI_FINISHPAGE_TEXT "Bumper Brawl is installed. Launch it now or use the Desktop and Start Menu shortcuts later."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch Bumper Brawl"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchGame

!define MUI_UNCONFIRMPAGE_TEXT_TOP "Remove Bumper Brawl from this computer? Saved game data will be kept."
!define MUI_UNFINISHPAGE_TITLE "Bumper Brawl has been removed"
!define MUI_UNFINISHPAGE_TEXT "Your local game data has been kept on this computer."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Section "Bumper Brawl" SEC_GAME
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "..\launcher.js"
  File "..\server.js"
  File "..\package.json"
  File "..\package-lock.json"
  File "..\start.bat"
  File "..\diagnose.bat"
  File "..\README.md"
  File "..\README.zh-CN.md"
  File "..\LICENSE"
  File "assets\bumper-brawl.ico"

  SetOutPath "$INSTDIR\public"
  File /r "..\public\*"
  SetOutPath "$INSTDIR\server"
  File /r "..\server\*"
  SetOutPath "$INSTDIR\tools"
  File /r "..\tools\*"
  SetOutPath "$INSTDIR\runtime"
  File /oname=node.exe "${NODE_EXE}"
  File /oname=LICENSE.txt "${NODE_LICENSE}"

  CreateDirectory "$INSTDIR\data"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall Bumper Brawl.exe"
  CreateDirectory "$SMPROGRAMS\Bumper Brawl"
  CreateShortcut "$SMPROGRAMS\Bumper Brawl\Bumper Brawl.lnk" "$INSTDIR\start.bat" "" "$INSTDIR\bumper-brawl.ico" 0
  CreateShortcut "$SMPROGRAMS\Bumper Brawl\Uninstall Bumper Brawl.lnk" "$INSTDIR\Uninstall Bumper Brawl.exe" "" "$INSTDIR\bumper-brawl.ico" 0
  CreateShortcut "$DESKTOP\Bumper Brawl.lnk" "$INSTDIR\start.bat" "" "$INSTDIR\bumper-brawl.ico" 0

  WriteRegStr HKCU "Software\BumperBrawl" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Bumper Brawl"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Bumper Brawl"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall Bumper Brawl.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall Bumper Brawl.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function LaunchGame
  ExecShell "open" "$INSTDIR\start.bat"
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Bumper Brawl.lnk"
  Delete "$SMPROGRAMS\Bumper Brawl\Bumper Brawl.lnk"
  Delete "$SMPROGRAMS\Bumper Brawl\Uninstall Bumper Brawl.lnk"
  RMDir "$SMPROGRAMS\Bumper Brawl"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\BumperBrawl"

  Delete "$INSTDIR\launcher.js"
  Delete "$INSTDIR\server.js"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\start.bat"
  Delete "$INSTDIR\diagnose.bat"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\README.zh-CN.md"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\bumper-brawl.ico"
  Delete "$INSTDIR\Uninstall Bumper Brawl.exe"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\tools"
  Delete "$INSTDIR\runtime\node.exe"
  Delete "$INSTDIR\runtime\LICENSE.txt"
  RMDir "$INSTDIR\runtime"
  ; Keep data written by the game, such as the local leaderboard.
  RMDir "$INSTDIR"
SectionEnd
