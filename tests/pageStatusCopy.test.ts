import assert from 'node:assert/strict'
import test from 'node:test'
import { describe, describeNoScript, normalizePageSession } from '../src/popup/PageStatus.js'

// When no content script answers, the popup classifies the cause from the tab
// URL. The URL is only visible on pages our host permissions cover, so a
// missing URL is equivalent evidence to a chrome:// scheme: Chrome refused us
// the page. Only a readable http(s) page gets the "reload this tab" copy —
// the native-pages explanation must never show on an ordinary article.

test('chrome:// pages get the native-pages copy', () => {
  const copy = describeNoScript('chrome://settings/')
  assert.match(copy.headline, /native Chrome pages/)
  assert.equal(copy.tone, 'idle')
})

test('a missing URL is treated as a page Chrome walled off', () => {
  assert.match(describeNoScript(undefined).headline, /native Chrome pages/)
})

test('about: and extension pages get the native-pages copy', () => {
  assert.match(describeNoScript('about:blank').headline, /native Chrome pages/)
  assert.match(describeNoScript('chrome-extension://abc/popup.html').headline, /native Chrome pages/)
})

test('the Chrome Web Store gets the native-pages copy despite being https', () => {
  assert.match(describeNoScript('https://chromewebstore.google.com/detail/x').headline, /native Chrome pages/)
  assert.match(describeNoScript('https://chrome.google.com/webstore/detail/x').headline, /native Chrome pages/)
})

test('an ordinary web page with no script asks for a reload instead', () => {
  const copy = describeNoScript('https://example.com/article')
  assert.match(copy.headline, /not loaded in this tab/)
  assert.match(copy.hint ?? '', /Reload/)
  assert.doesNotMatch(copy.headline, /native Chrome pages/)
})

test('local files point at the file-access permission', () => {
  const copy = describeNoScript('file:///Users/x/notes.html')
  assert.match(copy.hint ?? '', /file URLs/)
})

test('zero eligible words does not promise that raising density will fix it', () => {
  const copy = describe({
    kind: 'active',
    swapped: 0,
    replacedThisSession: 0,
    sessionLemmas: [],
    language: 'es',
  })
  assert.match(copy.headline, /No eligible words/)
  assert.doesNotMatch(copy.hint ?? '', /Raise/)
})

test('the safety pause explains why permission is needed', () => {
  const copy = describe({
    kind: 'paused',
    swapped: 0,
    replacedThisSession: 0,
    sessionLemmas: [],
    language: 'de',
  })
  assert.match(copy.headline, /Waiting for permission/)
  assert.match(copy.hint ?? '', /sensitive sites/)
})

test('an older content script without session lemmas fails closed to an empty session', () => {
  assert.deepEqual(normalizePageSession({ replacedThisSession: 9 }), {
    replacedThisSession: 0,
    sessionLemmas: [],
  })
})

test('the live page session drops malformed values and de-duplicates lemmas', () => {
  assert.deepEqual(normalizePageSession({
    replacedThisSession: 99,
    sessionLemmas: ['market', 'market', '', 42, 'river'],
  }), {
    replacedThisSession: 2,
    sessionLemmas: ['market', 'river'],
  })
})
