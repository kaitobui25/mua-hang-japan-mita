# Provision the Mita Gmail SMTP credential without passing it through arguments,
# the assistant's terminal, PowerShell history, a log, or a plaintext disk file.
# The shop owner pastes the Google App Password into a masked Windows dialog.
param([switch]$Probe)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$remotePython = @'
import os, re, stat, sys, tempfile

path = '/etc/mita/mita.env'
if len(sys.argv) > 1 and sys.argv[1] == 'probe':
    st = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        sys.exit(3)
    print('Mita protected environment is ready')
    sys.exit(0)

credential = re.sub(r'\s+', '', sys.stdin.readline())
if not re.fullmatch(r'[A-Za-z0-9]{16}', credential):
    sys.exit(2)
st = os.stat(path, follow_symlinks=False)
if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
    sys.exit(3)
with open(path, encoding='utf-8') as f:
    previous = f.read().splitlines()
updates = {
    'NODE_ENV': 'production',
    'MITA_EMAIL_ALERTS_ENABLED': '0',
    'MITA_EMAIL_ALERTS_VPS': '1',
    'MITA_GMAIL_SMTP_USER': 'nothink1315@gmail.com',
    'MITA_GMAIL_SMTP_FROM': 'nothink1315@gmail.com',
    'MITA_GMAIL_SMTP_APP_PASSWORD': credential,
}
kept = [line for line in previous if not any(re.match(r'^\s*' + re.escape(k) + r'\s*=', line) for k in updates)]
fd, temporary = tempfile.mkstemp(prefix='.mita-env-', dir='/etc/mita')
try:
    os.fchmod(fd, 0o600)
    os.fchown(fd, 0, 0)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('\n'.join(kept + [k + '=' + v for k, v in updates.items()]) + '\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)
    directory = os.open('/etc/mita', os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('Mita SMTP credential staged securely; sending remains disabled')
'@

$key = Join-Path $env:USERPROFILE '.ssh\oracle_20260624'
if (-not (Test-Path -LiteralPath $key)) { throw 'Owner SSH key is not installed on this computer.' }
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remotePython))
$suffix = if ($Probe) { ' probe' } else { '' }
$remote = "sudo -n python3 -c \`"exec(__import__('base64').b64decode('$encoded'))\`"$suffix"

function Send-MitaCredential([string]$credential) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = 'ssh.exe'
    $info.Arguments = '-i "' + $key + '" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -T ubuntu@217.142.225.255 ' + $remote
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'Cannot start SSH.' }
    try {
        if (-not $Probe) { $process.StandardInput.WriteLine($credential) }
        $process.StandardInput.Close()
        $safeOutput = $process.StandardOutput.ReadToEnd().Trim()
        $safeError = $process.StandardError.ReadToEnd() # Never surface this for actual credential provisioning.
        $process.WaitForExit()
        if ($Probe -and $process.ExitCode -ne 0) { throw "SSH probe failed: $safeError" }
        if ($process.ExitCode -ne 0) { throw "Secure VPS provisioning failed (SSH exit $($process.ExitCode))." }
        return $safeOutput
    } finally {
        $process.Dispose()
    }
}

if ($Probe) { Send-MitaCredential '' ; exit 0 }

$form = New-Object Windows.Forms.Form
$form.Text = 'Mita Japan - Gmail App Password'
$form.Size = New-Object Drawing.Size(450,188)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$label = New-Object Windows.Forms.Label
$label.Location = New-Object Drawing.Point(15,15)
$label.Size = New-Object Drawing.Size(405,40)
$label.Text = 'Dán App Password Google vừa tạo (16 ký tự). Không gửi mật khẩu qua chat.'
$entry = New-Object Windows.Forms.TextBox
$entry.Location = New-Object Drawing.Point(15,64)
$entry.Size = New-Object Drawing.Size(405,24)
$entry.UseSystemPasswordChar = $true
$entry.MaxLength = 64
$ok = New-Object Windows.Forms.Button
$ok.Text = 'Lưu an toàn lên VPS'
$ok.Location = New-Object Drawing.Point(228,106)
$ok.Size = New-Object Drawing.Size(192,28)
$cancel = New-Object Windows.Forms.Button
$cancel.Text = 'Hủy'
$cancel.Location = New-Object Drawing.Point(140,106)
$cancel.Size = New-Object Drawing.Size(76,28)
$cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Controls.AddRange(@($label,$entry,$ok,$cancel))
$ok.Add_Click({
    $credential = [regex]::Replace($entry.Text, '\s+', '')
    if ($credential -cnotmatch '^[A-Za-z0-9]{16}$') {
        [Windows.Forms.MessageBox]::Show('App Password phải có đúng 16 ký tự.', 'Mita') | Out-Null
        return
    }
    try {
        $ok.Enabled = $false
        $form.UseWaitCursor = $true
        [void](Send-MitaCredential $credential)
        $entry.Clear()
        [Windows.Forms.MessageBox]::Show('Đã lưu SMTP App Password trên VPS. Chưa bật gửi email.', 'Mita') | Out-Null
        $form.DialogResult = [Windows.Forms.DialogResult]::OK
        $form.Close()
    } catch {
        $entry.Clear()
        [Windows.Forms.MessageBox]::Show('Không thể lưu lên VPS. Chưa bật gửi email.', 'Mita') | Out-Null
    } finally {
        $credential = $null
        $form.UseWaitCursor = $false
        $ok.Enabled = $true
    }
})
[void]$form.ShowDialog()
$form.Dispose()
