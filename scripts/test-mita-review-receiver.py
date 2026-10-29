"""Offline tests for the Mita VPS receiver (no SSH and no VPS access)."""
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import os
import sys
import shutil
import unittest
from unittest.mock import patch


def load_receiver():
    filename = Path(__file__).with_name('mita-review-receiver.py')
    spec = importlib.util.spec_from_file_location('mita_review_receiver', filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


receiver = load_receiver()
SAMPLE = Path(__file__).resolve().parent.parent / 'public' / 'reviews' / 'review-demo-01.png'
TOKEN = 'a' * 32


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix='mita-reviews-test-')
        self.addCleanup(self.temp.cleanup)
        self.published = Path(self.temp.name) / 'reviews'
        self.incoming = Path(self.temp.name) / 'review-incoming'
        self.published.mkdir()
        self.incoming.mkdir()
        self.sha = __import__('hashlib').sha256(SAMPLE.read_bytes()).hexdigest()

    def receive(self, action, name='Ảnh khách đã duyệt.png', digest=None, token=None):
        return receiver.receive(action, name, digest or self.sha, token, self.published, self.incoming)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'VPS openat/fcntl requires Linux')
    def test_missing_published_conflict_and_idempotency(self):
        self.assertEqual(self.receive('check'), 'MISSING')
        dest = self.published / 'Ảnh khách đã duyệt.png'
        shutil.copyfile(SAMPLE, dest)
        self.assertEqual(self.receive('check'), 'HAVE')
        self.assertEqual(self.receive('check', digest='0' * 64), 'CONFLICT')
        self.assertEqual(dest.read_bytes(), SAMPLE.read_bytes())

    @unittest.skipUnless(sys.platform.startswith('linux'), 'VPS openat/fcntl requires Linux')
    def test_atomic_publication_no_overwrite(self):
        incoming = self.incoming / f'.incoming-{TOKEN}.tmp'
        shutil.copyfile(SAMPLE, incoming)

        def mock_no_replace(srcfd, src, dstfd, dst):
            # Portable mock: the real Linux function uses renameat2(RENAME_NOREPLACE).
            source = self.incoming / src
            target = self.published / dst
            if target.exists():
                raise FileExistsError(target)
            os.rename(source, target)

        with patch.object(receiver, 'atomic_no_replace', side_effect=mock_no_replace):
            self.assertEqual(self.receive('finish', token=TOKEN), 'PUBLISHED')
            self.assertEqual(self.receive('check'), 'HAVE')
            self.assertFalse(incoming.exists())
            shutil.copyfile(SAMPLE, incoming)
            self.assertEqual(self.receive('finish', token=TOKEN), 'HAVE')
            self.assertFalse(incoming.exists())

        with open(incoming, 'wb') as image:
            image.write(b'not an image')
        with self.assertRaises(ValueError):
            self.receive('finish', token=TOKEN)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'renameat2 is Linux-only')
    def test_native_atomic_noreplace(self):
        incoming = self.incoming / f'.incoming-{TOKEN}.tmp'
        shutil.copyfile(SAMPLE, incoming)
        self.assertEqual(self.receive('finish', token=TOKEN), 'PUBLISHED')
        target = self.published / 'Ảnh khách đã duyệt.png'
        self.assertEqual(target.read_bytes(), SAMPLE.read_bytes())
        shutil.copyfile(SAMPLE, incoming)
        self.assertEqual(self.receive('finish', token=TOKEN), 'HAVE')
        self.assertEqual(target.read_bytes(), SAMPLE.read_bytes())

    def test_rejects_path_traversal_demo_and_symlink(self):
        for name in ('../private.png', 'review-demo-01.png', '.hidden.png', 'abc/def.jpg', 'review.png '):
            encoded = __import__('base64').urlsafe_b64encode(name.encode()).decode().rstrip('=')
            with self.subTest(name=name), self.assertRaises(ValueError):
                receiver.filename_from_token(encoded)
    @unittest.skipUnless(sys.platform.startswith('linux'), 'VPS openat/fcntl requires Linux')
    def test_rejects_symlink(self):
        linked = self.published / 'Ảnh khách đã duyệt.png'
        try:
            linked.symlink_to(SAMPLE)
        except (OSError, NotImplementedError):
            self.skipTest('Symlink creation unavailable on this Windows host')
        with self.assertRaises(OSError):
            self.receive('check')

    @unittest.skipUnless(sys.platform.startswith('linux'), 'VPS openat/fcntl requires Linux')
    def test_rejects_bad_signature_or_large_file(self):
        wrong = self.published / 'Ảnh khách đã duyệt.png'
        wrong.write_bytes(b'not a valid PNG image')
        with self.assertRaises(ValueError):
            self.receive('check')
        wrong.write_bytes(b'\x89PNG\r\n\x1a\n' + b'0' * (receiver.MAX_SIZE + 1))
        with self.assertRaises(ValueError):
            self.receive('check')


if __name__ == '__main__':
    unittest.main()
