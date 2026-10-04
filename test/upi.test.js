const test = require('node:test');
const assert = require('node:assert/strict');
const upi = require('../lib/upi');

const GMAIL_OK = (domain) => 'Authentication-Results: mx.google.com;\r\n' +
  '       dkim=pass header.i=@' + domain + ' header.s=sel1 header.b=AbCdEf12;\r\n' +
  '       spf=pass (google.com: domain of alerts@' + domain + ' designates 1.2.3.4 as permitted sender) smtp.mailfrom=alerts@' + domain + ';\r\n' +
  '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=' + domain;
const GMAIL_FAIL = (domain) => 'Authentication-Results: mx.google.com;\r\n' +
  '       spf=softfail (google.com: domain of transitioning x@evil.test does not designate 6.6.6.6 as permitted sender) smtp.mailfrom=x@evil.test;\r\n' +
  '       dmarc=fail (p=REJECT sp=REJECT dis=QUARANTINE) header.from=' + domain;

function email({ auth, from, subject, body, html, extra }) {
  return Buffer.from([
    'Delivered-To: alerts@gmail.com',
    'Received: by 2002:a05:6400:1234 with SMTP id abc; Sun, 4 Oct 2026 10:20:31 -0700 (PDT)',
    ...[].concat(auth || []),
    ...[].concat(extra || []),
    'From: ' + from,
    'To: alerts@gmail.com',
    'Subject: ' + subject,
    'Date: Sun, 4 Oct 2026 22:50:30 +0530',
    'MIME-Version: 1.0',
    html ? 'Content-Type: text/html; charset=UTF-8' : 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    html || body
  ].join('\r\n'));
}

// ---------- what the bank emails say ----------

const SAMPLES = [
  ['HDFC', 'You have received money in your account',
    'Dear Customer, Rs.100.37 has been credited to your account **1234 by VPA john.doe@okaxis JOHN DOE on 04-10-26. Your UPI transaction reference number is 427712345678. Thank you for banking with us.',
    { amount: 100.37, utr: '427712345678', payer: 'john.doe@okaxis' }],
  ['SBI', 'Credit alert',
    'Dear Customer, Your A/C XXXXX123456 has been credited by Rs.1,250.05 on 04Oct26 by transfer from RAHUL K. Ref No 427712345679 -SBI',
    { amount: 1250.05, utr: '427712345679' }],
  ['ICICI', 'Transaction alert for your ICICI Bank account',
    'Dear Customer, Your Account XX123 has been credited with INR 49.12 on 04-Oct-26. Info:UPI-427712345680-PRIYA S. The Available Balance is INR 5,000.00.',
    { amount: 49.12, utr: '427712345680' }],
  ['Axis', 'Credit Alert',
    'INR 10.99 credited to A/c no. XX1234 on 04-10-26 at 10:20:30 IST. Info- UPI/P2A/427712345681/ANIL. Avl bal INR 5,000.00 - Axis Bank',
    { amount: 10.99, utr: '427712345681' }],
  ['Kotak', 'Rs. 500.42 credited',
    'Rs. 500.42 is credited in your Kotak Bank account XX1234 from priya@ybl on 04/10/2026. UPI Ref 427712345682. Remarks: BSTK7Q2M9XH',
    { amount: 500.42, utr: '427712345682', payer: 'priya@ybl', ref: 'BSTK7Q2M9XH' }],
  ['Generic', 'UPI Credit',
    'Amount: ₹ 75.50 received. UPI Reference Number (RRN): 427712345683. Note BSTAAAA2222',
    { amount: 75.5, utr: '427712345683', ref: 'BSTAAAA2222' }]
];

for (const [bank, subject, body, want] of SAMPLES) {
  test('parses a ' + bank + '-style UPI credit alert', () => {
    const got = upi.parseAlert(subject, body, { ownVpa: 'store@okhdfcbank' });
    assert.ok(got, 'should parse');
    assert.equal(got.amount, want.amount);
    assert.equal(got.utr, want.utr);
    if (want.payer) assert.equal(got.payer, want.payer);
    assert.equal(got.ref, want.ref || '');
  });
}

test('ignores debits, OTPs, statements and balance-only lines', () => {
  assert.equal(upi.parseAlert('Debit alert', 'Rs.100.37 has been debited from account **1234 to VPA shop@ybl on 04-10-26. UPI Ref 427712345690. If not you, call us.'), null);
  assert.equal(upi.parseAlert('Your account was debited', 'Your a/c XX12 is debited for Rs 100.37 and credited to payee@upi. UPI Ref 427712345691'), null);
  assert.equal(upi.parseAlert('OTP', 'Your OTP for login is 482910. Do not share it.'), null);
  assert.equal(upi.parseAlert('Statement', 'Your e-statement for September is attached.'), null);
  assert.equal(upi.parseAlert('Credit', 'Money received. Avl Bal Rs 5,000.00'), null, 'no UTR, and the balance is not an amount');
  const got = upi.parseAlert('Credit', 'Your a/c XX12 is credited. Avl Bal Rs 5,000.00. UPI Ref 427712345692');
  assert.equal(got, null, 'never takes the balance as the credited amount');
});

test('UPI link: fixed amount, reference note, readable UPI ID', () => {
  const link = upi.payLink({ vpa: 'store@okhdfcbank', name: 'Boostly Store', amount: 100.37, ref: 'BSTK7Q2M9XH' });
  assert.equal(link, 'upi://pay?pa=store@okhdfcbank&pn=Boostly%20Store&am=100.37&cu=INR&tn=BSTK7Q2M9XH');
  assert.match(upi.payLink({ vpa: 'a@b', name: 'x', amount: 5, ref: 'r' }), /am=5\.00&/);
  const ref = upi.newRef();
  assert.match(ref, /^BST[A-HJ-NP-Z2-9]{8}$/);
  assert.ok(upi.REF_RE.test('note ' + ref.toLowerCase() + ' here'), 'found case-insensitively in alerts');
});

test('QR code is an SVG of the UPI link', async () => {
  const svg = await upi.qrSvg('upi://pay?pa=store@okhdfcbank&am=1.37&cu=INR&tn=BSTK7Q2M9XH');
  assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.ok(!/<script/i.test(svg));
});

// ---------- is it really from the bank? ----------

const LIST = upi.senderList('');

test('trusts a bank email that Gmail verified (DMARC/DKIM pass)', () => {
  const raw = email({ auth: GMAIL_OK('hdfcbank.net'), from: 'HDFC Bank InstaAlerts <alerts@hdfcbank.net>', subject: 'x', body: 'y' });
  assert.deepEqual(upi.verifySender(raw, LIST), { ok: true, domain: 'hdfcbank.net', address: 'alerts@hdfcbank.net' });
  const bankIn = email({ auth: GMAIL_OK('alerts.hdfcbank.bank.in'), from: 'alerts@alerts.hdfcbank.bank.in', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(bankIn, LIST).ok, true, 'any *.bank.in domain is a bank');
});

test('rejects fake alerts: spoofed From, planted headers, other senders', () => {
  const spoofed = email({ auth: GMAIL_FAIL('hdfcbank.net'), from: 'alerts@hdfcbank.net', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(spoofed, LIST).ok, false, 'Gmail says DMARC failed');
  const planted = email({ auth: [GMAIL_FAIL('hdfcbank.net'), GMAIL_OK('hdfcbank.net')], from: 'alerts@hdfcbank.net', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(planted, LIST).ok, false, 'a pass header planted below Gmail’s own is ignored');
  const noAuth = email({ from: 'alerts@hdfcbank.net', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(noAuth, LIST).ok, false);
  const otherServer = email({ auth: GMAIL_OK('hdfcbank.net').replace('mx.google.com', 'mx.evil.test'), from: 'alerts@hdfcbank.net', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(otherServer, LIST).ok, false, 'only Gmail’s verdict counts');
  const stranger = email({ auth: GMAIL_OK('gmail.com'), from: 'someone@gmail.com', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(stranger, LIST).ok, false, 'a genuine non-bank sender');
  const lookalike = email({ auth: GMAIL_OK('hdfcbank.net.evil.test'), from: 'alerts@hdfcbank.net.evil.test', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(lookalike, LIST).ok, false, 'look-alike domain');
  const otherDkim = email({ auth: 'Authentication-Results: mx.google.com; dkim=pass header.i=@evil.test; dmarc=fail header.from=hdfcbank.net', from: 'alerts@hdfcbank.net', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(otherDkim, LIST).ok, false, 'a DKIM pass for another domain doesn’t count');
  const twoFroms = email({ auth: GMAIL_OK('hdfcbank.net'), from: 'alerts@hdfcbank.net', extra: 'From: attacker@evil.test', subject: 'x', body: 'y' });
  assert.equal(upi.verifySender(twoFroms, LIST).ok, false, 'two From headers');
});

test('UPI_ALERT_SENDERS narrows the list to your bank', () => {
  const list = upi.senderList('alerts@hdfcbank.net');
  assert.equal(upi.allowedSender('alerts@hdfcbank.net', list), true);
  assert.equal(upi.allowedSender('other@hdfcbank.net', list), false);
  assert.equal(upi.allowedSender('alerts@sbi.co.in', list), false);
  assert.equal(upi.allowedSender('x@alerts.sbi.co.in', upi.senderList('sbi.co.in')), true, 'domains cover subdomains');
});

test('toAlert: a full HTML bank email becomes an alert row; a forged one doesn’t', async () => {
  const html = '<html><body><table><tr><td>Dear Customer,</td></tr><tr><td>Rs.100.37 has been credited to your account **1234 by VPA john@okaxis on 04-10-26.</td></tr>' +
    '<tr><td>Your UPI transaction reference number is 427712345678.</td></tr></table></body></html>';
  const cfg = { alertSenders: '', upiId: 'store@okhdfcbank' };
  const at = new Date('2026-10-04T17:20:31Z');
  const a = await upi.toAlert(email({ auth: GMAIL_OK('hdfcbank.net'), from: 'HDFC Bank <alerts@hdfcbank.net>', subject: 'You have received money', html }), at, cfg);
  assert.deepEqual(a, { utr: '427712345678', amount: '100.37', bank: 'HDFC Bank', payer: 'john@okaxis', ref: '', received_at: at.toISOString() });
  assert.equal(await upi.toAlert(email({ auth: GMAIL_FAIL('hdfcbank.net'), from: 'alerts@hdfcbank.net', subject: 'You have received money', html }), at, cfg), null);
});

// ---------- the Gmail inbox ----------

function fakeImap(messages, opts) {
  opts = opts || {};
  return {
    ImapFlow: class {
      constructor(o) { fakeImap.lastOptions = o; this.mailbox = null; }
      async connect() { if (opts.authFail) throw Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'Invalid credentials (Failure)' }); }
      async getMailboxLock(path, o) { fakeImap.lockOptions = o; this.mailbox = { path, uidValidity: 7n, uidNext: messages.length ? messages[messages.length - 1].uid + 1 : 1 }; return { release() {} }; }
      async search(q) {
        if (q.since) return messages.filter((m) => m.date >= q.since).map((m) => m.uid);
        const from = parseInt(q.uid, 10);
        const hit = messages.filter((m) => m.uid >= from).map((m) => m.uid);
        return hit.length ? hit : messages.slice(-1).map((m) => m.uid);       // IMAP "N:*" quirk
      }
      async *fetch(uids, query) {
        fakeImap.fetched = (fakeImap.fetched || []).concat([[query.source ? 'source' : 'envelope', uids.slice()]]);
        for (const m of messages.filter((x) => uids.includes(x.uid))) {
          yield { uid: m.uid, envelope: { from: [{ address: m.from }] }, source: query.source ? m.raw : undefined, internalDate: m.date };
        }
      }
      async logout() {}
      close() {}
    }
  };
}

test('readInbox: downloads only bank emails, keeps genuine credits, never changes the mailbox', async () => {
  const now = new Date();
  const msg = (uid, from, raw) => ({ uid, from, raw, date: now });
  const good = email({ auth: GMAIL_OK('hdfcbank.net'), from: 'alerts@hdfcbank.net', subject: 'Credit', body: 'Rs.100.37 has been credited to your account **1234. UPI Ref 427712345678' });
  const fake = email({ auth: GMAIL_FAIL('hdfcbank.net'), from: 'alerts@hdfcbank.net', subject: 'Credit', body: 'Rs.500.00 has been credited to your account **1234. UPI Ref 427712345679' });
  const promo = email({ auth: GMAIL_OK('hdfcbank.net'), from: 'offers@hdfcbank.net', subject: 'Pre-approved loan', body: 'Get a loan today!' });
  const news = email({ auth: GMAIL_OK('news.test'), from: 'hello@news.test', subject: 'Weekly news', body: 'Rs.1 credited lol UPI Ref 427712345670' });
  const box = [msg(10, 'alerts@hdfcbank.net', good), msg(11, 'alerts@hdfcbank.net', fake), msg(12, 'offers@hdfcbank.net', promo), msg(13, 'hello@news.test', news)];
  fakeImap.fetched = [];
  const cfg = { gmail: 'alerts@gmail.com', gmailPass: 'abcd efgh ijkl mnop', alertSenders: '', upiId: 'store@okhdfcbank' };
  const r = await upi.readInbox(cfg, { last_uid: 0, uid_validity: 0 }, { imapflow: fakeImap(box) });
  assert.equal(fakeImap.lastOptions.host, 'imap.gmail.com');
  assert.equal(fakeImap.lastOptions.auth.pass, 'abcdefghijklmnop', 'spaces in the app password are removed');
  assert.deepEqual(fakeImap.lockOptions, { readOnly: true });
  assert.deepEqual(fakeImap.fetched, [['envelope', [10, 11, 12, 13]], ['source', [10, 11, 12]]], 'the newsletter is never downloaded');
  assert.deepEqual(r.alerts.map((a) => [a.utr, a.amount]), [['427712345678', '100.37']]);
  assert.equal(r.rejected, 2);
  assert.equal(r.lastUid, 13);
  assert.equal(r.uidValidity, 7);

  fakeImap.fetched = [];
  const again = await upi.readInbox(cfg, { last_uid: 13, uid_validity: 7 }, { imapflow: fakeImap(box) });
  assert.equal(again.scanned, 0, 'next run continues after the last message');
  assert.deepEqual(fakeImap.fetched, []);
  assert.equal(again.lastUid, 13);
});

test('readInbox: a wrong app password gives a clear, secret-free message', async () => {
  const cfg = { gmail: 'alerts@gmail.com', gmailPass: 'wrong', alertSenders: '' };
  await assert.rejects(upi.readInbox(cfg, null, { imapflow: fakeImap([], { authFail: true }) }), (e) => {
    const msg = upi.describeError(e);
    assert.match(msg, /App Password/);
    assert.ok(!msg.includes('wrong'));
    return true;
  });
});
