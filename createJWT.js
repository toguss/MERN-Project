// ============================================================================
// createJWT.js - create, verify, and refresh JSON Web Tokens
// A token proves who the user is. It expires after 30 minutes; every
// protected API call sends back a fresh one so active players stay logged in.
// ============================================================================

const jwt = require('jsonwebtoken');
require('dotenv').config({ quiet:true });

const EXPIRES_IN = '30m';

function _createToken( fn, ln, id )
{
  try
  {
    const user = { userId:id, firstName:fn, lastName:ln };
    const accessToken = jwt.sign( user, process.env.ACCESS_TOKEN_SECRET, { expiresIn:EXPIRES_IN } );
    return { accessToken:accessToken };
  }
  catch(e)
  {
    return { error:e.message };
  }
}

exports.createToken = function( fn, ln, id )
{
  return _createToken( fn, ln, id );
}

// Returns the token's payload { userId, firstName, lastName } if it is valid,
// or null if it is missing, tampered with, or expired.
exports.verify = function( token )
{
  try
  {
    return jwt.verify( token, process.env.ACCESS_TOKEN_SECRET );
  }
  catch(e)
  {
    return null;
  }
}

// new token for same user, every protected endpoint sends one back,
// no active player gets kicked out
exports.refresh = function( payload )
{
  return _createToken( payload.firstName, payload.lastName, payload.userId );
}
