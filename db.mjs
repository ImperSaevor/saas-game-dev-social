import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.SOCIAL_DATA_DIR?.trim() || join(__dirname, 'data');
const dbPath = join(dataRoot, 'social.db');

mkdirSync(dataRoot, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    friend_code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS friendships (
    owner_user_id TEXT NOT NULL,
    friend_user_id TEXT NOT NULL,
    friend_code TEXT NOT NULL,
    nickname TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (owner_user_id, friend_user_id),
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id),
    FOREIGN KEY (friend_user_id) REFERENCES users(user_id)
  );

  CREATE TABLE IF NOT EXISTS presence (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    friend_code TEXT NOT NULL,
    active_project_json TEXT,
    last_seen INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    from_user_id TEXT NOT NULL,
    to_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_user_id, to_user_id),
    FOREIGN KEY (from_user_id) REFERENCES users(user_id),
    FOREIGN KEY (to_user_id) REFERENCES users(user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_users_friend_code ON users(friend_code);
  CREATE INDEX IF NOT EXISTS idx_friendships_owner ON friendships(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);

  CREATE TABLE IF NOT EXISTS social_challenges (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL,
    to_user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    label TEXT NOT NULL,
    target_value INTEGER NOT NULL,
    from_value_at_start INTEGER NOT NULL,
    to_value_at_start INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    winner_user_id TEXT,
    resolved_at INTEGER,
    FOREIGN KEY (from_user_id) REFERENCES users(user_id),
    FOREIGN KEY (to_user_id) REFERENCES users(user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_social_challenges_users ON social_challenges(from_user_id, to_user_id, status);
`);

export function getUserById(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

export function getUserByFriendCode(friendCode) {
  return db.prepare('SELECT * FROM users WHERE friend_code = ?').get(friendCode);
}

export function getUserByTokenHash(tokenHash) {
  return db.prepare('SELECT * FROM users WHERE token_hash = ?').get(tokenHash);
}

export function createUser({ userId, friendCode, displayName, avatarColor, tokenHash, createdAt }) {
  db.prepare(`
    INSERT INTO users (user_id, friend_code, display_name, avatar_color, token_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, friendCode, displayName, avatarColor, tokenHash, createdAt);
}

export function updateUserProfile(userId, displayName, avatarColor) {
  db.prepare(`
    UPDATE users SET display_name = ?, avatar_color = ? WHERE user_id = ?
  `).run(displayName, avatarColor, userId);
}

export function updateUserToken(userId, tokenHash) {
  db.prepare('UPDATE users SET token_hash = ? WHERE user_id = ?').run(tokenHash, userId);
}

export function upsertPresence({ userId, friendCode, displayName, avatarColor, activeProjectJson, lastSeen }) {
  db.prepare(`
    INSERT INTO presence (user_id, friend_code, display_name, avatar_color, active_project_json, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      friend_code = excluded.friend_code,
      display_name = excluded.display_name,
      avatar_color = excluded.avatar_color,
      active_project_json = excluded.active_project_json,
      last_seen = excluded.last_seen
  `).run(userId, friendCode, displayName, avatarColor, activeProjectJson, lastSeen);
}

export function clearPresence(userId) {
  db.prepare('DELETE FROM presence WHERE user_id = ?').run(userId);
}

export function listFriends(ownerUserId) {
  return db.prepare(`
    SELECT
      f.friend_code,
      COALESCE(u.display_name, f.nickname) AS nickname,
      f.added_at
    FROM friendships f
    JOIN users u ON u.user_id = f.friend_user_id
    WHERE f.owner_user_id = ?
    ORDER BY f.added_at ASC
  `).all(ownerUserId);
}

export function addFriendship({ ownerUserId, friendUserId, friendCode, nickname, addedAt }) {
  db.prepare(`
    INSERT INTO friendships (owner_user_id, friend_user_id, friend_code, nickname, added_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(ownerUserId, friendUserId, friendCode, nickname, addedAt);
}

export function removeFriendship(ownerUserId, friendCode) {
  return db.prepare(`
    DELETE FROM friendships WHERE owner_user_id = ? AND friend_code = ?
  `).run(ownerUserId, friendCode);
}

export function hasFriendship(ownerUserId, friendUserId) {
  return !!db.prepare(`
    SELECT 1 FROM friendships
    WHERE owner_user_id = ? AND friend_user_id = ?
  `).get(ownerUserId, friendUserId);
}

export function getFriendRequest(fromUserId, toUserId) {
  return db.prepare(`
    SELECT * FROM friend_requests
    WHERE from_user_id = ? AND to_user_id = ?
  `).get(fromUserId, toUserId);
}

export function createFriendRequest({ fromUserId, toUserId, createdAt }) {
  db.prepare(`
    INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `).run(fromUserId, toUserId, createdAt);
}

export function deleteFriendRequest(fromUserId, toUserId) {
  db.prepare(`
    DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?
  `).run(fromUserId, toUserId);
}

export function declineFriendRequest(fromUserId, toUserId) {
  db.prepare(`
    UPDATE friend_requests SET status = 'declined'
    WHERE from_user_id = ? AND to_user_id = ?
  `).run(fromUserId, toUserId);
}

export function listIncomingRequests(userId) {
  return db.prepare(`
    SELECT u.friend_code, u.display_name, u.avatar_color, r.created_at
    FROM friend_requests r
    JOIN users u ON u.user_id = r.from_user_id
    WHERE r.to_user_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `).all(userId);
}

export function listOutgoingRequests(userId) {
  return db.prepare(`
    SELECT u.friend_code, u.display_name, u.avatar_color, r.created_at
    FROM friend_requests r
    JOIN users u ON u.user_id = r.to_user_id
    WHERE r.from_user_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `).all(userId);
}

export function findActiveSocialChallenge(fromUserId, toUserId, metric) {
  return db.prepare(`
    SELECT * FROM social_challenges
    WHERE status = 'active'
      AND metric = ?
      AND (
        (from_user_id = ? AND to_user_id = ?)
        OR (from_user_id = ? AND to_user_id = ?)
      )
  `).get(metric, fromUserId, toUserId, toUserId, fromUserId);
}

export function createSocialChallenge({
  id,
  fromUserId,
  toUserId,
  metric,
  label,
  targetValue,
  fromValueAtStart,
  toValueAtStart,
  createdAt,
  deadline
}) {
  db.prepare(`
    INSERT INTO social_challenges (
      id, from_user_id, to_user_id, metric, label, target_value,
      from_value_at_start, to_value_at_start, created_at, deadline, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    id,
    fromUserId,
    toUserId,
    metric,
    label,
    targetValue,
    fromValueAtStart,
    toValueAtStart,
    createdAt,
    deadline
  );
}

export function listSocialChallengesForUser(userId) {
  return db.prepare(`
    SELECT
      c.*,
      fu.display_name AS from_display_name,
      fu.friend_code AS from_friend_code,
      tu.display_name AS to_display_name,
      tu.friend_code AS to_friend_code
    FROM social_challenges c
    JOIN users fu ON fu.user_id = c.from_user_id
    JOIN users tu ON tu.user_id = c.to_user_id
    WHERE c.from_user_id = ? OR c.to_user_id = ?
    ORDER BY c.created_at DESC
  `).all(userId, userId);
}

export function getSocialChallengeForUser(id, userId) {
  return db.prepare(`
    SELECT * FROM social_challenges
    WHERE id = ? AND (from_user_id = ? OR to_user_id = ?)
  `).get(id, userId, userId);
}

export function updateSocialChallengeStatus(id, status, winnerUserId, resolvedAt) {
  db.prepare(`
    UPDATE social_challenges
    SET status = ?, winner_user_id = ?, resolved_at = ?
    WHERE id = ?
  `).run(status, winnerUserId ?? null, resolvedAt ?? null, id);
}

export function deleteSocialChallenge(id, userId) {
  return db.prepare(`
    DELETE FROM social_challenges
    WHERE id = ? AND (from_user_id = ? OR to_user_id = ?) AND status = 'active'
  `).run(id, userId, userId);
}

export function getFriendsPresence(ownerUserId) {
  return db.prepare(`
    SELECT
      u.user_id,
      u.friend_code,
      COALESCE(p.display_name, u.display_name) AS display_name,
      COALESCE(p.avatar_color, u.avatar_color) AS avatar_color,
      p.active_project_json,
      COALESCE(p.last_seen, 0) AS last_seen
    FROM friendships f
    JOIN users u ON u.user_id = f.friend_user_id
    LEFT JOIN presence p ON p.user_id = u.user_id
    WHERE f.owner_user_id = ?
  `).all(ownerUserId);
}

export function syncFriendNicknamesForUser(userId, displayName) {
  db.prepare(`
    UPDATE friendships
    SET nickname = ?
    WHERE friend_user_id = ?
  `).run(displayName, userId);
}
