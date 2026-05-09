const User = require("../models/User");
const {
  normalizeEmail,
  normalizeName,
  validateEmailFormat,
} = require("../utils/userInput");

exports.profile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) {
      const name = normalizeName(req.body.name);
      if (!name) {
        return res.status(400).json({ message: "Name cannot be empty" });
      }
      updates.name = name;
    }
    if (req.body.email !== undefined) {
      const email = normalizeEmail(req.body.email);
      const emailCheck = validateEmailFormat(email);
      if (!emailCheck.ok) {
        return res.status(400).json({ message: emailCheck.message });
      }
      updates.email = email;
    }

    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ message: "Provide at least one of: name, email" });
    }

    const user = await User.findByIdAndUpdate(req.user.id, updates, {
      returnDocument: "after",
      runValidators: true
    }).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "User updated successfully", user });
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