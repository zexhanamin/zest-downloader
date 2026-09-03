; ═══════════════════════════════════════════════
;  Zest Downloader — build/installer.nsh
;  Custom NSIS hooks for electron-builder.
;
;  electron-builder looks for this file under the
;  configured buildResources directory, which is
;  why it lives in build/ and is referenced from
;  package.json as nsis.include.
;
;  Once the extension is published to the Chrome
;  Web Store, set EXTENSION_ID below to the real
;  32-character ID. Until then the registry hooks
;  stay switched off — writing a placeholder into
;  Chrome's ExtensionInstallForcelist policy would
;  leave a broken policy entry behind on every
;  machine that ran the installer.
; ═══════════════════════════════════════════════

; ── Chrome Web Store Extension ID ──────────────
; Empty = not published yet = registry hooks skipped.
!define EXTENSION_ID ""

; Chrome/Edge policy registry paths
!define CHROME_POLICY  "Software\Policies\Google\Chrome\ExtensionInstallForcelist"
!define EDGE_POLICY    "Software\Policies\Microsoft\Edge\ExtensionInstallForcelist"
!define CHROME_ALLOWED "Software\Policies\Google\Chrome\ExtensionInstallAllowlist"
!define EDGE_ALLOWED   "Software\Policies\Microsoft\Edge\ExtensionInstallAllowlist"

; Update URL for Chrome Web Store
!define CWS_UPDATE_URL "https://clients2.google.com/service/update2/crx"

; ── On Install ──────────────────────────────────
!macro customInstall
  !if "${EXTENSION_ID}" != ""
    ; --- HKCU (Current User) — no admin needed ---
    WriteRegStr HKCU "${CHROME_POLICY}"  "1" "${EXTENSION_ID};${CWS_UPDATE_URL}"
    WriteRegStr HKCU "${EDGE_POLICY}"    "1" "${EXTENSION_ID};${CWS_UPDATE_URL}"
    WriteRegStr HKCU "${CHROME_ALLOWED}" "1" "${EXTENSION_ID}"
    WriteRegStr HKCU "${EDGE_ALLOWED}"   "1" "${EXTENSION_ID}"

    ; --- HKLM (All Users) — only lands when elevated ---
    WriteRegStr HKLM "${CHROME_POLICY}"  "1" "${EXTENSION_ID};${CWS_UPDATE_URL}"
    WriteRegStr HKLM "${EDGE_POLICY}"    "1" "${EXTENSION_ID};${CWS_UPDATE_URL}"
    WriteRegStr HKLM "${CHROME_ALLOWED}" "1" "${EXTENSION_ID}"
    WriteRegStr HKLM "${EDGE_ALLOWED}"   "1" "${EXTENSION_ID}"

    DetailPrint "Zest extension registered for Chrome and Edge"
  !else
    DetailPrint "Zest extension not published yet - install it from the app (Extension button)"
  !endif
!macroend

; ── On Uninstall ────────────────────────────────
!macro customUninstall
  !if "${EXTENSION_ID}" != ""
    DeleteRegValue HKCU "${CHROME_POLICY}"  "1"
    DeleteRegValue HKCU "${EDGE_POLICY}"    "1"
    DeleteRegValue HKCU "${CHROME_ALLOWED}" "1"
    DeleteRegValue HKCU "${EDGE_ALLOWED}"   "1"

    DeleteRegValue HKLM "${CHROME_POLICY}"  "1"
    DeleteRegValue HKLM "${EDGE_POLICY}"    "1"
    DeleteRegValue HKLM "${CHROME_ALLOWED}" "1"
    DeleteRegValue HKLM "${EDGE_ALLOWED}"   "1"

    DetailPrint "Zest extension registry entries removed"
  !endif

  ; Clean up native-messaging keys written by older builds
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.zestdownloader.host"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.zestdownloader.host"
!macroend
