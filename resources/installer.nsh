; RxLauncher NSIS branding (тёмная тема).
; Основная установка идёт через собственный установщик (resources/installer), который запускает
; этот NSIS тихо. Окна NSIS видны при удалении и при ручном запуске — палитра совпадает с артом.

!define RX_INSTALLER_BACKGROUND "0A0A0B"
!define RX_INSTALLER_TEXT "F2F2F4"
!define RX_INSTALLER_ACCENT "E53935"

!define MUI_BGCOLOR "${RX_INSTALLER_BACKGROUND}"
!define MUI_TEXTCOLOR "${RX_INSTALLER_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${RX_INSTALLER_TEXT} 151518"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_CANCEL_DEFAULT

; electron-builder has a first-class installer header option, but no separate
; uninstaller header option. MUI2 supports it through this define.
!define MUI_HEADERIMAGE_UNBITMAP "${BUILD_RESOURCES_DIR}\uninstallerHeaderRx.bmp"

LangString RX_WELCOME_TITLE 1049 "Добро пожаловать в RxLauncher"
LangString RX_WELCOME_TITLE 1033 "Welcome to RxLauncher"
LangString RX_WELCOME_TEXT 1049 "Мастер установит RxLauncher ${VERSION} — быстрый Minecraft-лаунчер.$\r$\n$\r$\nПеред продолжением закройте запущенный RxLauncher."
LangString RX_WELCOME_TEXT 1033 "This wizard will install RxLauncher ${VERSION}, a fast Minecraft launcher.$\r$\n$\r$\nClose RxLauncher before continuing."

LangString RX_UNWELCOME_TITLE 1049 "Удаление RxLauncher"
LangString RX_UNWELCOME_TITLE 1033 "Uninstall RxLauncher"
LangString RX_UNWELCOME_TEXT 1049 "Мастер удалит RxLauncher с этого компьютера.$\r$\n$\r$\nЛичные настройки и игровые файлы будут сохранены."
LangString RX_UNWELCOME_TEXT 1033 "This wizard will remove RxLauncher from this computer.$\r$\n$\r$\nPersonal settings and game files will be kept."

LangString RX_DIRECTORY_TEXT 1049 "Выберите папку для установки RxLauncher. Для продолжения нажмите «Далее»."
LangString RX_DIRECTORY_TEXT 1033 "Choose the folder where RxLauncher will be installed, then click Next."
LangString RX_DIRECTORY_LABEL 1049 "Папка установки"
LangString RX_DIRECTORY_LABEL 1033 "Installation folder"

LangString RX_FINISH_TITLE 1049 "RxLauncher установлен"
LangString RX_FINISH_TITLE 1033 "RxLauncher is installed"
LangString RX_FINISH_TEXT 1049 "Установка завершена. Можно запустить лаунчер прямо сейчас."
LangString RX_FINISH_TEXT 1033 "Setup is complete. You can launch RxLauncher now."
LangString RX_RUN_TEXT 1049 "Запустить RxLauncher"
LangString RX_RUN_TEXT 1033 "Launch RxLauncher"

LangString RX_UNFINISH_TITLE 1049 "RxLauncher удалён"
LangString RX_UNFINISH_TITLE 1033 "RxLauncher was removed"
LangString RX_UNFINISH_TEXT 1049 "Приложение удалено. Личные настройки и игровые файлы сохранены."
LangString RX_UNFINISH_TEXT 1033 "The application was removed. Personal settings and game files were kept."

LangString RX_ABORT_TEXT 1049 "Прервать установку RxLauncher?"
LangString RX_ABORT_TEXT 1033 "Cancel RxLauncher setup?"

!define MUI_ABORTWARNING_TEXT "$(RX_ABORT_TEXT)"
!define MUI_DIRECTORYPAGE_TEXT_TOP "$(RX_DIRECTORY_TEXT)"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "$(RX_DIRECTORY_LABEL)"

!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_TITLE "$(RX_FINISH_TITLE)"
  !define MUI_FINISHPAGE_TEXT "$(RX_FINISH_TEXT)"
  !define MUI_FINISHPAGE_RUN_TEXT "$(RX_RUN_TEXT)"
!else
  !define MUI_FINISHPAGE_TITLE "$(RX_UNFINISH_TITLE)"
  !define MUI_FINISHPAGE_TEXT "$(RX_UNFINISH_TEXT)"
!endif

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(RX_WELCOME_TITLE)"
  !define MUI_WELCOMEPAGE_TEXT "$(RX_WELCOME_TEXT)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(RX_UNWELCOME_TITLE)"
  !define MUI_WELCOMEPAGE_TEXT "$(RX_UNWELCOME_TEXT)"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; Собственное окно удаления кладём в папку лаунчера при установке (собирается заранее: npm run build-uninstaller)
!macro customInstall
  SetOutPath "$INSTDIR\resources"
  File "/oname=RxUninstall.exe" "${BUILD_RESOURCES_DIR}\installer\build\RxUninstall.exe"
  SetOutPath "$INSTDIR"
!macroend

; Удаление «вручную» (Приложения Windows, «Uninstall RxLauncher.exe») открывает собственное окно.
; Тихие запуски (/S) — обновления и автообновления — идут обычным NSIS, ничего не меняется.
!macro customUnInit
  ${IfNot} ${Silent}
    ${If} ${FileExists} "$INSTDIR\resources\RxUninstall.exe"
      CopyFiles /SILENT "$INSTDIR\resources\RxUninstall.exe" "$TEMP\RxUninstall-ui.exe"
      ${If} ${FileExists} "$TEMP\RxUninstall-ui.exe"
        Exec '"$TEMP\RxUninstall-ui.exe" --uninstall "--dir=$INSTDIR"'
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
  ; Без сайта и без «Nullsoft Install System» внизу окна
  BrandingText " "
!macroend
