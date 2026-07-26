'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const OutlookConnector = require('../connectors/outlook');
const { CUE_NAMES, ICON_NAMES } = require('../utils/cuePayload');
const { stubFetch, fakeSecretStore, collectCues } = require('./helpers/fakes');

const TOKEN_KEY = 'outlook-token';
const USER = 'me@example.com';

function makeConnector() {
  const connector = new OutlookConnector({
    tokenKey: TOKEN_KEY,
    userEmail: USER,
    secretStore: fakeSecretStore({ [TOKEN_KEY]: 'graph-token' }),
  });
  connector.token = 'graph-token';
  return connector;
}

/**
 * @param {string} address
 * @returns {{emailAddress: {address: string}}}
 */
const to = (address) => ({ emailAddress: { address } });

function message(id, { toRecipients = [], ccRecipients = [], name = 'Ada' } = {}) {
  return { id, from: { emailAddress: { name } }, toRecipients, ccRecipients };
}

test('direct mail gets a comet, CC gets the subtle bottom glow', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{
    match: '/messages',
    body: {
      value: [
        message('b', { ccRecipients: [to(USER)] }),
        message('a', { toRecipients: [to(USER)] }),
      ],
    },
  }]);

  try {
    await connector._checkEmails(false);
  } finally {
    fetchStub.restore();
  }

  // Oldest first: 'a' is last in the newest-first API response.
  assert.equal(cues.length, 2);
  assert.equal(cues[0].cue, 'comet');
  assert.match(cues[0].msg, /Email from Ada/);
  assert.equal(cues[1].cue, 'glow-bottom');
  assert.match(cues[1].msg, /CC'd by Ada/);
});

test('mail addressed to someone else is ignored', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{
    match: '/messages',
    body: { value: [message('x', { toRecipients: [to('someone@else.example')] })] },
  }]);

  try {
    await connector._checkEmails(false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 0);
});

test('recipient matching is case-insensitive', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{
    match: '/messages',
    body: { value: [message('x', { toRecipients: [to('ME@Example.COM')] })] },
  }]);

  try {
    await connector._checkEmails(false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1);
});

test('the baseline run suppresses mail that was already unread', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const body = { value: [message('a', { toRecipients: [to(USER)] })] };
  const fetchStub = stubFetch([{ match: '/messages', body }]);

  try {
    await connector._checkEmails(true);
    assert.equal(cues.length, 0);
    await connector._checkEmails(false);
    assert.equal(cues.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test('an imminent meeting fires once', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const start = new Date(Date.now() + 3 * 60000).toISOString().replace(/\.\d+Z$/, '');
  const fetchStub = stubFetch([{
    match: '/calendarView',
    body: { value: [{ id: 'm1', subject: 'Standup', start: { dateTime: start, timeZone: 'UTC' } }] },
  }]);

  try {
    await connector._checkCalendar();
    await connector._checkCalendar();
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1);
  assert.match(cues[0].msg, /Standup starts in \d+ min/);
  assert.equal(cues[0].icon, 'calendar');
  assert.equal(cues[0].urgent, true, 'meeting reminders must pierce focus mode');
  assert.ok(CUE_NAMES.includes(cues[0].cue));
  assert.ok(ICON_NAMES.includes(cues[0].icon));
});

test('a meeting further out than the reminder threshold stays quiet', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const start = new Date(Date.now() + 20 * 60000).toISOString().replace(/\.\d+Z$/, '');
  const fetchStub = stubFetch([{
    match: '/calendarView',
    body: { value: [{ id: 'm2', subject: 'Later', start: { dateTime: start, timeZone: 'UTC' } }] },
  }]);

  try {
    await connector._checkCalendar();
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 0);
});

test('event start times parse with or without an explicit offset', () => {
  const connector = makeConnector();
  const naive = connector._parseEventStart({ dateTime: '2026-07-26T10:00:00.0000000', timeZone: 'UTC' });
  const explicit = connector._parseEventStart({ dateTime: '2026-07-26T10:00:00Z' });

  assert.equal(naive.toISOString(), '2026-07-26T10:00:00.000Z');
  assert.equal(explicit.toISOString(), '2026-07-26T10:00:00.000Z');
  assert.equal(connector._parseEventStart({ dateTime: 'not a date' }), null);
  assert.equal(connector._parseEventStart(undefined), null);
});

test('an expired token surfaces once and stops polling', async () => {
  const connector = makeConnector();
  connector.isRunning = true;
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{ match: '/messages', status: 401 }]);

  try {
    await connector._checkEmails(false);
    await connector._checkEmails(false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1);
  assert.match(cues[0].msg, /sign-in expired/i);
  assert.equal(connector.isRunning, false);
});

test('start() refuses to poll without a token or an address', () => {
  const noToken = new OutlookConnector({ tokenKey: TOKEN_KEY, userEmail: USER, secretStore: fakeSecretStore({}) });
  noToken.start();
  assert.equal(noToken.isRunning, false);

  const noEmail = new OutlookConnector({ tokenKey: TOKEN_KEY, secretStore: fakeSecretStore({ [TOKEN_KEY]: 't' }) });
  noEmail.start();
  assert.equal(noEmail.isRunning, false);
});
