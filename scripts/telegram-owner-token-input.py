"""One-time owner-run script on the VPS; never prints the Telegram secret."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import termios
import tty
import urllib.request

CONFIG = Path('/etc/mita/mita.env')


def read_masked_token():
    """Read a paste/typed secret from a real TTY and show only asterisks."""
    if not sys.stdin.isatty():
        raise RuntimeError('interactive terminal required')
    fd = sys.stdin.fileno()
    original = termios.tcgetattr(fd)
    collected = bytearray()
    sys.stdout.write('Paste Telegram bot token, then Enter: ')
    sys.stdout.flush()
    try:
        tty.setraw(fd)
        while True:
            char = os.read(fd, 1)
            if char in (b'\r', b'\n'):
                sys.stdout.write('\r\n')
                break
            if char in (b'\x7f', b'\x08'):
                if collected:
                    collected.pop()
                    sys.stdout.write('\b \b')
            elif char == b'\x03':
                raise KeyboardInterrupt
            elif char and 32 <= char[0] <= 126 and len(collected) < 200:
                collected.extend(char)
                sys.stdout.write('*')
            sys.stdout.flush()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, original)
    return collected.decode('ascii')

def main():
    if os.geteuid() != 0 or not CONFIG.is_file() or CONFIG.is_symlink():
        print('ERROR: protected config unavailable')
        return 1
    token = read_masked_token().strip()
    if not re.fullmatch(r'[0-9]{5,20}:[A-Za-z0-9_-]{30,100}', token):
        print('ERROR: invalid token format')
        return 1
    try:
        url = 'https://api.telegram.org/bot' + token + '/getMe'
        with urllib.request.urlopen(url, timeout=12) as response:
            result = json.load(response)
        if result.get('ok') is not True or result.get('result', {}).get('username') != 'Mita01Bot':
            print('ERROR: token does not match @Mita01Bot')
            return 1
    except Exception:
        print('ERROR: Telegram authentication failed')
        return 1

    previous = CONFIG.read_text(encoding='utf-8')
    lines = [line for line in previous.splitlines() if not line.startswith((
        'MITA_TELEGRAM_BOT_TOKEN=', 'MITA_TELEGRAM_ALERTS_ENABLED=', 'MITA_TELEGRAM_ALERTS_VPS='))]
    lines.extend(('MITA_TELEGRAM_BOT_TOKEN=' + token,
                  'MITA_TELEGRAM_ALERTS_ENABLED=0',
                  'MITA_TELEGRAM_ALERTS_VPS=1'))
    fd, temp = tempfile.mkstemp(prefix='.mita-env-', dir=str(CONFIG.parent))
    try:
        old = CONFIG.stat()
        os.fchmod(fd, 0o600)
        os.fchown(fd, old.st_uid, old.st_gid)
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write('\n'.join(lines) + '\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, CONFIG)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    print('SUCCESS: verified @Mita01Bot, token saved on VPS. Alerts remain OFF until deploy.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
