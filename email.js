// ============================================================================
// email.js - sends verification and password-reset emails
//
// DigitalOcean blocks normal email (SMTP) ports on droplets, so this sends
// through an email service's HTTPS API instead. Pick one in .env:
//   EMAIL_PROVIDER=resend   (needs RESEND_API_KEY)
//   EMAIL_PROVIDER=brevo    (needs BREVO_API_KEY)
//   EMAIL_PROVIDER=console  (default: prints the email to the terminal; for testing)
// EMAIL_FROM is the sender, e.g.  GeoGame <noreply@tomasstep.com>
// ============================================================================
require('dotenv').config({ quiet:true });

// In console mode, sent emails are also kept here (used by the tests)
const outbox = [];
exports.outbox = outbox;

// Split "Name <address>" into its parts
function parseFrom( from )
{
  const m = /^(.*)<(.+)>\s*$/.exec( from || '' );
  return m ? { name:m[1].trim(), email:m[2].trim() } : { name:'GeoGame', email:(from || '').trim() };
}

// Send one email. Returns true on success, false on failure (never throws).
async function sendEmail( to, subject, html )
{
  const provider = (process.env.EMAIL_PROVIDER || 'console').toLowerCase();
  const from = process.env.EMAIL_FROM || 'GeoGame <noreply@mern.com>';

  try
  {
    if( provider === 'resend' )
    {
      const r = await fetch('https://api.resend.com/emails', {
        method:'POST',
        headers:{ 'Authorization':'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type':'application/json' },
        body:JSON.stringify({ from:from, to:[to], subject:subject, html:html })
      });
      if( !r.ok ) { console.error('Resend error:', r.status, await r.text()); return false; }
      return true;
    }

    if( provider === 'brevo' )
    {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method:'POST',
        headers:{ 'api-key':process.env.BREVO_API_KEY, 'Content-Type':'application/json', 'Accept':'application/json' },
        body:JSON.stringify({ sender:parseFrom(from), to:[{ email:to }], subject:subject, htmlContent:html })
      });
      if( !r.ok ) { console.error('Brevo error:', r.status, await r.text()); return false; }
      return true;
    }

    // console mode
    outbox.push({ to:to, subject:subject, html:html });
    console.log('\n=== EMAIL (console mode) ===\nTo: ' + to + '\nSubject: ' + subject + '\n' + html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n============================\n');
    return true;
  }
  catch(e)
  {
    console.error('Email send failed:', e.message);
    return false;
  }
}

// Simple HTML layout shared by both emails
function layout( heading, body, buttonText, link )
{
  return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
    <h2>${heading}</h2>
    <p>${body}</p>
    <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">${buttonText}</a></p>
    <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${link}</p>
  </div>`;
}

exports.sendVerificationEmail = function( to, firstName, link )
{
  return sendEmail( to, 'Verify your GeoGame account',
    layout('Welcome to GeoGame, ' + firstName + '!',
      'Please verify your email address to activate your account. The link expires in 24 hours.',
      'Verify my email', link) );
}

exports.sendPasswordResetEmail = function( to, firstName, link )
{
  return sendEmail( to, 'Reset your GeoGame password',
    layout('Password reset',
      'Hello ' + firstName + ', we saw you wanted to reset your password. This link expires in 1 hour. If you did not ask for this, you can ignore this email.',
      'Reset my password', link) );
}
