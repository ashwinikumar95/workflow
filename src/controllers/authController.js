const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const config = require("../../config");
const { hashPassword, verifyPassword } = require("../utils/password");
const {
  normalizeEmail,
  normalizeName,
  validateEmailFormat,
  validatePassword,
} = require("../utils/userInput");

function userPublic(userDoc) {
  const u = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
  delete u.password;
  return u;
}

function signToken(userId) {
  return jwt.sign(
    { id: userId.toString(), jti: crypto.randomUUID() },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
}

exports.register = async (req, res) => {
  try {
    const name = normalizeName(req.body.name);
    if (!name) {
      return res.status(400).json({ message: "Name cannot be empty" });
    }

    const email = normalizeEmail(req.body.email);
    const emailCheck = validateEmailFormat(email);
    if (!emailCheck.ok) {
      return res.status(400).json({ message: emailCheck.message });
    }

    const pwCheck = validatePassword(req.body.password);
    if (!pwCheck.ok) {
      return res.status(400).json({ message: pwCheck.message });
    }

    const passwordHash = await hashPassword(req.body.password);
    const user = await User.create({
      name,
      email,
      password: passwordHash,
    });

    const token = signToken(user._id);
    res.status(201).json({
      message: "Registered successfully",
      user: userPublic(user),
      token,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "Email already in use" });
    }
    if (err.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: err.message });
  }
};

exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const emailCheck = validateEmailFormat(email);
    if (!emailCheck.ok) {
      return res.status(400).json({ message: emailCheck.message });
    }

    if (req.body.password == null || typeof req.body.password !== "string") {
      return res.status(400).json({ message: "Password is required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const ok = await verifyPassword(req.body.password, user.password);
    if (!ok) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = signToken(user._id);
    res.json({
      message: "Login successful",
      user: userPublic(user),
      token,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
