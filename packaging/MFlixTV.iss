#define MyAppName "MFlixTV"
#define MyAppVersion "1.1.1"
#define MyAppExeName "MFlixTV.exe"

[Setup]
AppId={{9C1D6F42-7E3A-4B21-9D7C-5A1E2F8B3C64}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=MFlixTV
; 目录跟着「安装范围」自动走，别写死 {localappdata}：
;   仅当前用户 → {autopf} = %LOCALAPPDATA%\Programs\MFlixTV（不需要管理员，装哪都不会报权限）
;   所有用户   → {autopf} = C:\Program Files\MFlixTV
; 1.1.0 之前写的是 {localappdata} + PrivilegesRequired=admin：一旦在「所有用户安装」下运行，
; {localappdata} 指的是提权账户的 Profile，别的账户装就会「安装程序无法创建目录」。
DefaultDirName={autopf}\MFlixTV
DefaultGroupName=MFlixTV
DisableProgramGroupPage=yes
; 默认不弹 UAC（装到当前用户）；仍可在开始页选「为所有用户安装」
PrivilegesRequired=lowest
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
; 每次安装都留一份日志（%TEMP%\Setup Log <时间>.txt），出问题时能看到卡在哪个路径
SetupLogging=yes

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
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""MFlixTV-LAN-8080"""; Flags: runhidden; Check: CanTouchFirewall
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""MFlixTV-LAN-8080"" dir=in action=allow protocol=TCP localport=8080 profile=private,domain"; Flags: runhidden; StatusMsg: "配置局域网访问..."; Check: CanTouchFirewall
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""MFlixTV-LAN-8000"""; Flags: runhidden; Check: CanTouchFirewall
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""MFlixTV-LAN-8000"" dir=in action=allow protocol=TCP localport=8000 profile=private,domain"; Flags: runhidden; Check: CanTouchFirewall
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 MFlixTV"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill.exe"; Parameters: "/IM {#MyAppExeName} /F"; Flags: runhidden; RunOnceId: "StopLauncher"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\app\.data"
Type: filesandordirs; Name: "{app}\hongguo\server\stream-cache"

[Code]
const
  MaxDirLen = 170;

// 只有提权运行（所有用户安装 / 管理员）才动防火墙规则；普通用户安装时静默跳过，
// 将来的首次监听 Windows 会自己弹「是否允许通信」。
function CanTouchFirewall(): Boolean;
begin
  Result := IsAdminInstallMode or IsAdmin;
end;

// 路径里带这些字符，Windows 建不出目录
function HasBadChars(const S: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := False;
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if (C = '"') or (C = '<') or (C = '>') or (C = '|') or (C = '?') or (C = '*') then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

// 真的往里写一个临时文件：既能建目录，也能写，才算可用
function TryWriteInto(const Dir: String): Boolean;
var
  T: String;
begin
  Result := False;
  try
    if not DirExists(Dir) then
      ForceDirectories(Dir);
    if not DirExists(Dir) then
      Exit;
    T := AddBackslash(Dir) + '.mflixtv-write-test.tmp';
    if SaveStringToFile(T, 'ok', False) then
    begin
      DeleteFile(T);
      Result := True;
    end;
  except
    Result := False;
  end;
end;

procedure WarnDir(const Reason: String);
begin
  MsgBox('这个安装目录不能用：' + #13#10#13#10 + Reason + #13#10#13#10 +
    '建议直接用默认目录，或者换一个短路径，例如：' + #13#10 +
    '  D:\MFlixTV' + #13#10 +
    '  C:\MFlixTV' + #13#10#13#10 +
    '（目录太深会因为 Windows 260 字符路径上限而失败；' + #13#10 +
    '  提示需要管理员权限的位置，请在安装范围里选「为所有用户安装」。）',
    mbError, MB_OK);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  D, Drive: String;
begin
  Result := True;
  if CurPageID <> wpSelectDir then
    Exit;

  D := WizardDirValue;

  if Length(D) > MaxDirLen then
  begin
    WarnDir('路径太长：' + IntToStr(Length(D)) + ' 个字符，超过 ' + IntToStr(MaxDirLen) + ' 个就容易失败。');
    Result := False;
    Exit;
  end;

  if HasBadChars(D) then
  begin
    WarnDir('路径里有 Windows 不允许的字符（" < > | ? *）。');
    Result := False;
    Exit;
  end;

  Drive := ExtractFileDrive(D);
  if (Drive <> '') and (not DirExists(AddBackslash(Drive))) then
  begin
    WarnDir('这个盘不存在或没插好：' + Drive);
    Result := False;
    Exit;
  end;

  if not TryWriteInto(D) then
  begin
    WarnDir('写不进这个目录（权限不够，或者目录被占用）：' + #13#10 + D);
    Result := False;
    Exit;
  end;
end;

// 覆盖安装时旧版通常还开着：MFlixTV.exe 与它拉起的 node 会锁住 exe / runtime\node.exe，
// 导致「尝试替换已存在的文件时出错」。这里在写文件之前把它们结束掉。
procedure KillOldProcesses();
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/IM MFlixTV.exe /F /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // 只杀本安装目录下的 node（按可执行文件路径筛），别碰用户自己开的 node
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -and $_.Path.StartsWith(''' + ExpandConstant('{app}') + ''') } | ' +
    'Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(600);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    KillOldProcesses();
    // 目录提前自己建一遍：Inno 报「无法创建目录」时，这里先给出说得清原因的一句
    if not ForceDirectories(ExpandConstant('{app}')) then
      MsgBox('无法创建安装目录：' + #13#10 + ExpandConstant('{app}') + #13#10#13#10 +
        '常见原因：' + #13#10 +
        '1) 这个位置需要管理员权限 —— 换目录，或在安装范围里选「为所有用户安装」；' + #13#10 +
        '2) 路径太深（Windows 260 字符上限）—— 换成 D:\MFlixTV 这类短路径；' + #13#10 +
        '3) 盘符不存在、磁盘已满或被占用。' + #13#10#13#10 +
        '详细日志在 %TEMP%\Setup Log*.txt。',
        mbError, MB_OK);
  end;
end;
