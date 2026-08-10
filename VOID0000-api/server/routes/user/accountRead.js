import express from 'express';
import { pool as db } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = express.Router();

// GET /api/users/account - Get current user's account info
router.get('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT
         u.id,
         u.email,
         u.username,
         u.profile_id,
         u.created_at,
         up.display_name,
         up.avatar_filename
       FROM users u
       LEFT JOIN user_profiles up ON up.id = u.profile_id
       WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { avatar_filename: avatarFilename, ...account } = result.rows[0];
    account.avatar_url = resolveUserAvatarUrl(avatarFilename);

    res.json({
      success: true,
      account,
    });
  } catch (err) {
    console.error('AccountRead GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
