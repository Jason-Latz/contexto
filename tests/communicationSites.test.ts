import assert from 'node:assert/strict'
import test from 'node:test'

import { isCommunicationSite } from '../src/content/communicationSites.js'

test('major webmail and chat hosts are hard-disabled', () => {
  const blocked = [
    'mail.google.com',
    'outlook.live.com',
    'mail.proton.me',
    'app.fastmail.com',
    'team-name.slack.com',
    'discord.com',
    'web.whatsapp.com',
    'teams.microsoft.com',
    'www.linkedin.com',
    'messenger.com',
    'chatgpt.com',
  ]

  for (const hostname of blocked) {
    assert.equal(isCommunicationSite(hostname), true, hostname)
  }
})

test('custom mail, webmail, inbox, and chat subdomains fail closed', () => {
  for (const hostname of [
    'mail.law-school.edu',
    'webmail.example.com',
    'inbox.company.test',
    'chat.community.test',
    'messages.example.org',
  ]) {
    assert.equal(isCommunicationSite(hostname), true, hostname)
  }
})

test('custom singular message subdomains fail closed', () => {
  assert.equal(isCommunicationSite('message.company.test'), true)
})

test('ordinary reading sites remain eligible', () => {
  for (const hostname of [
    'example.com',
    'wikipedia.org',
    'developer.mozilla.org',
    'news.google.com',
    'openai.com',
  ]) {
    assert.equal(isCommunicationSite(hostname), false, hostname)
  }
})
