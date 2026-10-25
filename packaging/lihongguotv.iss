#define MyAppName "lihongguotv"
#define MyAppVersion "1.0.2"
#define MyAppExeName "lihongguotv.exe"

[Setup]
AppId={{9C1D6F42-7E3A-4B21-9D7C-5A1E2F8B3C64}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=lihongguotv
DefaultDirName={localappdata}\Programs\lihongguotv
DefaultGroupName=lihongguotv
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=lihongguotv-Setup-{#MyAppVersion}
SetupIconFile=stage\launcher\app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
DisableWelcomePage=no

[Languages]
Name: "zh"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Files]
Source: "stage\*"; Excludes: "*.log,*.cs"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\lihongguotv"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{autodesktop}\lihongguotv"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 lihongguotv"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill.exe"; Parameters: "/IM {#MyAppExeName} /F"; Flags: runhidden; RunOnceId: "StopLauncher"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\app\.data"
Type: filesandordirs; Name: "{app}\hongguo\server\stream-cache"
