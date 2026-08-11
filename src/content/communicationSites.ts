// Hard safety boundary for sites whose primary purpose includes composing or
// sending email, chat, direct messages, or collaboration messages. Unlike the
// user's ordinary per-site pause list, this policy is intentionally not
// overrideable: Contexto must never run where a DOM rewrite could become
// outbound communication.

// Matching a parent domain also covers workspace/app subdomains (for example,
// a-company.slack.com). Keep ordinary reading-first sites out of this list; the
// universal editable-surface guard still protects comment boxes and composers
// wherever they appear.
const COMMUNICATION_DOMAINS: readonly string[] = [
  // Webmail and shared inboxes
  'gmail.com',
  'googlemail.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.cloud.microsoft',
  'mail.proton.me',
  'app.proton.me',
  'protonmail.com',
  'fastmail.com',
  'hey.com',
  'icloud.com',
  'front.com',
  'missiveapp.com',

  // Workplace and direct messaging
  'slack.com',
  'discord.com',
  'whatsapp.com',
  'telegram.org',
  'messenger.com',
  'facebook.com',
  'linkedin.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'snapchat.com',
  'tiktok.com',
  'teams.microsoft.com',
  'teams.cloud.microsoft',
  'groupme.com',
  'element.io',
  'zoom.us',
  'webex.com',
  'mattermost.com',
  'rocket.chat',

  // AI chat surfaces
  'chatgpt.com',
  'claude.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
  'perplexity.ai',
  'poe.com',
]

// Covers hosted/custom webmail and chat installations without trying to know
// every provider or organization domain in advance (mail.law-school.edu,
// webmail.example.com, chat.company.org, and similar).
const COMMUNICATION_SUBDOMAIN_LABELS = new Set([
  'mail',
  'webmail',
  'inbox',
  'email',
  'chat',
  'message',
  'messages',
  'messenger',
])

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
}

export function isCommunicationSite(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (!host) return false

  const firstLabel = host.split('.')[0]
  if (COMMUNICATION_SUBDOMAIN_LABELS.has(firstLabel)) return true

  return COMMUNICATION_DOMAINS.some(domain =>
    host === domain || host.endsWith(`.${domain}`),
  )
}
