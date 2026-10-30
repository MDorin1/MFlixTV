#define MyAppName "MFlixTV"
#define MyAppVersion "1.3.6"
#define MyAppExeName "MFlixTV.exe"

[Setup]
AppId={{9C1D6F42-7E3A-4B21-9D7C-5A1E2F8B3C64}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=MFlixTV
DefaultDirName={localappdata}\Programs\MFlixTV
DefaultGroupName=MFlixTV
DisableProgramGroupPage=yes
PrivilegesRequired=admin
; 允许用户从命令行/右键选择安装范围（默认管理员：装到用户目录，但用管理员令牌，避免 Temp 权限不足报「错误 5」）
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=dist
OutputBaseFilename=MFlixTV-Setup-{#MyAppVersion}
SetupIconFile=stage\launcher\app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
CloseApplicationsFilter=*.exe,*.dll,*.node
RestartApplications=no
DisableWelcomePage=no

[Languages]
Name: "zh"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Files]
Source: "stage\*"; Excludes: "*.log,*.cs"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\MFlixTV"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{autodesktop}\MFlixTV"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""MFlixTV-LAN-8080"""; Flags: runhidden
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""MFlixTV-LAN-8080"" dir=in action=allow protocol=TCP localport=8080 profile=private,domain"; Flags: runhidden; StatusMsg: "配置局域网访问..."
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""MFlixTV-LAN-8000"""; Flags: runhidden
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""MFlixTV-LAN-8000"" dir=in action=allow protocol=TCP localport=8000 profile=private,domain"; Flags: runhidden
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 MFlixTV"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill.exe"; Parameters: "/IM {#MyAppExeName} /F"; Flags: runhidden; RunOnceId: "StopLauncher"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\app\.data"
Type: filesandordirs; Name: "{app}\hongguo\server\stream-cache"

[Code]
// 覆盖安装时旧版通常还开着：MFlixTV.exe 与它拉起的 node 会锁住 exe / runtime\node.exe，
// 导致「尝试替换已存在的文件时出错」。这里在写文件之前把它们结束掉。
function KillTreeUnderAppDir(): Boolean;
var
  Result2: Integer;
begin
  Exec('taskkill.exe', '/IM MFlixTV.exe /F /T', '', SW_HIDE, ewWaitUntilTerminated, Result2);
  // 短剧服务与主站都是 {app}\runtime\node.exe 起的，按镜像名全杀；本机其它 node 进程不受影响
  Exec('taskkill.exe', '/FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq *MFlixTV*" /F', '', SW_HIDE, ewWaitUntilTerminated, Result2);
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    Exec('taskkill.exe', '/IM MFlixTV.exe /F /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(600);
  end;
end;