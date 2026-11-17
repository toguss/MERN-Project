// api.js - every GeoGame API endpoint. server.js calls setApp(app, client).
//
// Accounts:  register, verify-email, resendverification, login,
//            forgotpassword, resetpassword
// Game:      savegame, profile, history  (require a JWT)
//            leaderboard                 (public)

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const token = require('./createJWT.js');
const email = require('./email.js');

const DB_NAME   = process.env.DB_NAME || 'GeoGames';
const APP_URL   = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');  // the website
const API_URL   = (process.env.API_PUBLIC_URL || 'http://localhost:5000').replace(/\/$/, ''); // where /api lives publicly
const TIME_ZONE = process.env.TIME_ZONE || 'America/New_York';  // for daily streaks

const MODES = ['outline', 'flag'];
const QUESTION_POINTS = 100;
const MIN_PASSWORD = 6;

// -------- HELPERS ----------

// Score for a finished game. Change this one function if your team picks
// a different scoring rule (e.g. speed or streak bonuses).
function computeScore( correct, total )
{
  return correct * QUESTION_POINTS;
}

// Random one-time token: the raw value goes in the email link, only its
// SHA-256 hash is stored in the database.
function newToken()
{
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw:raw, hash:hashToken(raw) };
}

function hashToken( raw ) { 
    return crypto.createHash('sha256').update(String(raw)).digest('hex'); 
}

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// "YYYY-MM-DD" for a date in the app's time zone (so streaks follow local days)
function dayKey( date )
{
  return new Intl.DateTimeFormat('en-CA', { timeZone:TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit' }).format(date);
}

function dayBefore( key )
{
  const d = new Date(key + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// A streak only "counts" if the player played today or yesterday
function effectiveStreak( stats, now = new Date() )
{
  if( !stats || !stats.LastPlayedDate ) return 0;
  const last = dayKey(new Date(stats.LastPlayedDate));
  const today = dayKey(now);
  return (last === today || last === dayBefore(today)) ? (stats.CurrentStreak || 0) : 0;
}

// Read the JWT from the body or the Authorization header.
// Sends 401 and returns null if it is missing or invalid.
function requireAuth( req, res )
{
  const header = req.headers['authorization'] || '';
  const raw = (req.body && req.body.jwtToken) || (header.startsWith('Bearer ') ? header.slice(7) : '');
  const payload = raw ? token.verify(raw) : null;
  if( !payload )
  {
    res.status(401).json({ error:'The JWT is missing, invalid, or expired. Please log in again.', jwtToken:'' });
    return null;
  }
  return payload;
}

function gameOut( g )
{
  return { id:String(g._id), mode:g.Mode, score:g.Score, correct:g.Correct, total:g.Total,
           bestRun:g.BestRun, durationSec:g.DurationSec, playedAt:g.PlayedAt };
}

const USER_SAFE = { projection:{ Password:0, VerifyTokenHash:0, VerifyTokenExpires:0, ResetTokenHash:0, ResetTokenExpires:0 } };



// -------- API ------------

exports.setApp = function ( app, client )
{
  const db = () => client.db(DB_NAME);
  const Users = () => db().collection('Users');
  const Games = () => db().collection('Games');

  // Create indexes once (safe to repeat; existing ones are kept)
  (async () =>
  {
    try
    {
      await Users().createIndex({ Login:1 }, { unique:true });
      await Users().createIndex({ UserID:1 }, { unique:true });
      await Users().createIndex({ Email:1 }, { unique:true, partialFilterExpression:{ Email:{ $type:'string' } } });
      await Users().createIndex({ 'HighScores.outline':-1 });
      await Users().createIndex({ 'HighScores.flag':-1 });
      await Games().createIndex({ UserID:1, PlayedAt:-1 });
    }
    catch(e) { console.warn('Index setup warning:', e.message); }
  })();

  // Simple check that the API is up:  GET /api/health
  app.get('/api/health', (req, res) => res.status(200).json({ status:'ok' }));

  // POST /api/register
  // in:  firstName, lastName, login, email, password
  // out: 201 { message, id, emailSent, error }
  //      400 missing/invalid field, 409 login or email already used
  // Sends a verification email; the user cannot log in until they click it.
  app.post('/api/register', async (req, res) =>
  {
    let { firstName, lastName, login, email:addr, password } = req.body || {};

    if( !firstName || !lastName || !login || !addr || !password )
      return res.status(400).json({ message:'', id:-1, emailSent:false, error:'firstName, lastName, login, email, and password are required' });

    addr = String(addr).trim().toLowerCase();
    login = String(login).trim();

    if( !isEmail(addr) )
      return res.status(400).json({ message:'', id:-1, emailSent:false, error:'Please enter a valid email address' });
    if( String(password).length < MIN_PASSWORD )
      return res.status(400).json({ message:'', id:-1, emailSent:false, error:'Password must be at least ' + MIN_PASSWORD + ' characters' });

    try
    {
      const existing = await Users().findOne({ $or:[ { Login:login }, { Email:addr } ] });
      if( existing )
      {
        const which = existing.Login === login ? 'username' : 'email';
        return res.status(409).json({ message:'', id:-1, emailSent:false, error:'That ' + which + ' is already in use' });
      }

      // Next UserID = highest current UserID + 1
      const last = await Users().find({}, { projection:{ UserID:1 } }).sort({ UserID:-1 }).limit(1).toArray();
      const newId = (last.length > 0 ? last[0].UserID : 0) + 1;

      const verify = newToken();
      const now = new Date();

      await Users().insertOne({
        UserID:newId, FirstName:String(firstName).trim(), LastName:String(lastName).trim(),
        Login:login, Email:addr,
        Password:await bcrypt.hash(String(password), 10),
        EmailVerified:false,
        VerifyTokenHash:verify.hash,
        VerifyTokenExpires:new Date(now.getTime() + 24*60*60*1000),
        CreatedAt:now,
        Stats:{ GamesPlayed:0, TotalCorrect:0, TotalQuestions:0, CurrentStreak:0, LongestStreak:0, LastPlayedDate:null },
        HighScores:{ outline:0, flag:0 }
      });

      const link = API_URL + '/api/verify-email?token=' + verify.raw;
      const sent = await email.sendVerificationEmail(addr, String(firstName).trim(), link);

      return res.status(201).json({
        message: sent ? 'Account created. Check your email to verify your account.'
                      : 'Account created, but the verification email could not be sent. Use "resend verification".',
        id:newId, emailSent:sent, error:'' });
    }
    catch(e)
    {
      if( e.code === 11000 ) return res.status(409).json({ message:'', id:-1, emailSent:false, error:'That username or email is already in use' });
      return res.status(500).json({ message:'', id:-1, emailSent:false, error:e.toString() });
    }
  });

  // GET /api/verify-email?token=...
  // The link in the verification email. Marks the account verified, then
  // redirects to the website:  APP_URL/?verified=1   (or ?verified=0 if bad)
  app.get('/api/verify-email', async (req, res) =>
  {
    try
    {
      const t = req.query.token;
      const user = t ? await Users().findOne({ VerifyTokenHash:hashToken(t), VerifyTokenExpires:{ $gt:new Date() } }) : null;
      if( !user ) return res.redirect(APP_URL + '/?verified=0');

      await Users().updateOne({ UserID:user.UserID },
        { $set:{ EmailVerified:true }, $unset:{ VerifyTokenHash:'', VerifyTokenExpires:'' } });

      return res.redirect(APP_URL + '/?verified=1');
    }
    catch(e)
    {
      return res.redirect(APP_URL + '/?verified=0');
    }
  });

  // POST /api/resendverification
  // in:  email     out: 200 { message, error }
  // Always answers the same way so it can't be used to discover accounts.
  app.post('/api/resendverification', async (req, res) =>
  {
    const addr = String((req.body || {}).email || '').trim().toLowerCase();
    const message = 'If that account exists and is not verified yet, a new verification email has been sent.';
    if( !isEmail(addr) ) return res.status(400).json({ message:'', error:'Please enter a valid email address' });

    try
    {
      const user = await Users().findOne({ Email:addr });
      if( user && !user.EmailVerified )
      {
        const verify = newToken();
        await Users().updateOne({ UserID:user.UserID },
          { $set:{ VerifyTokenHash:verify.hash, VerifyTokenExpires:new Date(Date.now() + 24*60*60*1000) } });
        await email.sendVerificationEmail(addr, user.FirstName, API_URL + '/api/verify-email?token=' + verify.raw);
      }
      return res.status(200).json({ message:message, error:'' });
    }
    catch(e)
    {
      return res.status(500).json({ message:'', error:e.toString() });
    }
  });

  // POST /api/login
  // in:  login (username or email), password
  // out: 200 { id, firstName, lastName, login, accessToken, error }
  //      400 missing fields, 401 wrong login/password, 403 email not verified
  app.post('/api/login', async (req, res) =>
  {
    const { login, password } = req.body || {};
    const fail = { id:-1, firstName:'', lastName:'', login:'', accessToken:'' };

    if( !login || !password )
      return res.status(400).json({ ...fail, error:'Login and password are required' });

    try
    {
      const key = String(login).trim();
      const user = await Users().findOne({ $or:[ { Login:key }, { Email:key.toLowerCase() } ] });
      if( !user ) return res.status(401).json({ ...fail, error:'Invalid username or password' });

      // Passwords are bcrypt hashes. Older test users may still have a plain-text
      // password; if it matches, it is upgraded to a hash right away.
      let ok = false;
      if( typeof user.Password === 'string' && user.Password.startsWith('$2') )
      {
        ok = await bcrypt.compare(String(password), user.Password);
      }
      else if( user.Password === String(password) )
      {
        ok = true;
        await Users().updateOne({ UserID:user.UserID }, { $set:{ Password:await bcrypt.hash(String(password), 10) } });
      }
      if( !ok ) return res.status(401).json({ ...fail, error:'Invalid username or password' });

      if( user.EmailVerified === false )
        return res.status(403).json({ ...fail, needsVerification:true, error:'Please verify your email before logging in' });

      const tok = token.createToken(user.FirstName, user.LastName, user.UserID);
      if( tok.error ) return res.status(500).json({ ...fail, error:tok.error });

      return res.status(200).json({ id:user.UserID, firstName:user.FirstName, lastName:user.LastName,
                                    login:user.Login, accessToken:tok.accessToken, error:'' });
    }
    catch(e)
    {
      return res.status(500).json({ ...fail, error:e.toString() });
    }
  });

  // POST /api/forgotpassword
  // in:  email          out: 200 { message, error }
  // Emails a reset link to APP_URL/reset-password?token=...  (valid 1 hour).
  // Same answer whether or not the email exists.
  app.post('/api/forgotpassword', async (req, res) =>
  {
    const addr = String((req.body || {}).email || '').trim().toLowerCase();
    if( !isEmail(addr) ) return res.status(400).json({ message:'', error:'Please enter a valid email address' });

    try
    {
      const user = await Users().findOne({ Email:addr });
      if( user )
      {
        const reset = newToken();
        await Users().updateOne({ UserID:user.UserID },
          { $set:{ ResetTokenHash:reset.hash, ResetTokenExpires:new Date(Date.now() + 60*60*1000) } });
        await email.sendPasswordResetEmail(addr, user.FirstName, APP_URL + '/reset-password?token=' + reset.raw);
      }
      return res.status(200).json({ message:'If an account uses that email, a password reset link has been sent.', error:'' });
    }
    catch(e)
    {
      return res.status(500).json({ message:'', error:e.toString() });
    }
  });

  // POST /api/resetpassword
  // in:  token (from the email link), password (the new one)
  // out: 200 { message, error }   400 bad/expired token or weak password
  app.post('/api/resetpassword', async (req, res) =>
  {
    const { token:t, password } = req.body || {};
    if( !t || !password ) return res.status(400).json({ message:'', error:'token and password are required' });
    if( String(password).length < MIN_PASSWORD )
      return res.status(400).json({ message:'', error:'Password must be at least ' + MIN_PASSWORD + ' characters' });

    try
    {
      const user = await Users().findOne({ ResetTokenHash:hashToken(t), ResetTokenExpires:{ $gt:new Date() } });
      if( !user ) return res.status(400).json({ message:'', error:'This reset link is invalid or has expired' });

      // Clicking an emailed link also proves they own the email
      await Users().updateOne({ UserID:user.UserID },
        { $set:{ Password:await bcrypt.hash(String(password), 10), EmailVerified:true },
          $unset:{ ResetTokenHash:'', ResetTokenExpires:'' } });

      return res.status(200).json({ message:'Password updated. You can log in now.', error:'' });
    }
    catch(e)
    {
      return res.status(500).json({ message:'', error:e.toString() });
    }
  });


  // POST /api/savegame   (JWT required)
  // in:  mode ("outline" | "flag"), correct, total, bestRun, durationSec, answers (optional: [{ country, guess, correct }])
  // out: 200 { gameId, score, highScore, newHighScore, currentStreak, longestStreak, error, jwtToken }
  //      400 invalid game data, 401 bad token, 404 user not found
  // Saves the game and updates the player's stats, high score, and streak.
  app.post('/api/savegame', async (req, res) =>
  {
    const auth = requireAuth(req, res); if( !auth ) return;
    const jwtToken = token.refresh(auth).accessToken;

    const { mode, correct, total, bestRun = 0, durationSec = 0, answers = [] } = req.body || {};

    if( !MODES.includes(mode) )
      return res.status(400).json({ error:'mode must be "outline" or "flag"', jwtToken });
    if( !isInt(total, 1, 50) || !isInt(correct, 0, total) || !isInt(bestRun, 0, correct) || !isInt(durationSec, 0, 3600) || !Array.isArray(answers) )
      return res.status(400).json({ error:'Invalid game data: need whole numbers with 0 <= bestRun <= correct <= total <= 50 and 0 <= durationSec <= 3600', jwtToken });

    try
    {
      const user = await Users().findOne({ UserID:auth.userId });
      if( !user ) return res.status(404).json({ error:'User not found', jwtToken });

      const now = new Date();
      const score = computeScore(correct, total);

      // Daily streak: same day = unchanged, yesterday = +1, otherwise restart at 1
      const stats = user.Stats || {};
      const today = dayKey(now);
      const last = stats.LastPlayedDate ? dayKey(new Date(stats.LastPlayedDate)) : null;
      let streak = 1;
      if( last === today ) streak = Math.max(stats.CurrentStreak || 1, 1);
      else if( last === dayBefore(today) ) streak = (stats.CurrentStreak || 0) + 1;
      const longest = Math.max(stats.LongestStreak || 0, streak);

      const oldHigh = (user.HighScores && user.HighScores[mode]) || 0;

      const cleanAnswers = answers.slice(0, total).map(a => ({
        Country:String((a && a.country) || '').slice(0, 3).toUpperCase(),
        Guess:String((a && a.guess) || '').slice(0, 3).toUpperCase(),
        Correct:!!(a && a.correct)
      }));

      const result = await Games().insertOne({
        UserID:user.UserID, Mode:mode, Score:score, Correct:correct, Total:total,
        BestRun:bestRun, DurationSec:durationSec, PlayedAt:now, Answers:cleanAnswers
      });

      await Users().updateOne({ UserID:user.UserID }, {
        $inc:{ 'Stats.GamesPlayed':1, 'Stats.TotalCorrect':correct, 'Stats.TotalQuestions':total },
        $set:{ 'Stats.CurrentStreak':streak, 'Stats.LongestStreak':longest, 'Stats.LastPlayedDate':now },
        $max:{ ['HighScores.' + mode]:score }
      });

      return res.status(200).json({ gameId:String(result.insertedId), score:score,
        highScore:Math.max(oldHigh, score), newHighScore:score > oldHigh,
        currentStreak:streak, longestStreak:longest, error:'', jwtToken });
    }
    catch(e)
    {
      return res.status(500).json({ error:e.toString(), jwtToken });
    }
  });


  // POST /api/profile   (JWT required)
  // in:  (just the token)
  // out: 200 { user, stats, highScores, recentGames[10], error, jwtToken }
  app.post('/api/profile', async (req, res) =>
  {
    const auth = requireAuth(req, res); if( !auth ) return;
    const jwtToken = token.refresh(auth).accessToken;

    try
    {
      const user = await Users().findOne({ UserID:auth.userId }, USER_SAFE);
      if( !user ) return res.status(404).json({ error:'User not found', jwtToken });

      const s = user.Stats || {};
      const recent = await Games().find({ UserID:user.UserID }).sort({ PlayedAt:-1 }).limit(10).toArray();

      return res.status(200).json({
        user:{ id:user.UserID, firstName:user.FirstName, lastName:user.LastName, login:user.Login,
               email:user.Email || '', createdAt:user.CreatedAt || null },
        stats:{
          gamesPlayed:s.GamesPlayed || 0,
          totalCorrect:s.TotalCorrect || 0,
          totalQuestions:s.TotalQuestions || 0,
          accuracy:s.TotalQuestions ? Math.round(100 * (s.TotalCorrect || 0) / s.TotalQuestions) : 0,
          currentStreak:effectiveStreak(s),
          longestStreak:s.LongestStreak || 0,
          lastPlayedDate:s.LastPlayedDate || null
        },
        highScores:{ outline:(user.HighScores || {}).outline || 0, flag:(user.HighScores || {}).flag || 0 },
        recentGames:recent.map(gameOut),
        error:'', jwtToken });
    }
    catch(e)
    {
      return res.status(500).json({ error:e.toString(), jwtToken });
    }
  });


  // POST /api/history   (JWT required)
  // in:  mode (optional filter), page (default 1), pageSize (default 10, max 50)
  // out: 200 { games[], page, pageSize, totalGames, totalPages, error, jwtToken }
  app.post('/api/history', async (req, res) =>
  {
    const auth = requireAuth(req, res); if( !auth ) return;
    const jwtToken = token.refresh(auth).accessToken;

    const { mode } = req.body || {};
    const page = Math.max(parseInt((req.body || {}).page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt((req.body || {}).pageSize) || 10, 1), 50);

    if( mode && !MODES.includes(mode) )
      return res.status(400).json({ error:'mode must be "outline" or "flag"', jwtToken });

    try
    {
      const filter = { UserID:auth.userId };
      if( mode ) filter.Mode = mode;

      const totalGames = await Games().countDocuments(filter);
      const games = await Games().find(filter).sort({ PlayedAt:-1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();

      return res.status(200).json({ games:games.map(gameOut), page, pageSize, totalGames,
        totalPages:Math.max(Math.ceil(totalGames / pageSize), 1), error:'', jwtToken });
    }
    catch(e)
    {
      return res.status(500).json({ error:e.toString(), jwtToken });
    }
  });

  // POST /api/leaderboard   (public, no token needed)
  // in:  mode ("outline" | "flag"), limit (default 10, max 50)
  // out: 200 { mode, entries:[{ rank, login, firstName, score }], error }
  // One entry per player: their best score in that mode.
  app.post('/api/leaderboard', async (req, res) =>
  {
    const { mode } = req.body || {};
    const limit = Math.min(Math.max(parseInt((req.body || {}).limit) || 10, 1), 50);

    if( !MODES.includes(mode) ) return res.status(400).json({ mode:'', entries:[], error:'mode must be "outline" or "flag"' });

    try
    {
      const field = 'HighScores.' + mode;
      const users = await Users()
        .find({ [field]:{ $gt:0 } }, { projection:{ Login:1, FirstName:1, HighScores:1 } })
        .sort({ [field]:-1 }).limit(limit).toArray();

      const entries = users.map((u, i) => ({ rank:i + 1, login:u.Login, firstName:u.FirstName, score:u.HighScores[mode] }));
      return res.status(200).json({ mode, entries, error:'' });
    }
    catch(e)
    {
      return res.status(500).json({ mode, entries:[], error:e.toString() });
    }
  });
}

// Exported for the unit tests
exports._test = { computeScore, dayKey, dayBefore, effectiveStreak };
