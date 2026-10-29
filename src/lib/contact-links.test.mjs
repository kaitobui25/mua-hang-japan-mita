import assert from 'node:assert/strict';
import test from 'node:test';
import { contactHref, facebookMessengerHref, DEFAULT_FACEBOOK_PAGE, DEFAULT_ZALO_CONTACT } from './contact-links.ts';

test('owner-provided public contact links have correct canonical hosts', () => {
  assert.equal(contactHref(DEFAULT_ZALO_CONTACT, 'zalo'), 'https://zalo.me/818077391629');
  assert.equal(contactHref(DEFAULT_FACEBOOK_PAGE, 'facebook'), DEFAULT_FACEBOOK_PAGE);
});

test('Facebook button addresses Messenger conversation rather than a Page timeline', () => {
  assert.equal(facebookMessengerHref(DEFAULT_FACEBOOK_PAGE), 'https://m.me/100091066656305');
  assert.equal(facebookMessengerHref('https://www.facebook.com/MitaJapan'), 'https://m.me/MitaJapan');
  assert.equal(facebookMessengerHref('https://www.facebook.com/profile.php?id=100091066656305'), 'https://m.me/100091066656305');
  assert.equal(facebookMessengerHref('https://m.me/MitaJapan'), 'https://m.me/MitaJapan');
});

test('contact links reject forged hosts, credentials, query injection and unsafe URLs', () => {
  const invalid = [
    'https://zalo.me.evil.com/818077391629',
    'https://facebook.com.evil.com/Mita-Japan',
    'https://attacker@facebook.com/p/Mita-Japan-100091066656305/',
    'https://www.facebook.com/p/Mita-Japan-100091066656305/?next=https://evil.com',
    'javascript:alert(1)',
    'http://zalo.me/818077391629',
    'https://zalo.me/+818077391629',
  ];
  for (const url of invalid) {
    assert.equal(contactHref(url, 'zalo'), null);
    assert.equal(contactHref(url, 'facebook'), null);
    assert.equal(facebookMessengerHref(url), null);
  }
});
