const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'No token, authorization denied' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret-dashq');
    
    // Attach user to req
    req.user = decoded; // { sub: userId, role, is_guest, etc }
    
    next();
  } catch (err) {
    console.error('Token verify error:', err.message);
    res.status(401).json({ error: 'Token invalid, access denied' });
  }
};

const adminAuth = (req, res, next) => {
  auth(req, res, async (err) => {
    if (err) return;
    
    const { user } = req;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    next();
  });
};

module.exports = { auth, adminAuth };

