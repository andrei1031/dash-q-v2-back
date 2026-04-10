const jwt = require('jsonwebtoken');
const { supabase } = require("../database/supabase");

/**
 * Global Auth Middleware
 * Handles both Guest (JWT) and Registered (Supabase) sessions
 */
const auth = async (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        // 1. Try to verify as a Guest Token first
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = decoded; // { sub, role: 'guest', ... }
            return next();
        } catch (guestErr) {
            // Not a guest token, move to Supabase check
        }

        // 2. Verify as a Supabase Token (Admin/Barber/Customer)
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error('Invalid session');

        // Fetch the profile role to attach to the request
        const { data: profile } = await supabase
            .from('profiles')
            .select('role, is_banned')
            .eq('id', user.id)
            .single();

        if (profile?.is_banned) {
            return res.status(403).json({ error: 'Account suspended.' });
        }

        req.user = { ...user, role: profile?.role || 'customer' };
        next();
    } catch (err) {
        res.status(401).json({ error: 'Authentication failed' });
    }
};

/**
 * Admin-Only Middleware
 */
const adminAuth = (req, res, next) => {
    // We call the standard auth first
    auth(req, res, () => {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
};

module.exports = { auth, adminAuth };