import jwt from 'jsonwebtoken';

// Fail fast and loudly at startup rather than throwing a cryptic error
// on the first login attempt if this is missing.
if (!process.env.JWT_SECRET || !process.env.JWT_SECRET.trim()) {
  throw new Error(
    'FATAL: JWT_SECRET environment variable is not set. Refusing to start.'
  );
}

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Generate JWT token
 * payload: { userId, sid } - sid is the session id used to match this
 * token back to its LoginHistory row on logout.
 */
export const generateToken = ({ userId, sid }) => {
  return jwt.sign(
    { userId, sid },
    process.env.JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
    }
  );
};

/**
 * Verify JWT token
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(
      token,
      process.env.JWT_SECRET
    );
  } catch (err) {
    return null;
  }
};
