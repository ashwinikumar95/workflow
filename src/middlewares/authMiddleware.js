const jwt = require('jsonwebtoken');
const config = require('../../config');
const RevokedToken = require('../models/RevokedToken');
const { parseBearerToken } = require('../utils/authToken');

module.exports = async (req, res, next) => {
  try {
    const raw = req.header('Authorization');
    const token = parseBearerToken(raw);

    if (!token) {
      return res.status(401).json({ message: 'No token' });
    }

    const decoded = jwt.verify(token, config.jwtSecret);

    if (decoded.jti) {
      const revoked = await RevokedToken.findOne({ jti: decoded.jti }).lean();
      if (revoked) {
        return res.status(401).json({ message: 'Token revoked' });
      }
    }

    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};