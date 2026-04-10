// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { supabase } = require("../database/supabase");

const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    // 1. TRY GUEST TOKEN FIRST (Signed by your local secret)
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET); // REMOVED FALLBACK
      req.user = decoded;
      return next();
    } catch (guestErr) {
      // If not a guest token, proceed to check Supabase
    }

    // 2. TRY SUPABASE TOKEN (For registered Admins/Barbers)
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new Error('Invalid Supabase token');

    // Fetch the role from the profiles table to attach to req.user
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    
    req.user = { ...user, role: profile?.role || 'customer' };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Authentication failed' });
  }
};