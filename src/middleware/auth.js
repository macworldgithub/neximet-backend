const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { jwtSecret } = require('../services/authSecret');
const { protectPayroll } = require('../services/payrollPrivacy');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }


  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized to access this route' });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret());
    req.user = await User.findById(decoded.id);

    if (!req.user || !req.user.isActive) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }

    protectPayroll(req, res);
    next();
  } catch (err) {
    if (err.status === 503) return res.status(503).json({ success: false, message: err.message });
    return res.status(401).json({ success: false, message: 'Token invalid or expired' });
  }
};

module.exports = { protect };
