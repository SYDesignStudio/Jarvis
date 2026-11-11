/**
 * The Plancheck email templates, seeded once into PLANCHECK/templates as
 * Markdown files Salman can edit; JARVIS reads the files, not this module,
 * so his edits win. Placeholders are {{like_this}}. Every one is written in
 * the Plancheck voice: plain, specific, no sales patter, never a name that
 * links back to SY Design Studio. No signature — the account adds it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TEMPLATES = {
  'employer-vacancy-reply': {
    title: 'Reply to a live vacancy advert (employer)',
    subject: 'Your {{role}} vacancy',
    body: `Dear {{first_name}},

I saw {{org}}'s advert for a {{role}}. Experienced {{discipline_people}} are hard to find at the moment, so I wanted to offer some help alongside your own advertising.

Plancheck Recruitment recruits only for building control, planning and architecture, on permanent roles. Every candidate we introduce is technically screened before you see them{{screening_line}}. You receive an anonymised screening report with each CV.

{{closing_line}} If it would help, I can start a search as soon as our Terms of Business are agreed. Nothing is sent without your go-ahead, and there is no fee unless you appoint.

Would a 10-minute call work? I'm free on {{slot_1}} or {{slot_2}}.

Kind regards,`,
  },
  'employer-intro': {
    title: 'Introduction to a head of service (no live advert)',
    subject: 'Building control, planning and architecture recruitment — a quick introduction',
    body: `Dear {{first_name}},

I run Plancheck Recruitment, a small agency that recruits only for building control, planning and architecture, on permanent roles, across London and the South East.

What we do differently: every candidate is technically screened before you see a CV — a written assessment on the Approved Documents and the post-2024 regime for building control surveyors, a structured technical conversation for planners, and ARB and portfolio checks for architects. You get an anonymised report with each CV, so interview time goes on people who can do the work.

If {{org}} has a post that has been hard to fill, or expects one, I'd be glad to hear how you recruit at the moment and whether we could help. There is no fee unless you appoint.

Kind regards,`,
  },
  'employer-follow-up': {
    title: 'Follow-up when an employer has not replied (one chase only)',
    subject: 'Re: {{original_subject}}',
    body: `Dear {{first_name}},

A short follow-up to my email of {{sent_date}} about {{topic}}. I know inboxes are busy.

If a technically screened shortlist would help, I can start a search as soon as our Terms of Business are agreed; if not, no need to reply and I won't write again.

Kind regards,`,
  },
  'terms-cover': {
    title: 'Sending the Terms of Business',
    subject: 'Plancheck Recruitment — Terms of Business',
    body: `Dear {{first_name}},

Thank you for your interest. Our Terms of Business are attached. In short: permanent appointments only, the fee is payable only when a candidate you appoint starts, and a rebate applies if they leave early, on the scale in Schedule 2.

If the terms are acceptable, a reply saying so is enough to agree them, and I'll begin the search for {{role}} straight away. Please tell me the grade or class required, salary range, location and working pattern, and how soon you need someone.

Kind regards,`,
  },
  'candidate-approach': {
    title: 'First approach to a surveyor, planner or architect found online',
    subject: '{{discipline_title}} roles in {{area}}',
    body: `Hi {{first_name}},

I'm with Plancheck Recruitment. We recruit only for building control, planning and architecture, on permanent roles with councils, registered building control approvers, consultancies and practices across London and the South East.

I'm speaking to {{who}} about roles around {{area}}. If you're open to hearing about them, even if now isn't the right time to move, I'd be glad to have a quick, confidential chat.

Registering is free, and we never send your CV to an employer without asking you first. Our privacy notice explains how we found your details and how we use them: plancheckrecruitment.co.uk/privacy. If you'd rather not hear from us, just reply and I won't contact you again.

Kind regards,`,
  },
  'candidate-follow-up': {
    title: 'Follow-up to a candidate who has not replied (one chase only)',
    subject: 'Re: {{original_subject}}',
    body: `Hi {{first_name}},

A quick follow-up to my note of {{sent_date}}. If a confidential chat about {{discipline}} roles would be useful, reply with a time that suits and I'll ring you. If not, no need to reply — I won't write again, and your details are deleted in six months as our privacy notice says.

Kind regards,`,
  },
  'candidate-call-booking': {
    title: 'Booking the screening call after registration',
    subject: 'Thanks for registering with Plancheck — a quick call',
    body: `Hi {{first_name}},

Thank you for registering with Plancheck Recruitment. The next step is a 15-minute call about what you're looking for: the kind of role, salary, location, notice period and anything you'd rather avoid.

Could you reply with two or three times that suit you this week? Daytime or early evening both work.

Kind regards,`,
  },
  'assessment-invitation': {
    title: 'Technical assessment invitation (building control)',
    subject: 'Your Plancheck technical assessment',
    body: `Hi {{first_name}},

As discussed, here is your technical assessment: {{assessment_link}}

It takes about 40 minutes: 24 questions across the Approved Documents, the post-2024 regime and some site scenarios, in one sitting. The link is personal to you and can only be used once, so start it when you have a clear 40 minutes. Your answers come straight to us when you finish; there's nothing to send.

You'll get feedback whatever the result. Nothing goes to an employer without your agreement.

Kind regards,`,
  },
  'permission-to-put-forward': {
    title: 'Asking a candidate\'s permission for a specific employer',
    subject: 'Can I put you forward? {{role}}',
    body: `Hi {{first_name}},

A role has come up that fits what you told me: {{role}} with {{employer_description}}, {{salary}}, {{location}}.

Can I put you forward? If yes, reply "Yes" and I'll send your CV with your anonymised screening report. Your details go to this employer only, and only once you've said yes.

Kind regards,`,
  },
  'not-successful': {
    title: 'Not successful this time',
    subject: 'Re: {{role}}',
    body: `Hi {{first_name}},

Thank you for your time on {{role}}. {{employer_description}} has decided not to take your application further on this occasion. {{feedback_line}}

I'd like to keep you in mind for other roles if you're happy with that; if you'd rather I didn't, just say.

Kind regards,`,
  },
  'website-vacancy-reply': {
    title: 'Reply to an employer who registered a vacancy on the website',
    subject: 'Re: Your vacancy — {{role}}',
    body: `Dear {{first_name}},

Thank you for registering the {{role}} vacancy with Plancheck Recruitment. Before any candidate details are sent, our Terms of Business need to be agreed; they are attached, and a reply confirming them is enough.

Once agreed I'll begin the search. It would help to know the grade or class required, the salary range, the working pattern and how soon you need someone, if the form didn't cover it.

Kind regards,`,
  },
}

/** Write any template that does not yet exist; never overwrite Salman's edits. */
export function seedTemplates(dir) {
  const written = []
  for (const [slug, t] of Object.entries(TEMPLATES)) {
    const p = join(dir, `${slug}.md`)
    if (existsSync(p)) continue
    writeFileSync(p, `# ${t.title}\n\nSubject: ${t.subject}\n\n${t.body}\n`)
    written.push(slug)
  }
  return written
}

/** The templates as Salman has them on disk. */
export function readTemplates(dir) {
  const out = {}
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const raw = readFileSync(join(dir, f), 'utf8')
    const title = (raw.match(/^#\s*(.+)$/m) ?? [])[1] ?? f
    const subject = (raw.match(/^Subject:\s*(.+)$/m) ?? [])[1] ?? ''
    const body = raw.replace(/^#.*$/m, '').replace(/^Subject:.*$/m, '').trim()
    out[f.replace(/\.md$/, '')] = { title, subject, body }
  }
  return out
}

/** Fill {{placeholders}}; any left unfilled are returned so the caller can refuse to send a half-finished email. */
export function fillTemplate(t, values = {}) {
  // An explicit empty string is a filled placeholder: the sentence is simply left out.
  const fill = (s) => String(s ?? '').replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, k) => (values[k] !== undefined && values[k] !== null ? String(values[k]) : m))
  const subject = fill(t.subject)
  const body = fill(t.body)
  const missing = [...new Set([...`${subject}\n${body}`.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => m[1]))]
  return { subject, body, missing }
}
