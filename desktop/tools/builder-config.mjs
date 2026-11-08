// The electron-builder configuration, as plain data so a test can check it. See docs/desktop.md.

/**
 * @param {{ version: string, packageDir: string }} o  `packageDir` is the release package (npm run package) that goes
 * into the app as resources/package: real files, outside the asar, so an external `node` can run its hook scripts.
 */
export function builderConfig({ version, packageDir }) {
  return {
    appId: 'com.agentoffice.desktop',
    productName: 'Agent Office',
    copyright: 'Agent Office, MIT licensed',
    asar: true,
    npmRebuild: false,
    directories: { output: 'out', buildResources: 'assets' },
    files: ['dist/**/*', 'assets/**/*', 'package.json', '!dist/**/*.map', '!assets/installer.nsh'],
    extraMetadata: { version, main: 'dist/main.cjs' },
    extraResources: [{ from: packageDir, to: 'package' }],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'assets/icon.png',
      artifactName: 'Agent-Office-Setup-${version}.${ext}',
    },
    nsis: {
      // per user: no administrator prompt, installs under %LOCALAPPDATA%\Programs
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      runAfterFinish: true,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      shortcutName: 'Agent Office',
      deleteAppDataOnUninstall: false,
      include: 'assets/installer.nsh',
    },
    linux: { target: [{ target: 'dir' }], icon: 'assets/icon.png', category: 'Development' },
  };
}
