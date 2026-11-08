; Extra steps of the Windows installer (electron-builder NSIS).
;
; Uninstalling removes the agent hooks Agent Office added to Gemini CLI, Codex and Claude Code, so none of those tools
; is left pointing at files that no longer exist. A plain upgrade keeps them (the install folder doesn't change).
; The installers run with the app's own executable acting as Node (ELECTRON_RUN_AS_NODE).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\package\scripts\hooks-install.mjs" uninstall --provider gemini-cli'
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\package\scripts\hooks-install.mjs" uninstall --provider codex'
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\package\scripts\hooks-install.mjs" uninstall --provider claude-code'
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\package\scripts\usage-install.mjs" uninstall'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")'
  ${endIf}
!macroend
