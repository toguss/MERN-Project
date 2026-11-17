// ============================================================================
// server.js - GeoGame API server setup
// Loads settings from .env, connects to MongoDB Atlas, and registers the
// endpoints from api.js. Runs on the droplet under PM2; Nginx forwards
// https://mern.tomasstep.com/api/* to this server.
// ============================================================================
require('dotenv').config({ quiet:true });

const express = require('express');
const cors = require('cors');
const MongoClient = require('mongodb').MongoClient;

// Connect to MongoDB Atlas once at startup; every endpoint reuses this client
const client = new MongoClient(process.env.MONGODB_URI);
client.connect()
  .then(() => console.log('Connected to MongoDB'))
  .catch(e => console.error('MongoDB connection failed:', e.message));

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) =>
{
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  next();
});

// All endpoints live in api.js
const api = require('./api.js');
api.setApp(app, client);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('GeoGame API listening on port ' + PORT));
