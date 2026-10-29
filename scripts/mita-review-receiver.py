#!/usr/bin/env python3
"""Mita-only VPS image receiver. Install under /opt/mita/shared/bin/ (manual setup).

Production directories are fixed; no request can select a remote path. Calls:
  check <base64url-utf8-name> <sha256hex>
  finish <base64url-utf8-name> <sha256hex> <uuid32>
"""
import base64
from contextlib import contextmanager
import ctypes
import errno
try:
    import fcntl  # Linux VPS only
except ImportError:
    fcntl = None
import hashlib
import os
from pathlib import Path
import re
import stat
import sys

SHARED = Path('/opt/mita/shared')
PUBLISHED = SHARED / 'reviews'
INCOMING = SHARED / 'review-incoming'
MAX_SIZE = 8 * 1024 * 1024
NAME = re.compile(r'^(?![. ])[\w \-().\u00c0-\u1ef9]{1,180}\.(?:png|jpe?g|webp)$', re.IGNORECASE)
TOKEN = re.compile(r'^[0-9a-f]{32}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
DEMO = re.compile(r'^review-demo-\d+\.(?:png|jpe?g|webp)$', re.IGNORECASE)


def filename_from_token(encoded: str) -> str:
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,300}', encoded):
        raise ValueError('invalid filename token')
    raw = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))
    name = raw.decode('utf-8', 'strict')
    if not NAME.fullmatch(name) or len(name.encode('utf-8')) > 240 or DEMO.fullmatch(name):
        raise ValueError('unsafe filename or demo upload')
    if name.endswith((' ', '.')) or name.strip() != name:
        raise ValueError('invalid filename spacing')
    return name


def directory_fd(directory: Path) -> int:
    return os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


@contextmanager
def opened_directory(directory: Path):
    fd = directory_fd(directory)
    try:
        yield fd
    finally:
        os.close(fd)


def inspect_file(dirfd: int, filename: str, image_name: str | None = None):
    """Hash from a regular file opened without following a symlink (bounded read)."""
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dirfd)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as image:
        metadata = os.fstat(image.fileno())
        if not stat.S_ISREG(metadata.st_mode) or not 12 <= metadata.st_size <= MAX_SIZE:
            raise ValueError('invalid file type or length')
        signature = image.read(12)
        # Incoming uploads use an opaque .tmp filename, so validate their image
        # magic against the *final* reviewed image filename's extension.
        ext = (image_name or filename).rsplit('.', 1)[-1].lower()
        valid = (ext == 'png' and signature.startswith(b'\x89PNG\r\n\x1a\n')) or (
            ext in ('jpg', 'jpeg') and signature.startswith(b'\xff\xd8\xff')) or (
            ext == 'webp' and signature[:4] == b'RIFF' and signature[8:12] == b'WEBP')
        if not valid:
            raise ValueError('invalid image signature')
        image.seek(0)
        digest = hashlib.sha256()
        remaining = metadata.st_size
        while remaining:
            chunk = image.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError('truncated upload')
            digest.update(chunk)
            remaining -= len(chunk)
        if os.fstat(image.fileno()).st_size != metadata.st_size:
            raise ValueError('file changed during read')
        return digest.hexdigest()


def atomic_no_replace(srcfd: int, src: str, dstfd: int, dst: str):
    # Ubuntu Linux renameat2 with RENAME_NOREPLACE: atomic publish, never overwrite.
    libc = ctypes.CDLL(None, use_errno=True)
    libc.renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    libc.renameat2.restype = ctypes.c_int
    result = libc.renameat2(srcfd, os.fsencode(src), dstfd, os.fsencode(dst), 1)
    if result:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def receive(action: str, name: str, expected: str, token: str | None = None,
            published: Path = PUBLISHED, incoming: Path = INCOMING) -> str:
    if not SHA256.fullmatch(expected):
        raise ValueError('bad digest')
    if action not in ('check', 'finish') or (action == 'finish' and (not token or not TOKEN.fullmatch(token))):
        raise ValueError('invalid action')
    if action == 'check' and token is not None:
        raise ValueError('unexpected token')

    with opened_directory(published) as pfd:
        if action == 'check':
            digest = inspect_file(pfd, name)
            return 'MISSING' if digest is None else 'HAVE' if digest == expected else 'CONFLICT'

        with opened_directory(incoming) as ifd:
            with os.fdopen(os.open('.review-sync.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=ifd), 'rb') as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                stage = '.incoming-' + token + '.tmp'
                staged_sha = inspect_file(ifd, stage, name)
                if staged_sha != expected:
                    raise ValueError('staged image digest mismatch or missing file')
                existing = inspect_file(pfd, name)
                if existing is not None:
                    if existing != expected:
                        raise ValueError('target filename already contains different content')
                    os.unlink(stage, dir_fd=ifd)
                    return 'HAVE'
                permission_fd = os.open(stage, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=ifd)
                try:
                    os.fchmod(permission_fd, 0o644)
                finally:
                    os.close(permission_fd)
                try:
                    atomic_no_replace(ifd, stage, pfd, name)
                except OSError as error:
                    if error.errno == errno.EEXIST:
                        raise ValueError('target changed while publishing') from error
                    raise
                return 'PUBLISHED'


def main(args: list[str]) -> int:
    if len(args) not in (3, 4):
        print('Usage: receiver check|finish <encoded-filename> <sha256> [upload-token]', file=sys.stderr)
        return 2
    try:
        action, encoded, expected, *rest = args
        if action == 'check' and rest or action == 'finish' and len(rest) != 1:
            raise ValueError('incorrect argument count')
        print(receive(action, filename_from_token(encoded), expected, rest[0] if rest else None))
        return 0
    except (ValueError, OSError) as error:
        print('Mita review sync refused: ' + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
