require('dotenv').config();

// recieves http requests and sends response
const express = require('express');

// react frontend call this api
const cors = require('cors');

// mongodb driver use to talk to the database
const MongoClient = require('mongodb').MongoClient;

const url = process.env.MONGODB_URI;
const client = new MongoClient(url);

// connection to Atlas once at startup
client.connect();

// create the express application
const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) =>
{
  // allow request from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  // request headers browser is allowed to send
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  // http methods browser is allowed to use
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, DELETE, OPTIONS'
  );
  next();
});

// /api/login check a username and password
app.post('/api/login', async (req, res, next) =>
{
  // incoming: login, password
  // outgoing: id, firstName, lastName, error
  // status:   200 = success, 400 = missing fields, 401 = wrong login/password

  const { login, password } = req.body || {};

  // both need to be available if not 401
  if( !login || !password )
  {
    return res.status(400).json({ id:-1, firstName:'', lastName:'', error:'Login and password are required' });
  }

  // try/catch so a database problem returns an error and not crash
  try
  {
    // database on the Atlas cluster
    const db = client.db('COP4331Cards');
    // find one user whose loging and password both match
    const user = await db.collection('Users').findOne({ Login:login, Password:password });

    // if no user is found, return 401 Unauthorized
    if( !user )
    {
      return res.status(401).json({ id:-1, firstName:'', lastName:'', error:'Invalid username or password' });
    }

    // if user is found 200 - OK with the user record
    return res.status(200).json({ id:user.UserID, firstName:user.FirstName, lastName:user.LastName, error:'' });
  }
  catch(e)
  {
    // if there is an error return 500 Internal Server Error
    return res.status(500).json({ id:-1, firstName:'', lastName:'', error:e.toString() });
  }
});


// Create new user account
app.post('/api/register', async (req, res, next) =>
{
  // incoming: firstName, lastName, login, password
  // outgoing: message, id, error
  // status:   201 = created, 400 = missing fields, 409 = login already taken

  // pull four fields form the JSON body
  const { firstName, lastName, login, password } = req.body || {};

  // check if all fields are present, if not return 400 Bad Request
  if( !firstName || !lastName || !login || !password )
  {
    return res.status(400).json({ message:'', id:-1, error:'firstName, lastName, login, and password are required' });
  }


  // try catch so database problem returns an error and not crashing
  try
  {
    // selecting the database 
    const db = client.db('COP4331Cards');
    // shortcut to the users collection
    const users = db.collection('Users');

    // Don't allow two accounts with the same login
    const existing = await users.findOne({ Login:login });
    // if user with the same login already exists, return 409 - Conflict
    if( existing )
    {
      return res.status(409).json({ message:'', id:-1, error:'That username is already taken' });
    }

    // Next UserID = highest current UserID + 1
    // sort users in descending order and take the top one
    const last = await users.find().sort({ UserID:-1 }).limit(1).toArray();
    // new ID = highest existing UserID + 1 (or 1 of no users exist already)
    const newId = (last.length > 0) ? last[0].UserID + 1 : 1;

    // inser the new user documentation into the Users collection
    await users.insertOne({ UserID:newId, FirstName:firstName, LastName:lastName, Login:login, Password:password });

    // return 201 - Create with confimation message into users collection
    return res.status(201).json({ message:'User registered successfully', id:newId, error:'' });
  }
  catch(e)
  {
    // if there is an error return 500 Internal Server Error
    return res.status(500).json({ message:'', id:-1, error:e.toString() });
  }
});


// api/addcard - add a card for a user
app.post('/api/addcard', async (req, res, next) =>
{
  // incoming: userId, card
  // outgoing: error

  // pull userId and card from the JSON body
  const { userId, card } = req.body;

  // create a new card object to store with card name and who added it
  const newCard = {Card:card,UserId:userId};
  // empty string means no error
  var error = '';

  try
  {
    // select the project database
    const db = client.db('COP4331Cards');
    // insert new card into cards collection
    await db.collection('Cards').insertOne(newCard);
  }
  catch(e)
  {
    // save error text so client can see what went wrong
    error = e.toString();

  }

  // build the response object
  var ret = { error: error };
  // send 200 ok with the result as JSON
  res.status(200).json(ret);
});


// api/searchcards - search for cards by name
app.post('/api/searchcards', async (req, res, next) =>
{
  // incoming: userId, search
  // outgoing: results[], error

  // empty string means no error
  var error = '';

  // pull user Id and search the text out of the JSON body
  const { userId, search } = req.body;

  // remove extra space from start and end of search text
  var _search = search.trim();

  // select the project database
  const db = client.db('COP4331Cards');
  
  // query, find every card whos name matches the search text
  //    $regex -> pattern matching for search text ("rob matches Jackie Robinson")
  //    $options:'i' -> case insensitive matching
  const results = await db.collection('Cards').find({"Card":{$regex:_search+'.*', $options:'i'}}).toArray();

  // array that holds just the card names
  var _ret = [];

  // loop over the matching documents
  for( var i=0; i<results.length; i++ )
  {
    // keep only the card field (name) from each document
    _ret.push( results[i].Card );
  }

  // build the response object
  var ret = {results:_ret, error:error};

  // send 200 ok with the result as JSON
  res.status(200).json(ret);
});


// Start the server listening on port 5000
app.listen(5000, () => {
  console.log('Server is running on port 5000');
});